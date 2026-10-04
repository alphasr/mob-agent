import type { Attachment, InboundMessage, Thread } from '@textagent/core';
import type { TgMessage } from './api.ts';

/**
 * Thread ids are the chat id, plus the topic for forum supergroups:
 * "-1001234" or "-1001234:42". Replies must go back to the same topic.
 */
export function threadId(message: TgMessage): string {
  return message.is_topic_message && message.message_thread_id !== undefined
    ? `${message.chat.id}:${message.message_thread_id}`
    : String(message.chat.id);
}

export function parseThreadId(id: string): { chatId: string; topicId?: number } {
  const [chatId, topic] = id.split(':');
  return topic === undefined ? { chatId: chatId! } : { chatId: chatId!, topicId: Number(topic) };
}

/** Returns undefined for messages the agent should never see. */
export function normalize(message: TgMessage): InboundMessage | undefined {
  // No sender: anonymous channel posts forwarded into a group. Bots: avoid bot-to-bot loops.
  if (!message.from || message.from.is_bot) return undefined;

  const attachments = attachmentsOf(message);
  const text = (message.text ?? message.caption ?? '').trim();
  if (!text && attachments.length === 0) return undefined; // joins, pins, title changes, ...

  const thread: Thread = {
    id: threadId(message),
    channel: 'telegram',
    isGroup: message.chat.type !== 'private',
  };
  const name = [message.from.first_name, message.from.last_name].filter(Boolean).join(' ');

  return {
    // message_id is only unique within a chat, so scope it for dedupe.
    id: `${message.chat.id}:${message.message_id}`,
    channel: 'telegram',
    thread,
    sender: { id: String(message.from.id), ...(name && { name }) },
    text,
    attachments,
    timestamp: new Date(message.date * 1000),
    raw: message,
  };
}

/** Attachment uris are `telegram-file:<file_id>`; resolve with TelegramChannel.fileUrl(). */
function attachmentsOf(m: TgMessage): Attachment[] {
  const out: Attachment[] = [];
  const add = (kind: Attachment['kind'], file: { file_id: string; mime_type?: string; file_name?: string }) =>
    out.push({
      kind,
      uri: `telegram-file:${file.file_id}`,
      ...(file.mime_type && { mimeType: file.mime_type }),
      ...(file.file_name && { filename: file.file_name }),
    });

  const largestPhoto = m.photo?.at(-1); // sizes are listed smallest first
  if (largestPhoto) add('image', { ...largestPhoto, mime_type: 'image/jpeg' });
  if (m.sticker) add('image', m.sticker);
  if (m.voice) add('audio', m.voice);
  if (m.audio) add('audio', m.audio);
  if (m.video) add('video', m.video);
  if (m.video_note) add('video', m.video_note);
  if (m.document) add('file', m.document);
  return out;
}
