// Shared by the route tests: the real app on a real HTTP port, over an in-memory Postgres with the
// verified rates loaded and a clock the test can move.
import { readFileSync } from 'node:fs';
import type { Express } from 'express';
import { createApp } from '../app.ts';
import { generateToken, hashToken, SESSION_COOKIE } from '../auth/session.ts';
import type { Db } from '../db/client.ts';
import { seedRates } from '../db/rates-seed.ts';
import { createSession } from '../db/sessions.ts';
import { createTestDb, type TestDb } from '../db/test-db.ts';
import { createUserWithProfile } from '../db/users.ts';
import type { Clock } from '../domain/dates.ts';
import { parseRates } from '../domain/rates.ts';
import { close, listen } from '../test-utils.ts';

const RATES_FILE = new URL(
  '../../data/legal-interest-rates.json',
  import.meta.url,
);
const DAY_MS = 24 * 60 * 60 * 1000;

// The verified rates of data/legal-interest-rates.json (what `npm run rates:seed` loads).
export const seedTestRates = (db: TestDb) =>
  seedRates(db, parseRates(JSON.parse(readFileSync(RATES_FILE, 'utf8'))));

export interface TestUser {
  id: string;
  cookie: string;
}

export interface Answer {
  status: number;
  headers: Headers;
  text: string;
  bytes: Buffer; // the body as it came, for the PDF
  json: unknown; // undefined for an empty body (204) and for a PDF
}

// The shapes the API sends, as the tests read them.
export interface PaymentJson {
  id: string;
  invoice_id: string;
  paid_on: string;
  amount_cents: number;
}

export interface InvoiceJson {
  id: string;
  debtor_id: string;
  number: string;
  issue_date: string;
  due_date: string | null;
  amount_cents: number;
  agreed_rate_bp: number | null;
  status: 'OPEN' | 'PAID' | 'DISPUTED';
  paid_cents: number;
  balance_cents: number;
  due_date_effective: string | null;
  due_date_estimated: boolean;
  overdue: boolean;
  days_overdue: number;
  interest_cents: number | null;
  interest_error: 'RATE_WINDOW' | 'CALCULATION_FAILED' | null;
  payments?: PaymentJson[];
}

export interface DebtorJson {
  id: string;
  name: string;
  tax_id: string | null;
  email: string | null;
  kind: string;
  invoice_count: number;
  open_invoice_count: number;
  outstanding_cents: number;
}

export interface ErrorJson {
  code: string;
  message: string;
  request_id: string;
  details?: unknown;
}

export const errorOf = (answer: Answer): ErrorJson =>
  (answer.json as { error: ErrorJson }).error;
export const dataOf = (answer: Answer): Record<string, unknown> =>
  (answer.json as { data: Record<string, unknown> }).data;
export const invoiceOf = (answer: Answer): InvoiceJson =>
  (answer.json as { data: { invoice: InvoiceJson } }).data.invoice;

export interface TestApp {
  app: Express;
  db: TestDb;
  baseUrl: string;
  setNow(iso: string): void;
  makeUser(): Promise<TestUser>;
  call(
    user: TestUser | null,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Answer>;
  stop(): Promise<void>;
}

// `now` is a UTC instant. 2026-10-30T10:00:00Z is 2026-10-30 in Madrid (UTC+1 since 25 October).
export async function startTestApp({
  now = '2026-10-30T10:00:00Z',
  statements,
}: {
  now?: string;
  // When given, every SQL text the app sends to the database is pushed here.
  statements?: string[];
} = {}): Promise<TestApp> {
  let nowMs = Date.parse(now);
  const clock: Clock = { now: () => new Date(nowMs) };
  const db = await createTestDb();
  await seedTestRates(db);
  const appDb: Db = statements
    ? {
        query: (sql, params) => {
          statements.push(sql);
          return db.query(sql, params);
        },
      }
    : db;
  const app = createApp({ db: appDb, clock });
  const { server, baseUrl } = await listen(app);
  let counter = 0;

  return {
    app,
    db,
    baseUrl,
    setNow: (iso) => {
      nowMs = Date.parse(iso);
    },
    // Created straight in the database: no password hashing per user.
    async makeUser() {
      counter += 1;
      const user = await createUserWithProfile(
        db,
        `user${String(counter)}@example.com`,
        'fake-hash',
      );
      if (!user) throw new Error('duplicate test e-mail');
      const token = generateToken();
      await createSession(
        db,
        hashToken(token),
        user.id,
        new Date(nowMs + DAY_MS),
      );
      return { id: user.id, cookie: `${SESSION_COOKIE}=${token}` };
    },
    async call(user, method, path, body) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(user ? { Cookie: user.cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const bytes = Buffer.from(await res.arrayBuffer());
      const text = bytes.toString('utf8');
      const isPdf = res.headers.get('content-type') === 'application/pdf';
      return {
        status: res.status,
        headers: res.headers,
        text,
        bytes,
        json: text === '' || isPdf ? undefined : (JSON.parse(text) as unknown),
      };
    },
    async stop() {
      await close(server);
      await db.close();
    },
  };
}
