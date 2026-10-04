import type { JobFilter, JobRecord, Store } from './store.ts';

/** What the agent decides after trying a due job. The scheduler records it. */
export type JobOutcome =
  { status: 'sent' } | { status: 'failed' | 'expired'; error: string } | { status: 'retry'; at: Date; error: string };

/** Runs one due job; supplied by the agent when it starts the scheduler. */
export type JobRunner = (job: JobRecord) => Promise<JobOutcome>;

/**
 * Timing and persistence for scheduled messages. The agent owns the policy (validation,
 * limits, lateness, retries); a scheduler only stores jobs and runs them when due.
 * Implement this to back scheduling with a queue (BullMQ, SQS, ...) instead of the store.
 */
export interface Scheduler {
  start(run: JobRunner): Promise<void>;
  /** Stop timing and wait for jobs being run right now. */
  stop(): Promise<void>;
  add(job: JobRecord): Promise<void>;
  cancel(by: { id: string } | { key: string }): Promise<boolean>;
  list(filter?: JobFilter): Promise<JobRecord[]>;
}

export interface StoreSchedulerOptions {
  /** Safety re-check interval, in case a timer was missed. Default: 60000. */
  pollIntervalMs?: number;
  /** A job claimed longer ago than this, still "sending" at startup, crashed mid-send. Default: 5 minutes. */
  staleClaimMs?: number;
}

/** Node timers overflow past ~24.8 days; longer waits are covered by re-arming. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const CLAIM_BATCH = 20;

/** The default scheduler: jobs live in the agent's Store, so SqliteStore keeps them across restarts. */
export class StoreScheduler implements Scheduler {
  readonly #store: Store;
  readonly #pollMs: number;
  readonly #staleClaimMs: number;
  #run: JobRunner | undefined;
  #timer: NodeJS.Timeout | undefined;
  /** Ticks never overlap. */
  #ticking: Promise<void> = Promise.resolve();
  #running = false;

  constructor(store: Store, options: StoreSchedulerOptions = {}) {
    this.#store = store;
    this.#pollMs = options.pollIntervalMs ?? 60_000;
    this.#staleClaimMs = options.staleClaimMs ?? 5 * 60_000;
  }

  async start(run: JobRunner): Promise<void> {
    this.#run = run;
    this.#running = true;
    await this.#recoverCrashedSends();
    this.#tick();
  }

  async stop(): Promise<void> {
    this.#running = false;
    clearTimeout(this.#timer);
    await this.#ticking;
  }

  async add(job: JobRecord): Promise<void> {
    await this.#store.addJob(job);
    if (this.#running) this.#tick();
  }

  async cancel(by: { id: string } | { key: string }): Promise<boolean> {
    return this.#store.cancelJob(by);
  }

  async list(filter?: JobFilter): Promise<JobRecord[]> {
    return this.#store.listJobs(filter);
  }

  /**
   * At most once: a job left "sending" by a crash may or may not have gone out,
   * and a duplicate reminder is worse than a missing one, so it becomes "unknown".
   */
  async #recoverCrashedSends(): Promise<void> {
    const cutoff = Date.now() - this.#staleClaimMs;
    for (const job of await this.#store.listJobs({ status: 'sending' })) {
      if ((job.claimedAt?.getTime() ?? 0) < cutoff) {
        await this.#store.updateJob(job.id, { status: 'unknown', error: 'Interrupted while sending; not retried' });
      }
    }
  }

  #tick(): void {
    clearTimeout(this.#timer);
    this.#ticking = this.#ticking.then(() => this.#runDue()).catch(() => {});
  }

  async #runDue(): Promise<void> {
    if (!this.#running || !this.#run) return;
    for (;;) {
      const due = await this.#store.claimDueJobs(new Date(), CLAIM_BATCH);
      for (const job of due) {
        const outcome = await this.#run(job).catch((error: unknown): JobOutcome => ({
          status: 'failed',
          error: (error as Error).message,
        }));
        if (outcome.status === 'retry') {
          await this.#store.updateJob(job.id, {
            status: 'pending',
            at: outcome.at,
            attempts: job.attempts + 1,
            error: outcome.error,
          });
        } else {
          await this.#store.updateJob(job.id, {
            status: outcome.status,
            attempts: job.attempts + 1,
            ...('error' in outcome && { error: outcome.error }),
          });
        }
      }
      if (due.length < CLAIM_BATCH || !this.#running) break;
    }
    await this.#arm();
  }

  async #arm(): Promise<void> {
    if (!this.#running) return;
    const [next] = await this.#store.listJobs({ status: 'pending', limit: 1 });
    if (!this.#running) return; // stopped while we were looking
    const untilNext = next ? Math.max(0, next.at.getTime() - Date.now()) : this.#pollMs;
    this.#timer = setTimeout(() => this.#tick(), Math.min(untilNext, this.#pollMs, MAX_TIMER_MS));
  }
}
