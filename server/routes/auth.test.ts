import * as crypto from 'node:crypto';
import { argon2Sync, createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { needsRehash } from '../auth/password.ts';
import { SESSION_LIFETIME_MS } from '../auth/session.ts';
import { createApp } from '../app.ts';
import type { Db } from '../db/client.ts';
import { createTestDb, type TestDb } from '../db/test-db.ts';
import type { Clock } from '../domain/dates.ts';
import { close, listen } from '../test-utils.ts';

// Wrap the real argon2 in a spy, to count how many hashes a request really computes.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, argon2: vi.fn(actual.argon2) };
});

const PASSWORD = 'correct horse battery';
const WRONG = 'correct horse batterz';
const START = Date.parse('2026-10-14T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

let nowMs = START;
const clock: Clock = { now: () => new Date(nowMs) };

let db: TestDb;
let server: Server;
let baseUrl: string;
let emailCounter = 0;
const newEmail = () => `user${String((emailCounter += 1))}@example.com`;
const argon2Calls = () => vi.mocked(crypto.argon2).mock.calls.length;

// Everything the app wrote to the console during a test, as one string.
const logSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
  (level) => ({ level, spy: vi.spyOn(console, level) }),
);
const logged = () =>
  JSON.stringify(logSpies.flatMap(({ spy }) => spy.mock.calls));

beforeAll(async () => {
  db = await createTestDb();
  ({ server, baseUrl } = await listen(createApp({ db, clock })));
});

afterAll(async () => {
  await close(server);
  await db.close();
});

beforeEach(async () => {
  nowMs = START;
  // Every request here comes from one IP; the limiter itself is tested in auth-rate-limit.test.ts.
  await db.query('delete from rate_limits');
  for (const { spy } of logSpies) spy.mockImplementation(() => undefined);
});

afterEach(() => {
  for (const { spy } of logSpies) spy.mockReset();
  vi.mocked(crypto.argon2).mockClear();
});

function send(
  path: string,
  { body, cookie, method = 'POST' }: SendOptions,
  url = baseUrl,
) {
  return fetch(`${url}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie === undefined ? {} : { Cookie: cookie }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
interface SendOptions {
  body?: unknown;
  cookie?: string;
  method?: string;
}

const post = (path: string, body?: unknown, cookie?: string) =>
  send(path, { body, cookie });
const getMe = (cookie?: string) => send('/api/me', { method: 'GET', cookie });

// "__Host-sid=<token>", exactly as a browser would send it back.
function cookieOf(res: Response): string {
  const header = res.headers.getSetCookie()[0] ?? '';
  return header.split(';')[0] ?? '';
}
const tokenOf = (cookie: string) => cookie.slice('__Host-sid='.length);

async function register(email = newEmail(), password = PASSWORD) {
  const res = await post('/api/auth/register', { email, password });
  const body = (await res.json()) as { data: { user: { id: string } } };
  return { email, id: body.data.user.id, cookie: cookieOf(res) };
}

// An error body without its per-request id, to compare two answers.
async function errorOf(res: Response) {
  const { error } = (await res.json()) as {
    error: { request_id: string } & Record<string, unknown>;
  };
  const { request_id: requestId, ...rest } = error;
  expect(requestId).toBe(res.headers.get('x-request-id'));
  return rest;
}

describe('register, me, logout', () => {
  it('registers, reads /api/me, logs out and then loses access', async () => {
    const email = newEmail();
    const res = await post('/api/auth/register', { email, password: PASSWORD });

    expect(res.status).toBe(201);
    const { data } = (await res.json()) as {
      data: { user: { id: string; email: string } };
    };
    expect(data).toEqual({ user: { id: expect.any(String) as string, email } });
    const cookie = cookieOf(res);

    const me = await getMe(cookie);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      data: {
        user: { id: data.user.id, email, is_demo: false },
        profile: {
          business_name: null,
          tax_id: null,
          address: null,
          iban: null,
          default_compensation: 'PER_CLAIM',
        },
      },
    });

    const out = await post('/api/auth/logout', undefined, cookie);
    expect(out.status).toBe(204);
    expect(await out.text()).toBe('');
    const cleared = out.headers.getSetCookie();
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatch(/^__Host-sid=;/);
    expect(cleared[0]).toMatch(/Path=\/;/);
    expect(cleared[0]).toMatch(/Expires=Thu, 01 Jan 1970/);

    const after = await getMe(cookie);
    expect(after.status).toBe(401);
    expect(await errorOf(after)).toEqual({
      code: 'UNAUTHENTICATED',
      message: 'Authentication required',
    });
  });

  it('creates the user and its empty profile together', async () => {
    const { id } = await register();

    const { rows } = await db.query(
      'select count(*) as n from profiles where user_id = $1',
      [id],
    );
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('answers 401 to /api/me and logout without any cookie', async () => {
    for (const res of [await getMe(), await post('/api/auth/logout')]) {
      expect(res.status).toBe(401);
      expect(await errorOf(res)).toEqual({
        code: 'UNAUTHENTICATED',
        message: 'Authentication required',
      });
    }
  });
});

describe('the session cookie', () => {
  it('is one Set-Cookie with the required attributes and no Domain', async () => {
    const res = await post('/api/auth/register', {
      email: newEmail(),
      password: PASSWORD,
    });

    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    const [nameAndValue, ...attributes] = (cookies[0] ?? '').split('; ');
    expect(nameAndValue).toMatch(/^__Host-sid=[A-Za-z0-9_-]{43}$/);
    expect(attributes).toEqual(
      expect.arrayContaining([
        'HttpOnly',
        'Secure',
        'SameSite=Lax',
        'Path=/',
        'Max-Age=604800', // 7 days
      ]),
    );
    expect(cookies[0]).not.toMatch(/domain/i);
  });

  it('is stored as its SHA-256, never as the token, expiring 7 days after the fake clock', async () => {
    const { cookie, id } = await register();
    const token = tokenOf(cookie);

    const { rows } = await db.query(
      'select token_hash, expires_at from sessions where user_id = $1',
      [id],
    );

    expect(rows).toHaveLength(1);
    const row = rows[0] as { token_hash: Uint8Array; expires_at: Date };
    expect(Buffer.from(row.token_hash)).toEqual(
      createHash('sha256').update(token).digest(),
    );
    expect(new Date(row.expires_at).getTime()).toBe(START + 7 * DAY);
    // The token (as text, or as the 32 bytes it encodes) is not a key in the table.
    for (const raw of [Buffer.from(token), Buffer.from(token, 'base64url')]) {
      const found = await db.query(
        'select count(*) as n from sessions where token_hash = $1',
        [raw],
      );
      expect(found.rows).toEqual([{ n: 0 }]);
    }
  });

  it('expires 7 days after it was created, checked against the injected clock', async () => {
    const { cookie } = await register();

    nowMs = START + SESSION_LIFETIME_MS - 1000;
    expect((await getMe(cookie)).status).toBe(200);

    nowMs = START + SESSION_LIFETIME_MS; // expiring exactly now already counts as expired
    expect((await getMe(cookie)).status).toBe(401);

    nowMs = START + SESSION_LIFETIME_MS + DAY;
    expect((await getMe(cookie)).status).toBe(401);
  });

  it.each([
    ['not a token', 'garbage'],
    ['an empty value', '__Host-sid='],
    ['a well-formed token that does not exist', `__Host-sid=${'A'.repeat(43)}`],
    ['a huge header', `__Host-sid=${'A'.repeat(8000)}`],
    ['other cookies only', 'a=1; b=2'],
  ])('answers 401 to %s, and keeps working', async (_name, cookie) => {
    const mine = await register();

    const me = await getMe(cookie);
    const out = await post('/api/auth/logout', undefined, cookie);

    expect(me.status).toBe(401);
    expect(out.status).toBe(401);
    expect(await errorOf(me)).toEqual({
      code: 'UNAUTHENTICATED',
      message: 'Authentication required',
    });
    expect((await getMe(mine.cookie)).status).toBe(200); // nothing was damaged
  });

  it('answers 401 to a real token that was tampered with, or sent twice', async () => {
    const { cookie } = await register();
    const token = tokenOf(cookie);
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');

    expect((await getMe(`__Host-sid=${flipped}`)).status).toBe(401);
    expect((await getMe(`${cookie}; ${cookie}`)).status).toBe(401);
    expect((await getMe(`${cookie}x`)).status).toBe(401);
    expect((await getMe(cookie)).status).toBe(200);
  });
});

describe('POST /api/auth/register', () => {
  it('lowercases and trims the email', async () => {
    const email = `Mixed.Case${String(emailCounter)}@Example.COM`;

    const res = await post('/api/auth/register', {
      email: `  ${email}  `,
      password: PASSWORD,
    });

    expect(res.status).toBe(201);
    const { data } = (await res.json()) as {
      data: { user: { email: string } };
    };
    expect(data.user.email).toBe(email.toLowerCase());
  });

  it('answers 409 EMAIL_TAKEN for the same email in another case, without a cookie', async () => {
    const { email } = await register(`dup${String(emailCounter)}@example.com`);

    const res = await post('/api/auth/register', {
      email: ` ${email.toUpperCase()} `,
      password: PASSWORD,
    });

    expect(res.status).toBe(409);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await errorOf(res)).toEqual({
      code: 'EMAIL_TAKEN',
      message: 'Email already registered',
    });
  });

  it('lets exactly one of two simultaneous registrations of the same email win', async () => {
    const email = newEmail();

    const results = await Promise.all([
      post('/api/auth/register', { email, password: PASSWORD }),
      post('/api/auth/register', { email, password: PASSWORD }),
    ]);

    expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
    const loser = results.find((res) => res.status === 409);
    expect(loser?.headers.getSetCookie()).toEqual([]);
    const users = await db.query(
      'select count(*) as n from users where email = $1',
      [email],
    );
    expect(users.rows).toEqual([{ n: 1 }]);
  });

  it('stores an argon2id hash, not the password', async () => {
    const { id } = await register();

    const { rows } = await db.query(
      'select password_hash from users where id = $1',
      [id],
    );

    const hash = (rows[0] as { password_hash: string }).password_hash;
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain(PASSWORD);
  });
});

describe('POST /api/auth/login', () => {
  it('logs in with a new token every time, email in any case', async () => {
    const user = await register();

    const first = await post('/api/auth/login', {
      email: ` ${user.email.toUpperCase()} `,
      password: PASSWORD,
    });
    const second = await post('/api/auth/login', {
      email: user.email,
      password: PASSWORD,
    });

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      data: { user: { id: user.id, email: user.email } },
    });
    expect(first.headers.getSetCookie()).toHaveLength(1);
    const tokens = [user.cookie, cookieOf(first), cookieOf(second)];
    expect(new Set(tokens).size).toBe(3);
    for (const cookie of tokens) {
      expect((await getMe(cookie)).status).toBe(200);
    }
  });

  it('gives the same 401 for a wrong password, an unknown email and a demo user, and always spends a hash', async () => {
    const user = await register();
    const demoEmail = newEmail();
    await db.query(
      'insert into users (email, is_demo, expires_at) values ($1, true, $2)',
      [demoEmail, new Date(START + DAY).toISOString()],
    );
    const attempts = [
      { email: user.email, password: WRONG },
      { email: newEmail(), password: PASSWORD },
      { email: demoEmail, password: PASSWORD },
    ];

    const answers = [];
    for (const attempt of attempts) {
      vi.mocked(crypto.argon2).mockClear();
      const res = await post('/api/auth/login', attempt);
      expect(argon2Calls()).toBe(1);
      expect(res.status).toBe(401);
      expect(res.headers.getSetCookie()).toEqual([]);
      answers.push(await errorOf(res));
    }

    expect(answers[0]).toEqual({
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid email or password',
    });
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
  });

  it('refuses an over-long password with 400 before any account lookup', async () => {
    const user = await register();

    const res = await post('/api/auth/login', {
      email: user.email,
      password: 'p'.repeat(129),
    });

    expect(res.status).toBe(400);
  });

  it('upgrades a weaker stored hash after a correct login', async () => {
    const email = newEmail();
    const weak = hashWith(PASSWORD, 8192, 1);
    expect(needsRehash(weak)).toBe(true);
    await db.query('insert into users (email, password_hash) values ($1, $2)', [
      email,
      weak,
    ]);

    const wrong = await post('/api/auth/login', { email, password: WRONG });
    expect(wrong.status).toBe(401);
    expect(await storedHash(email)).toBe(weak); // a failed login upgrades nothing

    const res = await post('/api/auth/login', { email, password: PASSWORD });
    expect(res.status).toBe(200);
    const upgraded = await storedHash(email);
    expect(upgraded).not.toBe(weak);
    expect(needsRehash(upgraded)).toBe(false);
    expect(upgraded).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);

    const again = await post('/api/auth/login', { email, password: PASSWORD });
    expect(again.status).toBe(200); // the new hash verifies the same password
  });

  it('still logs in when the upgrade is impossible (a legacy password below the minimum)', async () => {
    const email = newEmail();
    const weak = hashWith('short', 8192, 1);
    await db.query('insert into users (email, password_hash) values ($1, $2)', [
      email,
      weak,
    ]);

    const res = await post('/api/auth/login', { email, password: 'short' });

    expect(res.status).toBe(200);
    expect(await storedHash(email)).toBe(weak);
  });

  it('still logs in when the database refuses the upgrade', async () => {
    const email = newEmail();
    const weak = hashWith(PASSWORD, 8192, 1);
    await db.query('insert into users (email, password_hash) values ($1, $2)', [
      email,
      weak,
    ]);
    const failing: Db = {
      query: (sql, params) =>
        sql.startsWith('update users')
          ? Promise.reject(new Error('disk full'))
          : db.query(sql, params),
    };
    const other = await listen(createApp({ db: failing, clock }));

    try {
      const res = await send(
        '/api/auth/login',
        { body: { email, password: PASSWORD } },
        other.baseUrl,
      );
      expect(res.status).toBe(200);
      expect(res.headers.getSetCookie()).toHaveLength(1);
    } finally {
      await close(other.server);
    }
    expect(await storedHash(email)).toBe(weak);
  });
});

describe('POST /api/auth/logout', () => {
  it('deletes only the caller session; the same user and other users keep theirs', async () => {
    const user = await register();
    const second = await post('/api/auth/login', {
      email: user.email,
      password: PASSWORD,
    });
    const secondCookie = cookieOf(second);
    const other = await register();

    const out = await post('/api/auth/logout', undefined, user.cookie);

    expect(out.status).toBe(204);
    expect((await getMe(user.cookie)).status).toBe(401);
    expect((await getMe(secondCookie)).status).toBe(200);
    expect((await getMe(other.cookie)).status).toBe(200);
    const left = await db.query(
      'select count(*) as n from sessions where user_id = $1',
      [user.id],
    );
    expect(left.rows).toEqual([{ n: 1 }]);
  });
});

describe('validation of the request body', () => {
  // Each case lists the values that must not come back in the response or the logs.
  const cases: [string, unknown, string[]][] = [
    ['an empty object', {}, []],
    ['a missing password', { email: 'a@example.com' }, ['a@example.com']],
    ['a missing email', { password: PASSWORD }, [PASSWORD]],
    [
      'a bad email',
      { email: 'not-an-email', password: PASSWORD },
      [PASSWORD, 'not-an-email'],
    ],
    [
      'two @ in the email',
      { email: 'a@b@example.com', password: PASSWORD },
      [PASSWORD],
    ],
    [
      'a non-ASCII email',
      { email: 'ñandú@example.com', password: PASSWORD },
      [PASSWORD, 'ñandú'],
    ],
    [
      'an email over 254 characters',
      { email: `${'a'.repeat(250)}@b.co`, password: PASSWORD },
      [PASSWORD],
    ],
    ['an email that is a number', { email: 5, password: PASSWORD }, [PASSWORD]],
    [
      'a 9 character password',
      { email: 'a@example.com', password: 'abcdefghi' },
      ['abcdefghi'],
    ],
    [
      'a 129 character password',
      { email: 'a@example.com', password: 'q'.repeat(129) },
      ['q'.repeat(129)],
    ],
    [
      'a password that is a number',
      { email: 'a@example.com', password: 1234567890123 },
      ['1234567890123'],
    ],
    ['a null password', { email: 'a@example.com', password: null }, []],
    [
      'a lone surrogate in the password',
      { email: 'a@example.com', password: '\ud800'.repeat(12) },
      [],
    ],
    ['an array instead of an object', [], []],
  ];

  it.each(cases)(
    'rejects %s with 400 VALIDATION_ERROR',
    async (_name, body, secrets) => {
      const res = await post('/api/auth/register', body);
      const text = await res.text();

      expect(res.status).toBe(400);
      expect(res.headers.getSetCookie()).toEqual([]);
      const { error } = JSON.parse(text) as {
        error: { code: string; details: { path: string; message: string }[] };
      };
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details.length).toBeGreaterThan(0);
      for (const detail of error.details) {
        expect(Object.keys(detail).sort()).toEqual(['message', 'path']);
      }
      for (const secret of secrets) {
        expect(text).not.toContain(secret);
        expect(logged()).not.toContain(secret);
      }
    },
  );

  it('names the failing field in the details', async () => {
    const res = await post('/api/auth/register', {
      email: 'not-an-email',
      password: 'short',
    });

    const { error } = (await res.json()) as {
      error: { details: { path: string }[] };
    };
    expect(error.details.map((detail) => detail.path).sort()).toEqual([
      'email',
      'password',
    ]);
  });

  it('applies the same checks to login, except the minimum length', async () => {
    const empty = await post('/api/auth/login', {});
    const number = await post('/api/auth/login', {
      email: 'a@example.com',
      password: 5,
    });
    const short = await post('/api/auth/login', {
      email: 'a@example.com',
      password: 'abc',
    });

    expect(empty.status).toBe(400);
    expect(number.status).toBe(400);
    expect(short.status).toBe(401); // a short password is just a wrong password
  });

  it('answers 415 UNSUPPORTED_MEDIA_TYPE when the body is not sent as JSON', async () => {
    const secret = 'plain-text-secret-123';
    for (const type of ['text/plain', 'application/x-www-form-urlencoded']) {
      const res = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': type },
        body: `email=a@example.com&password=${secret}`,
      });
      const text = await res.text();

      expect(res.status).toBe(415);
      expect(text).toContain('UNSUPPORTED_MEDIA_TYPE');
      expect(text).not.toContain(secret);
    }
    expect(logged()).not.toContain(secret);
  });

  it('answers 400 INVALID_JSON for broken JSON without echoing it', async () => {
    const secret = 'broken-json-secret-123';
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `{"email":"a@example.com","password":"${secret}`,
    });
    const text = await res.text();

    expect(res.status).toBe(400);
    expect(text).toContain('INVALID_JSON');
    expect(text).not.toContain(secret);
    expect(logged()).not.toContain(secret);
  });

  it('answers 413 for a huge body without echoing it', async () => {
    const secret = 'huge-body-secret-123';
    const res = await post('/api/auth/register', {
      email: 'a@example.com',
      password: secret,
      padding: 'x'.repeat(20_000),
    });
    const text = await res.text();

    expect(res.status).toBe(413);
    expect(text).not.toContain(secret);
    expect(logged()).not.toContain(secret);
  });

  it('never logs the password, even for a successful register and login', async () => {
    const secret = 'a-very-secret-passphrase-42';
    const email = newEmail();

    await post('/api/auth/register', { email, password: secret });
    await post('/api/auth/login', { email, password: secret });
    await post('/api/auth/login', { email, password: `${secret}!` });

    expect(logged()).not.toContain(secret);
  });
});

// A valid hash with chosen (weak) parameters; the module under test only makes current ones.
function hashWith(password: string, memory: number, passes: number): string {
  const salt = randomBytes(16);
  const hash = argon2Sync('argon2id', {
    message: password.normalize('NFKC'),
    nonce: salt,
    memory,
    passes,
    parallelism: 1,
    tagLength: 32,
  });
  const b64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');
  return `$argon2id$v=19$m=${String(memory)},t=${String(passes)},p=1$${b64(salt)}$${b64(hash)}`;
}

async function storedHash(email: string): Promise<string> {
  const { rows } = await db.query(
    'select password_hash from users where email = $1',
    [email],
  );
  return (rows[0] as { password_hash: string }).password_hash;
}
