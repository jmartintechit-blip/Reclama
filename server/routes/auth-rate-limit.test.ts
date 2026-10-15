import type { Server } from 'node:http';
import express, { type Express } from 'express';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createApp } from '../app.ts';
import type { Db } from '../db/client.ts';
import { hashKeyPart } from '../db/rate-limits.ts';
import { createTestDb, type TestDb } from '../db/test-db.ts';
import type { Clock } from '../domain/dates.ts';
import { close, listen } from '../test-utils.ts';

const PASSWORD = 'correct horse battery';
const WRONG = 'correct horse batterz';
const START = Date.parse('2026-10-14T10:00:00Z'); // the start of a 15 minute and of a 1 hour window
const MINUTE = 60 * 1000;

let nowMs = START;
const clock: Clock = { now: () => new Date(nowMs) };

let db: TestDb;
let server: Server;
let baseUrl: string;
let counter = 0;
const newEmail = () => `limit${String((counter += 1))}@example.com`;

// Wraps the app so that a test chooses the caller's IP with the x-test-ip header (without it,
// req.ip is undefined). Test-only plumbing: the app itself never reads such a header.
function withTestIp(app: Express): Express {
  const outer = express();
  outer.use((req, _res, next) => {
    const ip = req.headers['x-test-ip'];
    Object.defineProperty(req, 'ip', {
      value: typeof ip === 'string' ? ip : undefined,
      configurable: true,
    });
    next();
  });
  outer.use(app);
  return outer;
}

beforeAll(async () => {
  db = await createTestDb();
  ({ server, baseUrl } = await listen(withTestIp(createApp({ db, clock }))));
});

afterAll(async () => {
  await close(server);
  await db.close();
});

beforeEach(async () => {
  nowMs = START;
  await db.query('delete from rate_limits');
});

function post(
  path: string,
  body: unknown,
  ip?: string,
  url = baseUrl,
): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(ip === undefined ? {} : { 'x-test-ip': ip }),
    },
    body: JSON.stringify(body),
  });
}
const login = (email: string, password: string, ip?: string) =>
  post('/api/auth/login', { email, password }, ip);
const register = (email = newEmail(), ip?: string) =>
  post('/api/auth/register', { email, password: PASSWORD }, ip);

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await db.query(sql, params);
  return (rows[0] as { n: number }).n;
}
const sessionsOf = (email: string) =>
  count(
    'select count(*) as n from sessions s join users u on u.id = s.user_id where u.email = $1',
    [email],
  );

async function expectRateLimited(res: Response, retryAfter: string) {
  expect(res.status).toBe(429);
  expect(res.headers.get('retry-after')).toBe(retryAfter);
  expect(res.headers.getSetCookie()).toEqual([]);
  expect(await res.json()).toEqual({
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many requests, try again later',
      request_id: res.headers.get('x-request-id'),
    },
  });
  const corsHeaders = [...res.headers.keys()].filter((name) =>
    name.startsWith('access-control-'),
  );
  expect(corsHeaders).toEqual([]);
}

describe('POST /api/auth/login limit: 5 per 15 minutes per IP and email', () => {
  it('refuses the 6th attempt, even with the right password, and creates no session', async () => {
    const email = newEmail();
    await register(email, '10.0.0.1');
    const sessionsBefore = await sessionsOf(email);
    nowMs = START + 5 * MINUTE + 30_000;

    for (let i = 0; i < 5; i += 1) {
      expect((await login(email, WRONG, '10.0.0.2')).status).toBe(401);
    }
    const sixth = await login(email, PASSWORD, '10.0.0.2');

    await expectRateLimited(sixth, String(9 * 60 + 30));
    expect(await sessionsOf(email)).toBe(sessionsBefore);
  });

  it('still allows the 5th attempt, and it can succeed', async () => {
    const email = newEmail();
    await register(email, '10.0.0.1');
    for (let i = 0; i < 4; i += 1) await login(email, WRONG, '10.0.0.2');

    const fifth = await login(email, PASSWORD, '10.0.0.2');
    const sixth = await login(email, PASSWORD, '10.0.0.2');

    expect(fifth.status).toBe(200);
    expect(sixth.status).toBe(429);
  });

  it('counts per IP and per email separately', async () => {
    const mine = newEmail();
    const other = newEmail();
    await register(mine, '10.0.0.1');
    await register(other, '10.0.0.1');
    for (let i = 0; i < 5; i += 1) await login(mine, WRONG, '10.0.0.2');

    expect((await login(mine, PASSWORD, '10.0.0.2')).status).toBe(429);
    expect((await login(other, WRONG, '10.0.0.2')).status).toBe(401); // another email
    expect((await login(mine, PASSWORD, '10.0.0.3')).status).toBe(200); // another IP
  });

  it('uses the normalised email: another case or extra spaces share the counter', async () => {
    const email = newEmail();
    for (let i = 0; i < 5; i += 1) await login(email, WRONG, '10.0.0.2');

    const res = await login(`  ${email.toUpperCase()} `, PASSWORD, '10.0.0.2');

    expect(res.status).toBe(429);
  });

  it('starts counting again in the next window', async () => {
    const email = newEmail();
    await register(email, '10.0.0.1');
    for (let i = 0; i < 6; i += 1) await login(email, WRONG, '10.0.0.2');
    expect((await login(email, PASSWORD, '10.0.0.2')).status).toBe(429);

    nowMs = START + 15 * MINUTE - 1;
    expect((await login(email, PASSWORD, '10.0.0.2')).status).toBe(429);

    nowMs = START + 15 * MINUTE;
    expect((await login(email, PASSWORD, '10.0.0.2')).status).toBe(200);
  });

  it('does not count requests that fail validation', async () => {
    const email = newEmail();
    await register(email, '10.0.0.1');
    for (let i = 0; i < 10; i += 1) {
      const res = await post(
        '/api/auth/login',
        { email, password: 5 },
        '10.0.0.2',
      );
      expect(res.status).toBe(400);
    }

    for (let i = 0; i < 5; i += 1) {
      expect((await login(email, WRONG, '10.0.0.2')).status).toBe(401);
    }
    expect((await login(email, WRONG, '10.0.0.2')).status).toBe(429);
  });

  it('puts callers without an IP in one shared bucket (fails closed)', async () => {
    const email = newEmail();
    for (let i = 0; i < 5; i += 1) await login(email, WRONG);

    expect((await login(email, PASSWORD)).status).toBe(429);
    // The bucket is "unknown", not an IP that a caller could pick.
    expect((await login(email, WRONG, '10.0.0.9')).status).toBe(401);
  });
});

describe('POST /api/auth/register limit: 5 per hour per IP', () => {
  it('refuses the 6th registration from the same IP and creates no user', async () => {
    nowMs = START + 20 * MINUTE;
    for (let i = 0; i < 5; i += 1) {
      expect((await register(newEmail(), '10.0.1.1')).status).toBe(201);
    }
    const email = newEmail();

    const sixth = await register(email, '10.0.1.1');

    await expectRateLimited(sixth, String(40 * 60));
    expect(
      await count('select count(*) as n from users where email = $1', [email]),
    ).toBe(0);
  });

  it('does not limit other IPs, and counts again in the next hour', async () => {
    for (let i = 0; i < 6; i += 1) await register(newEmail(), '10.0.1.1');

    expect((await register(newEmail(), '10.0.1.2')).status).toBe(201);
    expect((await register(newEmail(), '10.0.1.1')).status).toBe(429);

    nowMs = START + 60 * MINUTE;
    expect((await register(newEmail(), '10.0.1.1')).status).toBe(201);
  });

  it('counts a registration that ends in 409 too', async () => {
    const email = newEmail();
    await register(email, '10.0.1.3');
    for (let i = 0; i < 4; i += 1) {
      expect((await register(email, '10.0.1.3')).status).toBe(409);
    }

    expect((await register(newEmail(), '10.0.1.3')).status).toBe(429);
  });

  it('puts callers without an IP in one shared bucket (fails closed)', async () => {
    for (let i = 0; i < 5; i += 1) await register();

    expect((await register()).status).toBe(429);
  });
});

describe('what the limiter stores', () => {
  it('never keeps an email: the login key holds its SHA-256, the register key only the IP', async () => {
    const email = newEmail();
    await register(email, '10.0.2.1');
    await login(email, PASSWORD, '10.0.2.2');

    const { rows } = await db.query('select key from rate_limits order by key');

    const keys = rows.map((row) => (row as { key: string }).key);
    expect(keys).toEqual([
      `login:10.0.2.2:${hashKeyPart(email)}`,
      'register:10.0.2.1',
    ]);
    expect(JSON.stringify(keys)).not.toContain('@');
    expect(JSON.stringify(keys)).not.toContain(email.split('@')[0]);
  });

  it('removes windows older than 2 days when a new one opens', async () => {
    await db.query(
      'insert into rate_limits (key, window_start, hits) values ($1, $2, 3)',
      ['login:old', new Date(START - 3 * 24 * 60 * MINUTE).toISOString()],
    );

    await login(newEmail(), WRONG, '10.0.3.1');

    const { rows } = await db.query('select key from rate_limits');
    expect(rows).toHaveLength(1);
    expect((rows[0] as { key: string }).key).toMatch(/^login:10\.0\.3\.1:/);
  });
});

describe('when the limiter cannot reach the database', () => {
  it('fails closed: login and register answer 500 and do nothing', async () => {
    const email = newEmail();
    await register(email, '10.0.4.1');
    const sessionsBefore = await sessionsOf(email);
    const flaky: Db = {
      query: (sql, params) =>
        sql.includes('rate_limits')
          ? Promise.reject(new Error('connection reset'))
          : db.query(sql, params),
    };
    const other = await listen(withTestIp(createApp({ db: flaky, clock })));
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const newcomer = newEmail();

    try {
      const loginRes = await post(
        '/api/auth/login',
        { email, password: PASSWORD },
        '10.0.4.2',
        other.baseUrl,
      );
      const registerRes = await post(
        '/api/auth/register',
        { email: newcomer, password: PASSWORD },
        '10.0.4.3',
        other.baseUrl,
      );

      for (const res of [loginRes, registerRes]) {
        expect(res.status).toBe(500);
        expect(res.headers.getSetCookie()).toEqual([]);
        const text = await res.text();
        expect(text).toContain('INTERNAL_ERROR');
        expect(text).not.toContain('connection reset');
      }
    } finally {
      consoleError.mockRestore();
      await close(other.server);
    }
    expect(await sessionsOf(email)).toBe(sessionsBefore);
    expect(
      await count('select count(*) as n from users where email = $1', [
        newcomer,
      ]),
    ).toBe(0);
  });
});
