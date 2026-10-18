// The limits of POST /api/demo/session: how many a person can open, how many can exist, the
// cleanup of expired ones, and the days the rates do not cover.
import type { Server } from 'node:http';
import express, { type Express } from 'express';
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
import { createApp } from '../app.ts';
import type { Db } from '../db/client.ts';
import { createTestDb, type TestDb } from '../db/test-db.ts';
import type { Clock } from '../domain/dates.ts';
import { close, listen } from '../test-utils.ts';
import { seedTestRates } from './test-app.ts';

const HOUR = 60 * 60 * 1000;
const START = Date.parse('2026-10-18T10:00:00Z'); // the start of a 1 hour window

let nowMs = START;
const clock: Clock = { now: () => new Date(nowMs) };
// When set, a statement that starts with this text fails (to test a failing cleanup).
let failing: { prefix: string; error: Error } | null = null;

let db: TestDb;
let server: Server;
let baseUrl: string;

// Lets a test choose the caller's IP with the x-test-ip header (test-only plumbing).
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
  await seedTestRates(db);
  const appDb: Db = {
    query: (sql, params) =>
      failing && sql.trimStart().startsWith(failing.prefix)
        ? Promise.reject(failing.error)
        : db.query(sql, params),
  };
  ({ server, baseUrl } = await listen(
    withTestIp(createApp({ db: appDb, clock })),
  ));
}, 30_000);
afterAll(async () => {
  await close(server);
  await db.close();
});
beforeEach(async () => {
  nowMs = START;
  failing = null;
  await db.query('delete from rate_limits');
  await db.query('delete from users');
});
afterEach(() => {
  vi.restoreAllMocks();
});

const open = (ip?: string, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}/api/demo/session`, {
    method: 'POST',
    headers: { ...(ip === undefined ? {} : { 'x-test-ip': ip }), ...headers },
  });

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.query(sql, params);
  return (rows[0] as { n: number }).n;
}
const demoUsers = () =>
  count('select count(*)::int as n from users where is_demo');
const insertDemoUsers = (n: number, expiresAt: number) =>
  db.query(
    'insert into users (is_demo, expires_at) select true, $2 from generate_series(1, $1::int)',
    [n, new Date(expiresAt).toISOString()],
  );

describe('the limit per IP: 10 per hour', () => {
  it('refuses the 11th with 429 and Retry-After, opens nothing, and does not touch other IPs', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await open('10.0.0.1')).status).toBe(201);
    }

    const refused = await open('10.0.0.1');

    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('3600'); // the window started at 10:00
    expect(refused.headers.getSetCookie()).toEqual([]);
    expect(await refused.json()).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests, try again later',
        request_id: refused.headers.get('x-request-id'),
      },
    });
    expect(await demoUsers()).toBe(10);
    expect((await open('10.0.0.2')).status).toBe(201);
    expect(await demoUsers()).toBe(11);
  });

  it('opens again when the hour is over', async () => {
    for (let i = 0; i < 11; i += 1) await open('10.0.0.3');
    expect((await open('10.0.0.3')).status).toBe(429);

    nowMs = START + HOUR;

    expect((await open('10.0.0.3')).status).toBe(201);
  });
});

describe('at most 200 sandboxes alive at once', () => {
  it('answers 503 DEMO_FULL with 200 active, and creates nothing', async () => {
    await insertDemoUsers(200, START + HOUR);

    const res = await open('10.1.0.1');

    expect(res.status).toBe(503);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await res.json()).toMatchObject({
      error: {
        code: 'DEMO_FULL',
        message: 'The demo is full right now, try again later',
      },
    });
    expect(await demoUsers()).toBe(200);
    expect(await count('select count(*)::int as n from sessions')).toBe(0);
  });

  it('lets the 200th in and refuses the 201st', async () => {
    await insertDemoUsers(199, START + HOUR);

    expect((await open('10.1.0.2')).status).toBe(201);
    expect((await open('10.1.0.3')).status).toBe(503);
    expect(await demoUsers()).toBe(200);
  });

  it('frees the places when the sandboxes expire (one expiring exactly now is expired)', async () => {
    await insertDemoUsers(200, START + HOUR);
    expect((await open('10.1.0.4')).status).toBe(503);

    nowMs = START + HOUR;

    expect((await open('10.1.0.5')).status).toBe(201);
    expect(
      await count(
        'select count(*)::int as n from users where is_demo and expires_at > $1',
        [new Date(nowMs).toISOString()],
      ),
    ).toBe(1);
  });
});

describe('the cleanup of expired sandboxes', () => {
  it('deletes at most 100 expired ones per request, with their data, and never a real user', async () => {
    const first = await open('10.2.0.1');
    expect(first.status).toBe(201);
    await db.query(
      "insert into users (email, password_hash) values ('kept@example.com', 'hash')",
    );
    await insertDemoUsers(149, START - HOUR); // expired
    nowMs = START + 25 * HOUR; // the first sandbox has expired too: 150 expired, 0 alive

    expect((await open('10.2.0.2')).status).toBe(201);

    // 150 expired - 100 deleted + 1 new alive one
    expect(await demoUsers()).toBe(51);
    expect(
      await count(
        'select count(*)::int as n from users where is_demo and expires_at <= $1',
        [new Date(nowMs).toISOString()],
      ),
    ).toBe(50);
    expect(
      await count(
        "select count(*)::int as n from users where email = 'kept@example.com'",
      ),
    ).toBe(1);
    // The oldest go first, so the first sandbox (the newest of the expired ones) still has its
    // rows. It goes with the next batch, and its rows go with it.
    expect(await count('select count(*)::int as n from invoices')).toBe(14 * 2);
    expect((await open('10.2.0.3')).status).toBe(201);
    expect((await open('10.2.0.4')).status).toBe(201);
    expect(await demoUsers()).toBe(3);
    expect(await count('select count(*)::int as n from invoices')).toBe(14 * 3);
  });

  it('never fails the request when the cleanup fails, and logs only the error name and the request id', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    failing = {
      prefix: 'delete from users',
      error: Object.assign(new Error('secret-host.example password=hunter2'), {
        name: 'FakeDbError',
      }),
    };

    const res = await open('10.2.1.1');

    expect(res.status).toBe(201);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({
      level: 'error',
      request_id: res.headers.get('x-request-id'),
      error_name: 'FakeDbError',
    });
    expect(line).not.toContain('hunter2');
  });
});

describe('a sandbox without a session', () => {
  it('is removed again when its session cannot be created, and the visitor gets a 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    failing = {
      prefix: 'insert into sessions',
      error: new Error('sessions are down'),
    };

    const res = await open('10.2.2.1');

    expect(res.status).toBe(500);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await demoUsers()).toBe(0);
    expect(await count('select count(*)::int as n from invoices')).toBe(0);
  });
});

describe('the days the verified rates do not cover', () => {
  it('builds the demo around the last verified day, so the data never leaves the window', async () => {
    nowMs = Date.parse('2027-03-01T10:00:00Z'); // the rates end on 2026-12-31

    const res = await open('10.3.0.1');

    expect(res.status).toBe(201);
    const { rows } = await db.query(
      `select count(*) filter (where due_date < '2026-12-31')::int as overdue,
              count(*) filter (where due_date > '2026-12-31')::int as not_due,
              bool_and(issue_date <= '2026-12-31') as issued_in_window
         from invoices`,
    );
    expect(rows).toEqual([{ overdue: 11, not_due: 3, issued_in_window: true }]);
  });

  it('answers 503 DEMO_UNAVAILABLE when there is no verified rate, and creates nothing', async () => {
    const empty = await createTestDb(); // migrated but without rates
    const own = await listen(createApp({ db: empty, clock }));
    try {
      const res = await fetch(`${own.baseUrl}/api/demo/session`, {
        method: 'POST',
      });

      expect(res.status).toBe(503);
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(await res.json()).toMatchObject({
        error: { code: 'DEMO_UNAVAILABLE' },
      });
      const { rows } = await empty.query(
        'select count(*)::int as n from users',
      );
      expect(rows).toEqual([{ n: 0 }]);
    } finally {
      await close(own.server);
      await empty.close();
    }
  }, 30_000);
});

describe('the origin guard still applies', () => {
  it('refuses a cross-site request with 403 and opens nothing', async () => {
    const res = await open('10.4.0.1', { 'Sec-Fetch-Site': 'cross-site' });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: { code: 'FORBIDDEN_ORIGIN' },
    });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await demoUsers()).toBe(0);
  });
});
