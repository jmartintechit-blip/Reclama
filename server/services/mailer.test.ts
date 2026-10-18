import { describe, expect, it } from 'vitest';
import { createFakeMailer } from './fake-mailer.ts';
import {
  createResendMailer,
  MailerError,
  type MailMessage,
  type MailerErrorCode,
} from './mailer.ts';

const API_KEY = 're_fake_key_for_tests_only';
const MESSAGE: MailMessage = {
  from: 'Reclama <onboarding@resend.dev>',
  to: 'delivered@resend.dev',
  subject: 'Requerimiento de pago F-1',
  text: 'Hola',
  attachments: [
    {
      filename: 'requerimiento-f-1.pdf',
      content: Buffer.from('%PDF-1.7 fake'),
      contentType: 'application/pdf',
    },
  ],
  idempotencyKey: 'claim-1:key-12345678',
};

interface Call {
  url: string;
  init: RequestInit;
}

// A fetch that records its calls and answers with `respond`.
function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    calls.push({ url: input as string, init: init ?? {} });
    return Promise.resolve(respond());
  };
  return { calls, fetchFn };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

async function failureOf(promise: Promise<unknown>): Promise<MailerError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MailerError) return error;
    throw error;
  }
  throw new Error('The send was expected to fail');
}

describe('createResendMailer', () => {
  it('POSTs the message to the Resend API with the key, the idempotency key and a JSON body', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ id: 'msg_123' }));

    const result = await createResendMailer({ apiKey: API_KEY, fetchFn }).send(
      MESSAGE,
    );

    expect(result).toEqual({ id: 'msg_123' });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0] as Call;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'claim-1:key-12345678',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      from: 'Reclama <onboarding@resend.dev>',
      to: ['delivered@resend.dev'],
      subject: 'Requerimiento de pago F-1',
      text: 'Hola',
      attachments: [
        {
          filename: 'requerimiento-f-1.pdf',
          content: Buffer.from('%PDF-1.7 fake').toString('base64'),
          content_type: 'application/pdf',
        },
      ],
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('adds html only when the message has it', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ id: 'msg_1' }));

    await createResendMailer({ apiKey: API_KEY, fetchFn }).send({
      ...MESSAGE,
      html: '<p>Hola</p>',
    });

    expect(JSON.parse(calls[0]?.init.body as string)).toMatchObject({
      html: '<p>Hola</p>',
    });
  });

  it('counts a 2xx with an unreadable body as sent, with no id', async () => {
    for (const body of ['not json', '{}', '{"id":5}', 'null']) {
      const { fetchFn } = fakeFetch(() => new Response(body, { status: 200 }));

      const result = await createResendMailer({
        apiKey: API_KEY,
        fetchFn,
      }).send(MESSAGE);

      expect(result, body).toEqual({ id: null });
    }
  });

  it.each<[number, MailerErrorCode]>([
    [500, 'PROVIDER_UNAVAILABLE'],
    [502, 'PROVIDER_UNAVAILABLE'],
    [503, 'PROVIDER_UNAVAILABLE'],
    [429, 'PROVIDER_RATE_LIMITED'],
    [401, 'PROVIDER_REJECTED'],
    [403, 'PROVIDER_REJECTED'],
    [400, 'PROVIDER_INVALID'],
    [409, 'PROVIDER_INVALID'],
    [422, 'PROVIDER_INVALID'],
  ])(
    'maps the provider status %i to %s without keeping the provider text',
    async (status, code) => {
      const secretText = 'provider says: key re_secret and domain acme.test';
      const { fetchFn } = fakeFetch(() =>
        json({ name: 'validation_error', message: secretText }, status),
      );

      const error = await failureOf(
        createResendMailer({ apiKey: API_KEY, fetchFn }).send(MESSAGE),
      );

      expect(error.code).toBe(code);
      expect(error.name).toBe('MailerError');
      expect(error.message).toBe(code);
      expect(error.cause).toBeUndefined();
      expect(error.stack ?? '').not.toContain(secretText);
      expect(error.message).not.toContain(API_KEY);
    },
  );

  it('maps a network error to PROVIDER_UNAVAILABLE and drops its cause', async () => {
    const fetchFn: typeof fetch = () =>
      Promise.reject(new TypeError('getaddrinfo ENOTFOUND api.resend.com'));

    const error = await failureOf(
      createResendMailer({ apiKey: API_KEY, fetchFn }).send(MESSAGE),
    );

    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(error.cause).toBeUndefined();
    expect(error.message).not.toContain('ENOTFOUND');
  });

  it('gives up after the timeout, even with a fetch that never answers and ignores the signal', async () => {
    const fetchFn: typeof fetch = () => new Promise<Response>(() => undefined);

    const started = performance.now();
    const error = await failureOf(
      createResendMailer({ apiKey: API_KEY, fetchFn, timeoutMs: 30 }).send(
        MESSAGE,
      ),
    );

    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('aborts the request when the timeout runs out', async () => {
    let signal: AbortSignal | undefined;
    const fetchFn: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        signal = init?.signal ?? undefined;
        signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });

    const error = await failureOf(
      createResendMailer({ apiKey: API_KEY, fetchFn, timeoutMs: 30 }).send(
        MESSAGE,
      ),
    );

    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(signal?.aborted).toBe(true);
  });

  it('does not abort a request that finished in time', async () => {
    let signal: AbortSignal | undefined;
    const fetchFn: typeof fetch = (_input, init) => {
      signal = init?.signal ?? undefined;
      return Promise.resolve(json({ id: 'msg_1' }));
    };

    await createResendMailer({ apiKey: API_KEY, fetchFn, timeoutMs: 30 }).send(
      MESSAGE,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(signal?.aborted).toBe(false);
  });
});

describe('createFakeMailer', () => {
  it('records what it accepts, and fails on demand until told to stop', async () => {
    const mailer = createFakeMailer();

    expect(await mailer.send(MESSAGE)).toEqual({ id: 'fake-1' });
    mailer.failWith('PROVIDER_REJECTED');
    const error = await failureOf(mailer.send(MESSAGE));
    mailer.failWith(null);
    await mailer.send(MESSAGE);

    expect(error.code).toBe('PROVIDER_REJECTED');
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.attempts).toHaveLength(3);
  });
});
