/**
 * Recognizes our own replies coming back as "incoming" messages.
 *
 * When the agent runs on the same Apple ID someone is texting from (texting yourself
 * is the usual way to try it), each reply lands in chat.db twice: as sent and as
 * received. Without this, the agent answers its own reply, forever.
 */
export class EchoGuard {
  readonly #windowMs: number;
  /** thread id → recently sent texts with their send time. */
  readonly #sent = new Map<string, Array<{ text: string; at: number }>>();

  constructor(windowMs = 60_000) {
    this.#windowMs = windowMs;
  }

  record(threadId: string, text: string, now = Date.now()): void {
    const list = this.#prune(threadId, now);
    list.push({ text: normalize(text), at: now });
    this.#sent.set(threadId, list);
  }

  /** Forget a record, e.g. when the send it was made for failed. */
  forget(threadId: string, text: string): void {
    const list = this.#sent.get(threadId);
    const i = list?.findIndex((e) => e.text === normalize(text)) ?? -1;
    if (i >= 0) list!.splice(i, 1);
  }

  /** True if this inbound text is an echo of something we sent. Each send absorbs one echo. */
  isEcho(threadId: string, text: string, now = Date.now()): boolean {
    const list = this.#prune(threadId, now);
    const i = list.findIndex((e) => e.text === normalize(text));
    if (i === -1) return false;
    list.splice(i, 1);
    return true;
  }

  #prune(threadId: string, now: number) {
    const list = (this.#sent.get(threadId) ?? []).filter((e) => now - e.at <= this.#windowMs);
    if (list.length) this.#sent.set(threadId, list);
    else this.#sent.delete(threadId);
    return list;
  }
}

/** Messages may normalize whitespace/line endings on the way through. */
function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}
