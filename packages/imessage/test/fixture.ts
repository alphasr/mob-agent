import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Same tables/columns the reader touches, as they exist on macOS 14–27. */
const SCHEMA = `
  CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, service TEXT NOT NULL);
  CREATE TABLE chat (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER,
    chat_identifier TEXT, service_name TEXT, display_name TEXT
  );
  CREATE TABLE message (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, attributedBody BLOB,
    handle_id INTEGER DEFAULT 0, service TEXT, date INTEGER, is_from_me INTEGER DEFAULT 0,
    item_type INTEGER DEFAULT 0, associated_message_type INTEGER DEFAULT 0,
    balloon_bundle_id TEXT, cache_has_attachments INTEGER DEFAULT 0
  );
  CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, PRIMARY KEY (chat_id, message_id));
  CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT, mime_type TEXT, transfer_name TEXT);
  CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
`;

/** 2026-10-04T12:00:00Z as Apple nanoseconds: big enough to overflow a JS number, like the real thing. */
export const APPLE_NS_NOON = (BigInt(Date.UTC(2026, 9, 4, 12)) - 978_307_200_000n) * 1_000_000n;

/** An attributedBody blob laid out the way Messages writes it. */
export function attributedBody(text: string): Uint8Array {
  const utf8 = Buffer.from(text, 'utf8');
  let length: Buffer;
  if (utf8.length < 0x80) {
    length = Buffer.from([utf8.length]);
  } else {
    length = Buffer.alloc(3);
    length[0] = 0x81;
    length.writeUInt16LE(utf8.length, 1);
  }
  return Buffer.concat([
    Buffer.from([0x04, 0x0b]),
    Buffer.from('streamtyped'),
    Buffer.from([0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84]),
    Buffer.from('\x19NSMutableAttributedString\x00\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x0fNSMutableString\x01\x84\x84\x08'),
    Buffer.from('NSString'),
    Buffer.from([0x01, 0x95, 0x84, 0x01, 0x2b]),
    length,
    utf8,
    Buffer.from([0x86, 0x84, 0x02, 0x69, 0x49, 0x01]),
  ]);
}

interface MessageInput {
  text?: string | null;
  body?: string;
  from?: string;
  chat?: string;
  fromMe?: boolean;
  itemType?: number;
  associatedType?: number;
  balloon?: string;
  attachments?: Array<{ filename: string; mime: string; name: string }>;
  /** Insert the message row but not its chat link (simulates Messages mid-write). */
  orphan?: boolean;
  date?: bigint;
}

export class FakeChatDb {
  readonly dir = mkdtempSync(join(tmpdir(), 'textagent-imessage-'));
  readonly path = join(this.dir, 'chat.db');
  readonly db = new DatabaseSync(this.path);
  #guid = 0;

  constructor() {
    this.db.exec(SCHEMA);
  }

  chat(guid: string, style: 43 | 45, displayName = ''): string {
    const identifier = guid.split(';').at(-1)!;
    this.db
      .prepare('INSERT INTO chat (guid, style, chat_identifier, service_name, display_name) VALUES (?, ?, ?, ?, ?)')
      .run(guid, style, identifier, 'iMessage', displayName);
    return guid;
  }

  message(input: MessageInput): number {
    let handleId = 0;
    if (input.from) {
      const existing = this.db.prepare('SELECT ROWID FROM handle WHERE id = ?').get(input.from) as { ROWID: number } | undefined;
      handleId = existing?.ROWID ?? Number(this.db.prepare("INSERT INTO handle (id, service) VALUES (?, 'iMessage')").run(input.from).lastInsertRowid);
    }
    const rowid = Number(
      this.db
        .prepare(
          `INSERT INTO message (guid, text, attributedBody, handle_id, service, date, is_from_me, item_type,
             associated_message_type, balloon_bundle_id, cache_has_attachments)
           VALUES (?, ?, ?, ?, 'iMessage', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `GUID-${++this.#guid}`,
          input.text === undefined ? null : input.text,
          input.body === undefined ? null : attributedBody(input.body),
          handleId,
          input.date ?? APPLE_NS_NOON,
          input.fromMe ? 1 : 0,
          input.itemType ?? 0,
          input.associatedType ?? 0,
          input.balloon ?? null,
          input.attachments?.length ? 1 : 0,
        ).lastInsertRowid,
    );
    if (!input.orphan) this.link(rowid, input.chat!);
    for (const a of input.attachments ?? []) {
      const id = this.db
        .prepare('INSERT INTO attachment (filename, mime_type, transfer_name) VALUES (?, ?, ?)')
        .run(a.filename, a.mime, a.name).lastInsertRowid;
      this.db.prepare('INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)').run(rowid, id);
    }
    return rowid;
  }

  link(rowid: number, chatGuid: string): void {
    this.db
      .prepare('INSERT INTO chat_message_join (chat_id, message_id) SELECT ROWID, ? FROM chat WHERE guid = ?')
      .run(rowid, chatGuid);
  }

  cleanup(): void {
    if (this.db.isOpen) this.db.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
