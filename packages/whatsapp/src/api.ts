/** The slice of the WhatsApp Cloud API (Meta Graph API) this channel uses. */

export class WhatsAppApiError extends Error {
  readonly status: number;
  /** Graph API error code, e.g. 131047 for the 24-hour window. */
  readonly code: number | undefined;
  constructor(message: string, status: number, code: number | undefined) {
    super(message);
    this.name = 'WhatsAppApiError';
    this.status = status;
    this.code = code;
  }
}

/** Codes worth turning into instructions. https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes */
const EXPLANATIONS: Record<number, string> = {
  131047:
    "More than 24 hours have passed since this user's last message, so WhatsApp only allows " +
    'pre-approved template messages until they write again.',
  190: 'The WhatsApp access token is invalid or expired. Generate a new one (use a System User token in production).',
  131030:
    'This number is not on the allowed recipient list for your test phone number. Add it in the Meta app dashboard.',
};

export interface WhatsAppApiOptions {
  accessToken: string;
  phoneNumberId: string;
  /** Default: v23.0 */
  apiVersion?: string;
  /** Default: https://graph.facebook.com */
  apiBase?: string;
}

export class WhatsAppApi {
  readonly #token: string;
  readonly #phoneNumberId: string;
  readonly #base: string;

  constructor({
    accessToken,
    phoneNumberId,
    apiVersion = 'v23.0',
    apiBase = 'https://graph.facebook.com',
  }: WhatsAppApiOptions) {
    this.#token = accessToken;
    this.#phoneNumberId = phoneNumberId;
    this.#base = `${apiBase.replace(/\/$/, '')}/${apiVersion}`;
  }

  async sendText(to: string, body: string): Promise<string> {
    const result = await this.#request<{ messages?: Array<{ id?: string }> }>(`/${this.#phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      // Off so a URL in a reply doesn't pull in an unexpected preview card.
      text: { body, preview_url: false },
    });
    const id = result.messages?.[0]?.id;
    if (!id) throw new WhatsAppApiError('WhatsApp accepted the message but returned no id', 200, undefined);
    return id;
  }

  /** A pre-approved template: the only way to message someone outside the 24-hour window. */
  async sendTemplate(to: string, template: { name: string; language: string; params?: string[] }): Promise<string> {
    const result = await this.#request<{ messages?: Array<{ id?: string }> }>(`/${this.#phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language },
        ...(template.params?.length && {
          components: [{ type: 'body', parameters: template.params.map((text) => ({ type: 'text', text })) }],
        }),
      },
    });
    const id = result.messages?.[0]?.id;
    if (!id) throw new WhatsAppApiError('WhatsApp accepted the template but returned no id', 200, undefined);
    return id;
  }

  /** Read-only lookup of the configured business number; proves the token and phone number id work. */
  async getPhoneNumber(): Promise<{ display_phone_number?: string; verified_name?: string }> {
    return this.#request(`/${this.#phoneNumberId}?fields=display_phone_number,verified_name`);
  }

  /** Marks `messageId` as read and shows "typing…" for up to 25 seconds or until we reply. */
  async sendTyping(messageId: string): Promise<void> {
    await this.#request(`/${this.#phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' },
    });
  }

  /** Media URLs require the access token, so this downloads instead of handing out a URL. */
  async downloadMedia(mediaId: string): Promise<{ data: Uint8Array; mimeType: string | undefined }> {
    const meta = await this.#request<{ url?: string; mime_type?: string }>(`/${encodeURIComponent(mediaId)}`);
    if (!meta.url) throw new WhatsAppApiError(`No download URL for media ${mediaId}`, 200, undefined);
    const response = await this.#fetch(meta.url, { headers: { authorization: `Bearer ${this.#token}` } });
    if (!response.ok)
      throw new WhatsAppApiError(`Media download failed (${response.status})`, response.status, undefined);
    return { data: new Uint8Array(await response.arrayBuffer()), mimeType: meta.mime_type };
  }

  async #request<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    const response = await this.#fetch(`${this.#base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body && { 'content-type': 'application/json' }),
      },
      ...(body && { body: JSON.stringify(body) }),
    });
    const json = (await response.json().catch(() => undefined)) as
      (T & { error?: { message?: string; code?: number; error_data?: { details?: string } } }) | undefined;

    if (response.ok && json && !json.error) return json;
    const code = json?.error?.code;
    const detail = json?.error?.error_data?.details ?? json?.error?.message ?? response.statusText;
    const explanation = code !== undefined ? EXPLANATIONS[code] : undefined;
    throw new WhatsAppApiError(
      this.#redact(
        explanation
          ? `${explanation} (${code}: ${detail})`
          : `WhatsApp API error ${code ?? response.status}: ${detail}`,
      ),
      response.status,
      code,
    );
  }

  async #fetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (error) {
      throw new Error(this.#redact(`WhatsApp request failed: ${(error as Error).message}`));
    }
  }

  #redact(text: string): string {
    return text.replaceAll(this.#token, '<token>');
  }
}
