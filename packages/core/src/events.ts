import type { TurnTrace } from './trace.ts';
import type { InboundMessage, SentMessage } from './types.ts';

/**
 * Everything observable about an agent. Subscribe with `agent.on('event', ...)`
 * to log, trace or ship metrics; this is the hook the observability suite builds on.
 */
export type AgentEvent =
  | { type: 'channel.started'; channel: string }
  | { type: 'channel.stopped'; channel: string }
  | { type: 'channel.error'; channel: string; error: unknown }
  | { type: 'message.received'; message: InboundMessage }
  | { type: 'message.duplicate'; message: InboundMessage }
  | { type: 'message.filtered'; message: InboundMessage; reason: 'group' | 'not-allowed' | 'allow-error' }
  | { type: 'handler.started'; conversation: string; messageIds: string[] }
  | { type: 'handler.finished'; conversation: string; durationMs: number }
  | { type: 'handler.error'; conversation: string; error: unknown; durationMs: number }
  | { type: 'message.sent'; message: SentMessage; text: string; part: number; parts: number; proactive?: true }
  | { type: 'store.error'; operation: string; error: unknown }
  | {
      type: 'schedule.created' | 'schedule.sent' | 'schedule.failed' | 'schedule.expired' | 'schedule.retrying';
      job: ScheduledJobSummary;
      error?: string;
    }
  | { type: 'schedule.canceled'; by: { id: string } | { key: string } }
  | { type: 'turn.completed'; trace: TurnTrace };

/** What events carry about a scheduled message (never the text, which may be private). */
export interface ScheduledJobSummary {
  id: string;
  key?: string;
  conversation: string;
  at: Date;
}

export type TimedAgentEvent = AgentEvent & { at: Date };
