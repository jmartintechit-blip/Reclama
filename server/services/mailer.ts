// Sending email through the HTTP API of Resend, with the global `fetch` (no SDK, no dependency).
// The API key only ever travels in the Authorization header: it is never logged, put in an error
// or sent to the client. What the provider answers is reduced to four error codes and its text is
// dropped on purpose, because it can repeat the recipient address or the sender domain.

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments: MailAttachment[];
  // Sent to the provider as `Idempotency-Key`: the same key with the same message is delivered at
  // most once, so a retry after a timeout (when we cannot know if the first try got through) is safe.
  idempotencyKey: string;
}

export interface SendResult {
  id: string | null; // the provider's id for the message; null if it did not give a readable one
}

export interface Mailer {
  send(message: MailMessage): Promise<SendResult>;
}

export type MailerErrorCode =
  | 'PROVIDER_UNAVAILABLE' // network error, timeout, 5xx
  | 'PROVIDER_RATE_LIMITED' // 429
  | 'PROVIDER_REJECTED' // 401 or 403: bad key, or a sender domain that is not verified
  | 'PROVIDER_INVALID'; // any other 4xx: the provider did not accept the message

// The message is the code itself: it never carries anything the provider said.
export class MailerError extends Error {
  readonly code: MailerErrorCode;
  constructor(code: MailerErrorCode) {
    super(code);
    this.name = 'MailerError';
    this.code = code;
  }
}

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

function errorForStatus(status: number): MailerError {
  if (status === 429) return new MailerError('PROVIDER_RATE_LIMITED');
  if (status === 401 || status === 403) {
    return new MailerError('PROVIDER_REJECTED');
  }
  if (status >= 500) return new MailerError('PROVIDER_UNAVAILABLE');
  return new MailerError('PROVIDER_INVALID');
}

// A 2xx means the message was accepted, so an unreadable body is not a failure.
async function readProviderId(response: Response): Promise<string | null> {
  try {
    const body = await response.json();
    return typeof body === 'object' &&
      body !== null &&
      'id' in body &&
      typeof body.id === 'string'
      ? body.id
      : null;
  } catch {
    return null;
  }
}

// The serverless platform stops a function after a fixed time (10 s on the default settings). The
// provider call has to give up and answer before that, or the function is cut off in the middle
// of the request and the client gets a platform error instead of ours.
const DEFAULT_TIMEOUT_MS = 6_000;

export function createResendMailer({
  apiKey,
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  apiKey: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Mailer {
  return {
    async send(message) {
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      // Raced against the request instead of relying on the abort signal alone: the deadline then
      // holds even for a `fetch` that ignores the signal.
      const timedOut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new MailerError('PROVIDER_UNAVAILABLE'));
        }, timeoutMs);
      });

      async function exchange(): Promise<SendResult> {
        let response: Response;
        try {
          response = await fetchFn(RESEND_EMAILS_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': message.idempotencyKey,
            },
            body: JSON.stringify({
              from: message.from,
              to: [message.to],
              subject: message.subject,
              text: message.text,
              ...(message.html === undefined ? {} : { html: message.html }),
              attachments: message.attachments.map((attachment) => ({
                filename: attachment.filename,
                content: attachment.content.toString('base64'),
                content_type: attachment.contentType,
              })),
            }),
            signal: controller.signal,
          });
        } catch {
          throw new MailerError('PROVIDER_UNAVAILABLE'); // the cause is dropped: it can name hosts
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw errorForStatus(response.status);
        }
        return { id: await readProviderId(response) };
      }

      try {
        return await Promise.race([exchange(), timedOut]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
