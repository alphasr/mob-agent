import { DatabaseSync } from 'node:sqlite';

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
  close(): Promise<void>;
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
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
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

  async close() {
    if (this.#db.isOpen) this.#db.close();
  }
}
