import { DatabaseSync } from 'node:sqlite';
import type { TurnTrace } from './trace.ts';

export interface HistoryEntry {
  channel: string;
  threadId: string;
  messageId: string;
  role: 'user' | 'agent';
  /** Who sent it; undefined for the agent's own messages. */
  senderId?: string;
  text: string;
  timestamp: Date;
}

export type JobStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'expired' | 'canceled' | 'unknown';

/** A scheduled message as stored. `request` is the serialized send request. */
export interface JobRecord {
  id: string;
  /** Caller's name for the job; scheduling the same key again replaces the pending one. */
  key?: string;
  /** Which conversation it belongs to, for listing and per-conversation limits. */
  conversation: string;
  at: Date;
  request: string;
  status: JobStatus;
  attempts: number;
  error?: string;
  createdAt: Date;
  /** When a scheduler claimed it for sending. */
  claimedAt?: Date;
}

export interface JobFilter {
  conversation?: string;
  status?: JobStatus;
  limit?: number;
}

/**
 * Persistence for the agent and its channels. Methods are async so a hosted
 * deployment can back this with Postgres/Redis without changing callers.
 */
export interface Store {
  /** Atomically record a message id; true if it was new, false if already seen. */
  markSeen(channel: string, messageId: string): Promise<boolean>;
  /** Channel-scoped key/value, e.g. iMessage's last ROWID or Telegram's update offset. */
  getState(channel: string, key: string): Promise<string | undefined>;
  setState(channel: string, key: string, value: string): Promise<void>;
  appendHistory(entry: HistoryEntry): Promise<void>;
  /** The latest `limit` entries for a thread, oldest first. */
  getHistory(channel: string, threadId: string, limit: number): Promise<HistoryEntry[]>;
  /** Insert a pending job. A pending job with the same key is canceled in the same step. */
  addJob(job: JobRecord): Promise<void>;
  /** Atomically mark due pending jobs as sending and return them, so concurrent schedulers never both send one. */
  claimDueJobs(now: Date, limit: number): Promise<JobRecord[]>;
  updateJob(id: string, update: Partial<Pick<JobRecord, 'status' | 'error' | 'at' | 'attempts'>>): Promise<void>;
  /** Cancel a pending job; false if there was none (already sent, unknown id, ...). */
  cancelJob(by: { id: string } | { key: string }): Promise<boolean>;
  /** Jobs ordered by `at`. */
  listJobs(filter?: JobFilter): Promise<JobRecord[]>;
  addTrace(trace: TurnTrace): Promise<void>;
  /** Newest first. */
  listTraces(filter?: TraceFilter): Promise<TurnTrace[]>;
  /** Delete traces older than `before`, then keep at most `keep` newest. Returns how many were deleted. */
  pruneTraces(before: Date, keep: number): Promise<number>;
  close(): Promise<void>;
}

export interface TraceFilter {
  conversation?: string;
  since?: Date;
  limit?: number;
}

/** How long a message id is remembered for dedupe. Webhook retries arrive within minutes; a week is generous. */
const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class MemoryStore implements Store {
  readonly #seen = new Map<string, number>();
  readonly #state = new Map<string, string>();
  readonly #history = new Map<string, HistoryEntry[]>();

  async markSeen(channel: string, messageId: string): Promise<boolean> {
    const key = `${channel}\u0000${messageId}`;
    if (this.#seen.has(key)) return false;
    this.#seen.set(key, Date.now());
    if (this.#seen.size % 1000 === 0) this.#pruneSeen();
    return true;
  }

  async getState(channel: string, key: string) {
    return this.#state.get(`${channel}\u0000${key}`);
  }

  async setState(channel: string, key: string, value: string) {
    this.#state.set(`${channel}\u0000${key}`, value);
  }

  async appendHistory(entry: HistoryEntry) {
    const key = `${entry.channel}\u0000${entry.threadId}`;
    const list = this.#history.get(key) ?? [];
    list.push({ ...entry });
    this.#history.set(key, list);
  }

  async getHistory(channel: string, threadId: string, limit: number) {
    if (limit <= 0) return [];
    return (this.#history.get(`${channel}\u0000${threadId}`) ?? []).slice(-limit).map((e) => ({ ...e }));
  }

  readonly #jobs = new Map<string, JobRecord>();

  async addJob(job: JobRecord) {
    if (job.key) {
      for (const j of this.#jobs.values()) if (j.key === job.key && j.status === 'pending') j.status = 'canceled';
    }
    this.#jobs.set(job.id, { ...job });
  }

  async claimDueJobs(now: Date, limit: number) {
    const due = [...this.#jobs.values()]
      .filter((j) => j.status === 'pending' && j.at <= now)
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .slice(0, limit);
    for (const j of due) Object.assign(j, { status: 'sending', claimedAt: now });
    return due.map((j) => ({ ...j }));
  }

  async updateJob(id: string, update: Partial<Pick<JobRecord, 'status' | 'error' | 'at' | 'attempts'>>) {
    const job = this.#jobs.get(id);
    if (job) Object.assign(job, update);
  }

  async cancelJob(by: { id: string } | { key: string }) {
    const job = [...this.#jobs.values()].find(
      (j) => j.status === 'pending' && ('id' in by ? j.id === by.id : j.key === by.key),
    );
    if (!job) return false;
    job.status = 'canceled';
    return true;
  }

  async listJobs(filter: JobFilter = {}) {
    return [...this.#jobs.values()]
      .filter((j) => (!filter.conversation || j.conversation === filter.conversation) && (!filter.status || j.status === filter.status))
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .slice(0, filter.limit ?? Infinity)
      .map((j) => ({ ...j }));
  }

  readonly #traces: TurnTrace[] = [];

  async addTrace(trace: TurnTrace) {
    this.#traces.push(structuredClone(trace));
  }

  async listTraces(filter: TraceFilter = {}) {
    return this.#traces
      .filter((t) => (!filter.conversation || t.conversation === filter.conversation) && (!filter.since || t.startedAt >= filter.since))
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, filter.limit ?? Infinity)
      .map((t) => structuredClone(t));
  }

  async pruneTraces(before: Date, keep: number) {
    const sorted = [...this.#traces].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    const kept = sorted.filter((t) => t.startedAt >= before).slice(0, keep);
    const deleted = this.#traces.length - kept.length;
    this.#traces.splice(0, this.#traces.length, ...kept);
    return deleted;
  }

  async close() {}

  #pruneSeen() {
    const cutoff = Date.now() - SEEN_TTL_MS;
    for (const [key, at] of this.#seen) if (at < cutoff) this.#seen.delete(key);
  }
}

export class SqliteStore implements Store {
  readonly #db: DatabaseSync;
  #inserts = 0;

  /** @param path a file path, or ':memory:' */
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    // busy_timeout first: switching to WAL needs a brief lock, and another process
    // (a second agent, or a dev reload overlapping the old one) may hold it.
    this.#db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS seen (
        channel    TEXT NOT NULL,
        message_id TEXT NOT NULL,
        seen_at    INTEGER NOT NULL,
        PRIMARY KEY (channel, message_id)
      );
      CREATE INDEX IF NOT EXISTS seen_at_idx ON seen (seen_at);
      CREATE TABLE IF NOT EXISTS state (
        channel TEXT NOT NULL,
        key     TEXT NOT NULL,
        value   TEXT NOT NULL,
        PRIMARY KEY (channel, key)
      );
      CREATE TABLE IF NOT EXISTS history (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        channel    TEXT NOT NULL,
        thread_id  TEXT NOT NULL,
        message_id TEXT NOT NULL,
        role       TEXT NOT NULL CHECK (role IN ('user', 'agent')),
        sender_id  TEXT,
        text       TEXT NOT NULL,
        ts         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS history_thread_idx ON history (channel, thread_id, id);
      CREATE TABLE IF NOT EXISTS jobs (
        id           TEXT PRIMARY KEY,
        key          TEXT,
        conversation TEXT NOT NULL,
        at           INTEGER NOT NULL,
        request      TEXT NOT NULL,
        status       TEXT NOT NULL,
        attempts     INTEGER NOT NULL DEFAULT 0,
        error        TEXT,
        created_at   INTEGER NOT NULL,
        claimed_at   INTEGER
      );
      CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs (status, at);
      CREATE INDEX IF NOT EXISTS jobs_conversation_idx ON jobs (conversation, at);
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_pending_key_idx ON jobs (key) WHERE status = 'pending' AND key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS traces (
        id           TEXT PRIMARY KEY,
        conversation TEXT NOT NULL,
        started_at   INTEGER NOT NULL,
        data         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS traces_started_idx ON traces (started_at);
      CREATE INDEX IF NOT EXISTS traces_conversation_idx ON traces (conversation, started_at);
    `);
  }

  async markSeen(channel: string, messageId: string): Promise<boolean> {
    const { changes } = this.#db
      .prepare('INSERT OR IGNORE INTO seen (channel, message_id, seen_at) VALUES (?, ?, ?)')
      .run(channel, messageId, Date.now());
    if (changes > 0 && ++this.#inserts % 1000 === 0) {
      this.#db.prepare('DELETE FROM seen WHERE seen_at < ?').run(Date.now() - SEEN_TTL_MS);
    }
    return changes > 0;
  }

  async getState(channel: string, key: string) {
    const row = this.#db.prepare('SELECT value FROM state WHERE channel = ? AND key = ?').get(channel, key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  async setState(channel: string, key: string, value: string) {
    this.#db
      .prepare(
        'INSERT INTO state (channel, key, value) VALUES (?, ?, ?) ON CONFLICT (channel, key) DO UPDATE SET value = excluded.value',
      )
      .run(channel, key, value);
  }

  async appendHistory(entry: HistoryEntry) {
    this.#db
      .prepare(
        'INSERT INTO history (channel, thread_id, message_id, role, sender_id, text, ts) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        entry.channel,
        entry.threadId,
        entry.messageId,
        entry.role,
        entry.senderId ?? null,
        entry.text,
        entry.timestamp.getTime(),
      );
  }

  async getHistory(channel: string, threadId: string, limit: number): Promise<HistoryEntry[]> {
    if (limit <= 0) return [];
    const rows = this.#db
      .prepare(
        `SELECT * FROM (
           SELECT id, message_id, role, sender_id, text, ts FROM history
           WHERE channel = ? AND thread_id = ? ORDER BY id DESC LIMIT ?
         ) ORDER BY id ASC`,
      )
      .all(channel, threadId, limit) as Array<{
      message_id: string;
      role: 'user' | 'agent';
      sender_id: string | null;
      text: string;
      ts: number;
    }>;
    return rows.map((r) => ({
      channel,
      threadId,
      messageId: r.message_id,
      role: r.role,
      ...(r.sender_id !== null && { senderId: r.sender_id }),
      text: r.text,
      timestamp: new Date(r.ts),
    }));
  }

  async addJob(job: JobRecord) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (job.key) {
        this.#db.prepare("UPDATE jobs SET status = 'canceled' WHERE key = ? AND status = 'pending'").run(job.key);
      }
      this.#db
        .prepare(
          `INSERT INTO jobs (id, key, conversation, at, request, status, attempts, error, created_at, claimed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          job.id,
          job.key ?? null,
          job.conversation,
          job.at.getTime(),
          job.request,
          job.status,
          job.attempts,
          job.error ?? null,
          job.createdAt.getTime(),
          job.claimedAt?.getTime() ?? null,
        );
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async claimDueJobs(now: Date, limit: number) {
    // One statement, so two processes sharing the database can never claim the same job.
    const rows = this.#db
      .prepare(
        `UPDATE jobs SET status = 'sending', claimed_at = ?
         WHERE status = 'pending' AND id IN (
           SELECT id FROM jobs WHERE status = 'pending' AND at <= ? ORDER BY at LIMIT ?
         )
         RETURNING *`,
      )
      .all(now.getTime(), now.getTime(), limit) as unknown as JobRow[];
    return rows.map(jobFromRow).sort((a, b) => a.at.getTime() - b.at.getTime());
  }

  async updateJob(id: string, update: Partial<Pick<JobRecord, 'status' | 'error' | 'at' | 'attempts'>>) {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const set = (column: string, value: string | number | null) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (update.status !== undefined) set('status', update.status);
    if ('error' in update) set('error', update.error ?? null);
    if (update.at !== undefined) set('at', update.at.getTime());
    if (update.attempts !== undefined) set('attempts', update.attempts);
    if (sets.length === 0) return;
    this.#db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }

  async cancelJob(by: { id: string } | { key: string }) {
    const column = 'id' in by ? 'id' : 'key';
    const { changes } = this.#db
      .prepare(`UPDATE jobs SET status = 'canceled' WHERE ${column} = ? AND status = 'pending'`)
      .run('id' in by ? by.id : by.key);
    return changes > 0;
  }

  async listJobs(filter: JobFilter = {}) {
    const where: string[] = [];
    const values: Array<string | number> = [];
    if (filter.conversation) {
      where.push('conversation = ?');
      values.push(filter.conversation);
    }
    if (filter.status) {
      where.push('status = ?');
      values.push(filter.status);
    }
    const rows = this.#db
      .prepare(
        `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at LIMIT ?`,
      )
      .all(...values, filter.limit ?? -1) as unknown as JobRow[];
    return rows.map(jobFromRow);
  }

  async addTrace(trace: TurnTrace) {
    this.#db
      .prepare('INSERT OR REPLACE INTO traces (id, conversation, started_at, data) VALUES (?, ?, ?, ?)')
      .run(trace.id, trace.conversation, trace.startedAt.getTime(), JSON.stringify(trace));
  }

  async listTraces(filter: TraceFilter = {}) {
    const where: string[] = [];
    const values: Array<string | number> = [];
    if (filter.conversation) {
      where.push('conversation = ?');
      values.push(filter.conversation);
    }
    if (filter.since) {
      where.push('started_at >= ?');
      values.push(filter.since.getTime());
    }
    const rows = this.#db
      .prepare(`SELECT data FROM traces ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ?`)
      .all(...values, filter.limit ?? -1) as Array<{ data: string }>;
    return rows.map((r) => {
      const trace = JSON.parse(r.data) as TurnTrace; // written by addTrace from a TurnTrace
      return { ...trace, startedAt: new Date(trace.startedAt) };
    });
  }

  async pruneTraces(before: Date, keep: number) {
    const old = this.#db.prepare('DELETE FROM traces WHERE started_at < ?').run(before.getTime()).changes;
    const excess = this.#db
      .prepare('DELETE FROM traces WHERE id NOT IN (SELECT id FROM traces ORDER BY started_at DESC LIMIT ?)')
      .run(keep).changes;
    return Number(old) + Number(excess);
  }

  async close() {
    if (this.#db.isOpen) this.#db.close();
  }
}

interface JobRow {
  id: string;
  key: string | null;
  conversation: string;
  at: number;
  request: string;
  status: JobStatus;
  attempts: number;
  error: string | null;
  created_at: number;
  claimed_at: number | null;
}

function jobFromRow(r: JobRow): JobRecord {
  return {
    id: r.id,
    ...(r.key !== null && { key: r.key }),
    conversation: r.conversation,
    at: new Date(r.at),
    request: r.request,
    status: r.status,
    attempts: r.attempts,
    ...(r.error !== null && { error: r.error }),
    createdAt: new Date(r.created_at),
    ...(r.claimed_at !== null && { claimedAt: new Date(r.claimed_at) }),
  };
}
