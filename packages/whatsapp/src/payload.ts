import type { Attachment, InboundMessage } from '@textagent/core';

/**
 * Webhook payloads are untrusted even when signed (Meta can change shapes, and a bug
 * upstream can send garbage), so every field is checked before use. Anything that
 * doesn't match is skipped rather than allowed to crash the request.
 *
 * Shape: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 */

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const MEDIA_KINDS: Record<string, Attachment['kind']> = {
  image: 'image',
  sticker: 'image',
  audio: 'audio',
  video: 'video',
  document: 'file',
};

/** Extract the user messages for one business phone number; statuses and other numbers are ignored. */
export function messagesFromPayload(payload: unknown, phoneNumberId: string): InboundMessage[] {
  if (!isObject(payload) || payload.object !== 'whatsapp_business_account') return [];
  const out: InboundMessage[] = [];

  for (const entry of list(payload.entry)) {
    if (!isObject(entry)) continue;
    for (const change of list(entry.changes)) {
      if (!isObject(change) || change.field !== 'messages' || !isObject(change.value)) continue;
      const value = change.value;
      if (!isObject(value.metadata) || value.metadata.phone_number_id !== phoneNumberId) continue;

      const names = new Map<string, string>();
      for (const contact of list(value.contacts)) {
        if (!isObject(contact)) continue;
        const waId = str(contact.wa_id);
        const name = isObject(contact.profile) ? str(contact.profile.name) : undefined;
        if (waId && name) names.set(waId, name);
      }

      for (const raw of list(value.messages)) {
        const message = normalizeMessage(raw, names);
        if (message) out.push(message);
      }
    }
  }
  return out;
}

function normalizeMessage(raw: unknown, names: Map<string, string>): InboundMessage | undefined {
  if (!isObject(raw)) return undefined;
  const id = str(raw.id);
  const from = str(raw.from);
  const type = str(raw.type);
  const seconds = Number(raw.timestamp);
  if (!id || !from || !type || !Number.isFinite(seconds)) return undefined;

  const content = contentOf(raw, type);
  if (!content) return undefined;

  const name = names.get(from);
  return {
    id,
    channel: 'whatsapp',
    thread: { id: from, channel: 'whatsapp', isGroup: false },
    sender: { id: from, ...(name && { name }) },
    text: content.text.trim(),
    attachments: content.attachments,
    timestamp: new Date(seconds * 1000),
    raw,
  };
}

/** Undefined for types the agent doesn't handle yet: reactions, locations, contacts, orders, unsupported, system. */
function contentOf(raw: Json, type: string): { text: string; attachments: Attachment[] } | undefined {
  const body = raw[type];
  if (!isObject(body)) return undefined;

  switch (type) {
    case 'text': {
      const text = str(body.body);
      return text ? { text, attachments: [] } : undefined;
    }
    case 'interactive': {
      // The user tapped a reply button or picked from a list; the title is what they "said".
      const reply = isObject(body.button_reply) ? body.button_reply : body.list_reply;
      const title = isObject(reply) ? str(reply.title) : undefined;
      return title ? { text: title, attachments: [] } : undefined;
    }
    case 'button': {
      // Quick-reply button on a template message.
      const text = str(body.text);
      return text ? { text, attachments: [] } : undefined;
    }
  }

  const kind = MEDIA_KINDS[type];
  const mediaId = str(body.id);
  if (!kind || !mediaId) return undefined;
  const mimeType = str(body.mime_type);
  const filename = str(body.filename);
  return {
    text: str(body.caption) ?? '',
    attachments: [
      {
        kind,
        uri: `whatsapp-media:${mediaId}`,
        ...(mimeType && { mimeType }),
        ...(filename && { filename }),
      },
    ],
  };
}
