import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Attachment, InboundMessage } from '@textagent/core';
import { decodeAttributedBody } from './attributed-body.ts';

export const DEFAULT_CHAT_DB = join(homedir(), 'Library', 'Messages', 'chat.db');

/** Seconds between the Unix epoch and Apple's (2001-01-01). */
const APPLE_EPOCH_OFFSET_S = 978_307_200;
/** chat.style for group chats; 45 is one-to-one. */
const CHAT_STYLE_GROUP = 43;
/** Link previews are ordinary text messages that happen to have a balloon. */
const URL_BALLOON = 'com.apple.messages.URLBalloonProvider';

export type SkipReason = 'from-me' | 'reaction' | 'system' | 'app' | 'empty' | 'no-chat';

export interface ReadResult {
  messages: InboundMessage[];
  skipped: Array<{ rowid: number; reason: SkipReason }>;
  /** Highest ROWID fully handled. Persist it and pass it to the next read(). */
  cursor: number;
}

export interface IMessageRaw {
  rowid: number;
  service: string | null;
  chatIdentifier: string | null;
  chatName: string | null;
}

export class FullDiskAccessError extends Error {
  constructor(path: string, options?: ErrorOptions) {
    super(
      `Can't read ${path}. Give the app running this process Full Disk Access ` +
        '(System Settings → Privacy & Security → Full Disk Access: add your terminal, IDE or node), ' +
        'then restart it.',
      options,
    );
    this.name = 'FullDiskAccessError';
  }
}

interface Row {
  rowid: number;
  guid: string;
  text: string | null;
  attributedBody: Uint8Array | null;
  is_from_me: number;
  date_ms: number | null;
  service: string | null;
  associated_message_type: number | null;
  item_type: number | null;
  balloon_bundle_id: string | null;
  cache_has_attachments: number | null;
  sender: string | null;
  chat_guid: string | null;
  chat_identifier: string | null;
  chat_name: string | null;
  chat_style: number | null;
}

interface AttachmentRow {
  message_id: number;
  filename: string | null;
  mime_type: string | null;
  transfer_name: string | null;
}

/** Columns that exist on current macOS but not on every version we might meet. */
const OPTIONAL_MESSAGE_COLUMNS = ['associated_message_type', 'item_type', 'balloon_bundle_id', 'cache_has_attachments'];

/**
 * Reads new messages from the Messages database, read-only.
 * Polling and the cursor's persistence are the caller's job; this class is stateless
 * apart from tracking messages whose chat link hasn't been written yet.
 */
export class ChatDbReader {
  readonly #db: DatabaseSync;
  readonly #select: string;
  readonly #maxOrphanReads: number;
  /** rowid → how many reads it has been missing its chat link. */
  readonly #orphans = new Map<number, number>();

  constructor(path = DEFAULT_CHAT_DB, options: { maxOrphanReads?: number } = {}) {
    this.#maxOrphanReads = options.maxOrphanReads ?? 10;
    this.#db = openReadOnly(path);

    const columns = new Set(
      (this.#db.prepare('PRAGMA table_info(message)').all() as Array<{ name: string }>).map((c) => c.name),
    );
    const col = (name: string) => (columns.has(name) ? `m.${name}` : `NULL AS ${name}`);

    // LEFT JOIN on purpose: Messages can commit the message row slightly before its
    // chat link, and an inner join would let the cursor skip past it forever.
    this.#select = `
      SELECT m.ROWID AS rowid, m.guid, m.text, m.attributedBody, m.is_from_me, m.service,
             -- Nanosecond dates overflow JS numbers, so convert to ms in SQL. Pre-High Sierra stored seconds.
             CASE WHEN m.date > 100000000000 THEN m.date / 1000000 ELSE m.date * 1000 END AS date_ms,
             ${OPTIONAL_MESSAGE_COLUMNS.map(col).join(', ')},
             h.id AS sender, c.guid AS chat_guid, c.chat_identifier, c.display_name AS chat_name, c.style AS chat_style
      FROM message m
      LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN chat c ON c.ROWID = cmj.chat_id
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.ROWID > ?
      ORDER BY m.ROWID ASC
      LIMIT ?`;
  }

  /** Where a fresh install should start: after everything already in the database. */
  latestRowId(): number {
    const row = this.#db.prepare('SELECT MAX(ROWID) AS max FROM message').get() as { max: number | null };
    return row.max ?? 0;
  }

  read(cursor: number, limit = 200): ReadResult {
    const rows = this.#db.prepare(this.#select).all(cursor, limit) as unknown as Row[];
    const attachments = this.#attachmentsFor(rows.filter((r) => r.cache_has_attachments).map((r) => r.rowid));
    const result: ReadResult = { messages: [], skipped: [], cursor };

    for (const row of rows) {
      if (!row.chat_guid) {
        const reads = (this.#orphans.get(row.rowid) ?? 0) + 1;
        if (reads < this.#maxOrphanReads) {
          // Stop here and retry from this row next time, so nothing after it is delivered out of order.
          this.#orphans.set(row.rowid, reads);
          break;
        }
        this.#orphans.delete(row.rowid);
        result.skipped.push({ rowid: row.rowid, reason: 'no-chat' });
        result.cursor = row.rowid;
        continue;
      }
      this.#orphans.delete(row.rowid);
      result.cursor = row.rowid;

      const reason = skipReason(row);
      if (reason) {
        result.skipped.push({ rowid: row.rowid, reason });
        continue;
      }

      const files = attachments.get(row.rowid) ?? [];
      // U+FFFC marks where an attachment sat inline; it's noise once attachments are separate.
      const text = (row.text ?? decodeAttributedBody(row.attributedBody) ?? '').replaceAll('￼', '').trim();
      if (!text && files.length === 0) {
        result.skipped.push({ rowid: row.rowid, reason: 'empty' });
        continue;
      }

      const raw: IMessageRaw = {
        rowid: row.rowid,
        service: row.service,
        chatIdentifier: row.chat_identifier,
        chatName: row.chat_name || null,
      };
      result.messages.push({
        id: row.guid,
        channel: 'imessage',
        thread: {
          id: row.chat_guid,
          channel: 'imessage',
          isGroup: row.chat_style === CHAT_STYLE_GROUP || row.chat_guid.includes(';+;'),
        },
        sender: { id: row.sender ?? row.chat_identifier ?? 'unknown' },
        text,
        attachments: files,
        timestamp: appleDate(row.date_ms),
        raw,
      });
    }
    return result;
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }

  #attachmentsFor(rowids: number[]): Map<number, Attachment[]> {
    const byMessage = new Map<number, Attachment[]>();
    if (rowids.length === 0) return byMessage;
    const rows = this.#db
      .prepare(
        `SELECT maj.message_id, a.filename, a.mime_type, a.transfer_name
         FROM message_attachment_join maj JOIN attachment a ON a.ROWID = maj.attachment_id
         WHERE maj.message_id IN (${rowids.map(() => '?').join(',')})`,
      )
      .all(...rowids) as unknown as AttachmentRow[];
    for (const r of rows) {
      const list = byMessage.get(r.message_id) ?? [];
      list.push({
        kind: attachmentKind(r.mime_type),
        ...(r.mime_type && { mimeType: r.mime_type }),
        ...(r.transfer_name && { filename: r.transfer_name }),
        ...(r.filename && { uri: r.filename.replace(/^~(?=\/)/, homedir()) }),
      });
      byMessage.set(r.message_id, list);
    }
    return byMessage;
  }
}

function skipReason(row: Row): SkipReason | undefined {
  if (row.is_from_me) return 'from-me';
  // 2000–2007 add a tapback, 3000–3007 remove one, 1000 is a sticker placed on a message.
  if (row.associated_message_type) return 'reaction';
  // Renames, member changes, group photo changes.
  if (row.item_type) return 'system';
  if (row.balloon_bundle_id && row.balloon_bundle_id !== URL_BALLOON) return 'app';
  return undefined;
}

function openReadOnly(path: string): DatabaseSync {
  try {
    statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`No Messages database at ${path}. Is Messages set up and signed in on this Mac?`, {
        cause: error,
      });
    }
    throw new FullDiskAccessError(path, { cause: error });
  }
  try {
    // Without Full Disk Access, stat() still works but listing the folder doesn't.
    readdirSync(dirname(path));
    return new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || /unable to open/i.test(String((error as Error).message))) {
      throw new FullDiskAccessError(path, { cause: error });
    }
    throw error;
  }
}

/** Milliseconds since Apple's epoch (2001-01-01) to a Date. */
export function appleDate(ms: number | null): Date {
  return new Date(ms === null ? 0 : ms + APPLE_EPOCH_OFFSET_S * 1000);
}

function attachmentKind(mime: string | null): Attachment['kind'] {
  if (mime?.startsWith('image/')) return 'image';
  if (mime?.startsWith('audio/')) return 'audio';
  if (mime?.startsWith('video/')) return 'video';
  return 'file';
}
