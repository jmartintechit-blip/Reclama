import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateToken, hashToken, SESSION_COOKIE } from '../auth/session.ts';
import { createApp } from '../app.ts';
import type { Db } from '../db/client.ts';
import { findOrCreateDebtor, updateDebtor } from '../db/debtors.ts';
import { hashKeyPart } from '../db/rate-limits.ts';
import { createSession } from '../db/sessions.ts';
import { createTestDb, type TestDb } from '../db/test-db.ts';
import { createUserWithProfile } from '../db/users.ts';
import { MAX_INVOICES_PER_USER } from '../db/invoices.ts';
import { MAX_CSV_BYTES } from '../domain/csv-import.ts';
import type { Clock } from '../domain/dates.ts';
import { close, listen } from '../test-utils.ts';
import { IMPORT_BODY_LIMIT_BYTES } from './imports.ts';

const START = Date.parse('2026-10-14T10:00:00Z'); // the start of a 1 hour window
const HOUR = 60 * 60 * 1000;
const SAMPLE = readFileSync(
  fileURLToPath(new URL('../../data/sample-invoices.csv', import.meta.url)),
);

let nowMs = START;
const clock: Clock = { now: () => new Date(nowMs) };

let db: TestDb;
let server: Server;
let baseUrl: string;
let counter = 0;

// Every statement that reaches the database through the second app, in order.
const statements: string[] = [];
let spyServer: Server;
let spyBaseUrl: string;

beforeAll(async () => {
  db = await createTestDb();
  ({ server, baseUrl } = await listen(createApp({ db, clock })));
  const spyDb: Db = {
    query: (sql, params) => {
      statements.push(sql);
      return db.query(sql, params);
    },
  };
  ({ server: spyServer, baseUrl: spyBaseUrl } = await listen(
    createApp({ db: spyDb, clock }),
  ));
}, 30_000);

afterAll(async () => {
  await close(server);
  await close(spyServer);
  await db.close();
});

beforeEach(async () => {
  nowMs = START;
  statements.length = 0;
  await db.query('delete from rate_limits');
});

interface TestUser {
  id: string;
  cookie: string;
}

// A user with a session, created directly in the database (no argon2 per user).
async function makeUser(): Promise<TestUser> {
  counter += 1;
  const user = await createUserWithProfile(
    db,
    `import${String(counter)}@example.com`,
    'fake-hash',
  );
  if (!user) throw new Error('duplicate test e-mail');
  const token = generateToken();
  await createSession(
    db,
    hashToken(token),
    user.id,
    new Date(START + 24 * HOUR),
  );
  return { id: user.id, cookie: `${SESSION_COOKIE}=${token}` };
}

const base64 = (bytes: string | Buffer) =>
  Buffer.from(bytes).toString('base64');

async function post(
  body: unknown,
  {
    cookie,
    query = '',
    url = baseUrl,
    path = '/api/imports',
  }: { cookie?: string; query?: string; url?: string; path?: string } = {},
) {
  const res = await fetch(`${url}${path}${query}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie === undefined ? {} : { Cookie: cookie }),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    text,
    json: JSON.parse(text) as unknown,
  };
}

interface ImportData {
  dry_run: boolean;
  rows_total: number;
  rows_valid: number;
  debtors_created: number;
  invoices_created: number;
  invoices_already_imported: number;
  errors: { row: number; field: string | null; code: string }[];
  warnings: { row: number; field: string | null; code: string }[];
  delimiter: string;
  encoding: string;
  preview?: Record<string, unknown>[];
}

// Posts a file and returns the `data` of a 200 answer.
async function importCsv(
  user: TestUser,
  bytes: string | Buffer,
  { dry_run, query }: { dry_run?: boolean; query?: string } = {},
): Promise<ImportData> {
  const res = await post(
    {
      csv_base64: base64(bytes),
      ...(dry_run === undefined ? {} : { dry_run }),
    },
    { cookie: user.cookie, query },
  );
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return (res.json as { data: ImportData }).data;
}

interface ErrorBody {
  error: {
    code: string;
    message: string;
    request_id: string;
    details?: unknown;
  };
}

async function count(table: 'debtors' | 'invoices', userId?: string) {
  const { rows } = await db.query(
    `select count(*)::int as n from ${table} where $1::uuid is null or user_id = $1`,
    [userId ?? null],
  );
  return (rows[0] as { n: number }).n;
}

const HEADER =
  'Factura;Cliente;NIF/CIF;Email;Fecha emisión;Vencimiento;Importe';
const csv = (...lines: string[]) => [HEADER, ...lines].join('\n');

// What Excel in Spanish writes: windows-1252, where "€" is 0x80 and the rest is Latin-1.
const windows1252 = (text: string) =>
  Buffer.from(
    Array.from(text, (char) => (char === '€' ? 0x80 : char.charCodeAt(0))),
  );

describe('POST /api/imports dry run', () => {
  it('reports what would happen for the sample file and writes nothing', async () => {
    const user = await makeUser();
    const debtorsBefore = await count('debtors');
    const invoicesBefore = await count('invoices');

    const data = await importCsv(user, SAMPLE, { dry_run: true });

    expect(data).toMatchObject({
      dry_run: true,
      rows_total: 11,
      rows_valid: 11,
      debtors_created: 6,
      invoices_created: 11,
      invoices_already_imported: 0,
      errors: [],
      warnings: [],
      delimiter: ';',
      encoding: 'utf-8',
    });
    expect(data.preview).toHaveLength(11);
    expect(data.preview?.[0]).toEqual({
      row: 2,
      number: 'F-2026-001',
      debtor_name: 'Talleres Ejemplo S.L.',
      tax_id: 'B00000001',
      email: 'talleres@example.com',
      issue_date: '2026-01-15',
      due_date: '2026-02-14',
      amount_cents: 123456,
      already_imported: false,
    });
    expect(await count('debtors')).toBe(debtorsBefore);
    expect(await count('invoices')).toBe(invoicesBefore);
  });

  it('is a dry run when the body says so, when the query says so, or both', async () => {
    const user = await makeUser();

    expect((await importCsv(user, SAMPLE, { dry_run: true })).dry_run).toBe(
      true,
    );
    expect(
      (await importCsv(user, SAMPLE, { query: '?dry_run=true' })).dry_run,
    ).toBe(true);
    expect(
      (
        await importCsv(user, SAMPLE, {
          dry_run: false,
          query: '?dry_run=true',
        })
      ).dry_run,
    ).toBe(true);
    expect(await count('invoices', user.id)).toBe(0);

    // Neither one: a real import. An explicit false in both places is the same.
    const real = await importCsv(user, SAMPLE, {
      dry_run: false,
      query: '?dry_run=false',
    });
    expect(real.dry_run).toBe(false);
    expect(real.preview).toBeUndefined();
    expect(await count('invoices', user.id)).toBe(11);
  });

  it('limits the preview to 20 rows but counts every row', async () => {
    const user = await makeUser();
    const rows = Array.from(
      { length: 25 },
      (_, i) => `P-${String(i)};Cliente ${String(i)};;;01/01/2026;;10,00`,
    );

    const data = await importCsv(user, csv(...rows), { dry_run: true });

    expect(data.rows_valid).toBe(25);
    expect(data.invoices_created).toBe(25);
    expect(data.preview).toHaveLength(20);
  });

  it('marks what already exists after a real import', async () => {
    const user = await makeUser();
    await importCsv(user, SAMPLE);

    const data = await importCsv(user, SAMPLE, { dry_run: true });

    expect(data).toMatchObject({
      debtors_created: 0,
      invoices_created: 0,
      invoices_already_imported: 11,
    });
    expect(data.preview?.every((row) => row.already_imported === true)).toBe(
      true,
    );
  });
});

describe('POST /api/imports real import', () => {
  it('creates the debtors and invoices of the sample file with exact cents and dates', async () => {
    const user = await makeUser();

    const data = await importCsv(user, SAMPLE);

    expect(data).toMatchObject({
      dry_run: false,
      rows_total: 11,
      rows_valid: 11,
      debtors_created: 6,
      invoices_created: 11,
      invoices_already_imported: 0,
      errors: [],
    });
    expect(await count('debtors', user.id)).toBe(6);
    expect(await count('invoices', user.id)).toBe(11);

    const { rows } = await db.query(
      `select i.number, i.issue_date, i.due_date, i.amount_cents, i.status,
              d.name, d.tax_id, d.email, d.kind
         from invoices i join debtors d on d.user_id = i.user_id and d.id = i.debtor_id
        where i.user_id = $1 order by i.number`,
      [user.id],
    );
    const byNumber = new Map(
      (rows as { number: string }[]).map((row) => [row.number, row]),
    );
    expect(byNumber.get('F-2026-001')).toEqual({
      number: 'F-2026-001',
      issue_date: '2026-01-15',
      due_date: '2026-02-14',
      amount_cents: 123456,
      status: 'OPEN',
      name: 'Talleres Ejemplo S.L.',
      tax_id: 'B00000001',
      email: 'talleres@example.com',
      kind: 'UNKNOWN',
    });
    expect(byNumber.get('F-2026-002')).toMatchObject({
      due_date: null, // no due date in the file: the interest engine estimates it later
      amount_cents: 245000,
    });
    expect(byNumber.get('F-2026-007')).toMatchObject({
      amount_cents: 1532075,
      name: 'Ayuntamiento de Villaejemplo',
    });
    expect(byNumber.get('F-2026-005')).toMatchObject({
      name: 'Muñoz y Peña Pruebas S.L.',
      email: null,
    });

    // Nobody is classified automatically: the public administration and the consumer stay UNKNOWN.
    const { rows: kinds } = await db.query(
      `select distinct kind from debtors where user_id = $1`,
      [user.id],
    );
    expect(kinds).toEqual([{ kind: 'UNKNOWN' }]);
  });

  it('is idempotent: the same file again creates nothing', async () => {
    const user = await makeUser();
    await importCsv(user, SAMPLE);

    const again = await importCsv(user, SAMPLE);

    expect(again).toMatchObject({
      rows_valid: 11,
      debtors_created: 0,
      invoices_created: 0,
      invoices_already_imported: 11,
    });
    expect(await count('debtors', user.id)).toBe(6);
    expect(await count('invoices', user.id)).toBe(11);
  });

  it('adds only the new invoices when a file grows', async () => {
    const user = await makeUser();
    await importCsv(user, csv('G-1;Acme S.L.;B11111111;;01/01/2026;;10,00'));

    const data = await importCsv(
      user,
      csv(
        'G-1;Acme S.L.;B11111111;;01/01/2026;;10,00',
        'G-2;Acme S.L.;B11111111;;02/01/2026;;20,00',
      ),
    );

    expect(data).toMatchObject({
      debtors_created: 0,
      invoices_created: 1,
      invoices_already_imported: 1,
    });
  });

  it('never overwrites an existing invoice with the values of the file', async () => {
    const user = await makeUser();
    await importCsv(user, csv('H-1;Acme S.L.;;;01/01/2026;;10,00'));

    await importCsv(user, csv('H-1;Acme S.L.;;;05/05/2026;;999,00'));

    const { rows } = await db.query(
      'select issue_date, amount_cents from invoices where user_id = $1',
      [user.id],
    );
    expect(rows).toEqual([{ issue_date: '2026-01-01', amount_cents: 1000 }]);
  });

  it('reuses an existing debtor and keeps its stored data', async () => {
    const user = await makeUser();
    const debtor = await findOrCreateDebtor(db, user.id, {
      name: 'TALLERES EJEMPLO s.l.',
      tax_id: 'b-00000001',
    });
    await updateDebtor(db, user.id, debtor.id, {
      kind: 'BUSINESS',
      email: 'kept@example.com',
    });

    const data = await importCsv(user, SAMPLE);

    expect(data.debtors_created).toBe(5);
    expect(await count('debtors', user.id)).toBe(6);
    const { rows } = await db.query(
      'select name, email, kind from debtors where id = $1',
      [debtor.id],
    );
    expect(rows).toEqual([
      {
        name: 'TALLERES EJEMPLO s.l.',
        email: 'kept@example.com',
        kind: 'BUSINESS',
      },
    ]);
    const { rows: invoices } = await db.query(
      'select count(*)::int as n from invoices where debtor_id = $1',
      [debtor.id],
    );
    expect(invoices).toEqual([{ n: 2 }]);
  });

  it('gives a new debtor the first e-mail the file has for it', async () => {
    const user = await makeUser();

    await importCsv(
      user,
      csv(
        'E-1;Acme S.L.;;;01/01/2026;;10,00',
        'E-2;ACME s.l.;;first@example.com;01/01/2026;;10,00',
        'E-3;Acme S.L.;;second@example.com;01/01/2026;;10,00',
      ),
    );

    const { rows } = await db.query(
      'select name, email from debtors where user_id = $1',
      [user.id],
    );
    expect(rows).toEqual([{ name: 'Acme S.L.', email: 'first@example.com' }]);
  });

  it('decodes a windows-1252 file as Excel in Spanish writes it', async () => {
    const user = await makeUser();
    const file = windows1252(
      csv('A-1;Peña & Niño 10€ S.L.;B22222222;;01/02/2026;;1.234,56'),
    );
    expect(file.includes(0xf1)).toBe(true); // ñ is one byte, so this is not valid UTF-8
    expect(file.includes(0x80)).toBe(true);

    const data = await importCsv(user, file);

    expect(data).toMatchObject({
      encoding: 'windows-1252',
      invoices_created: 1,
    });
    const { rows } = await db.query(
      `select d.name, i.amount_cents from invoices i
         join debtors d on d.user_id = i.user_id and d.id = i.debtor_id
        where i.user_id = $1`,
      [user.id],
    );
    expect(rows).toEqual([
      { name: 'Peña & Niño 10€ S.L.', amount_cents: 123456 },
    ]);
  });

  it('reports row errors with their line numbers and still imports the valid rows', async () => {
    const user = await makeUser();
    const file = csv(
      'R-1;Acme S.L.;;;01/01/2026;;10,00', // line 2: valid
      'R-2;Acme S.L.;;;01/01/2026;;abc', // line 3: bad amount
      'R-3;Acme S.L.;;;02/01/2026;;30,00', // line 4: valid
      'R-4;Acme S.L.;;;31/02/2026;;40,00', // line 5: not a real date
      '', // line 6: blank
      ';Acme S.L.;;;01/01/2026;;50,00', // line 7: no invoice number
    );

    const data = await importCsv(user, file);

    expect(data).toMatchObject({
      rows_total: 5,
      rows_valid: 2,
      debtors_created: 1,
      invoices_created: 2,
    });
    expect(data.errors).toMatchObject([
      { row: 3, field: 'amount', code: 'AMOUNT_INVALID_FORMAT' },
      { row: 5, field: 'issueDate', code: 'INVALID_DATE' },
      { row: 7, field: 'number', code: 'REQUIRED' },
    ]);
    const { rows } = await db.query(
      'select number from invoices where user_id = $1 order by number',
      [user.id],
    );
    expect(rows).toEqual([{ number: 'R-1' }, { number: 'R-3' }]);
  });

  it('stores text that looks like a formula unchanged and flags it', async () => {
    const user = await makeUser();

    const data = await importCsv(
      user,
      csv('@F-1;=2+5 S.L.;;+tag@example.com;01/01/2026;;10,00'),
    );

    expect(data.invoices_created).toBe(1);
    expect(data.warnings).toMatchObject([
      { row: 2, field: 'number', code: 'FORMULA_PREFIX' },
      { row: 2, field: 'debtorName', code: 'FORMULA_PREFIX' },
      { row: 2, field: 'email', code: 'FORMULA_PREFIX' },
    ]);
    const { rows } = await db.query(
      `select i.number, d.name, d.email from invoices i
         join debtors d on d.user_id = i.user_id and d.id = i.debtor_id
        where i.user_id = $1`,
      [user.id],
    );
    expect(rows).toEqual([
      { number: '@F-1', name: '=2+5 S.L.', email: '+tag@example.com' },
    ]);
  });

  it('stores quotes, braces, backslashes and the word NULL exactly as written', async () => {
    const user = await makeUser();
    const name = 'Bar "El Rincón", {Sur} \\ S.L.';
    const number = 'N-"1"\\2,{x}';

    await importCsv(
      user,
      csv(
        `"${number.replaceAll('"', '""')}";"${name.replaceAll('"', '""')}";;;01/01/2026;;10,00`,
        'NULL-1;NULL;;;01/01/2026;;10,00',
      ),
    );

    const { rows } = await db.query(
      `select i.number, d.name from invoices i
         join debtors d on d.user_id = i.user_id and d.id = i.debtor_id
        where i.user_id = $1 order by i.number`,
      [user.id],
    );
    expect(rows).toEqual([
      { number: 'N-"1"\\2,{x}', name },
      { number: 'NULL-1', name: 'NULL' },
    ]);
  });

  it('runs a fixed number of statements for 500 rows', async () => {
    const user = await makeUser();
    const rows = Array.from(
      { length: 500 },
      (_, i) =>
        `S-${String(i)};Cliente ${String(i % 100)} S.L.;;;01/01/2026;31/01/2026;${String(100 + i)},50`,
    );
    const file = csv(...rows);

    const real = await post(
      { csv_base64: base64(file) },
      { cookie: user.cookie, url: spyBaseUrl },
    );

    expect((real.json as { data: ImportData }).data).toMatchObject({
      rows_valid: 500,
      debtors_created: 100,
      invoices_created: 500,
    });
    // Two inserts for the whole file; the rest is the session lookup, the rate limit, and the
    // preview and the invoice count that the invoice limit needs.
    expect(
      statements.filter((sql) => /insert into debtors/.test(sql)),
    ).toHaveLength(1);
    expect(
      statements.filter((sql) => /insert into invoices/.test(sql)),
    ).toHaveLength(1);
    expect(statements.length).toBeLessThanOrEqual(8);
    expect(await count('invoices', user.id)).toBe(500);

    // A dry run is one read and no insert.
    statements.length = 0;
    await post(
      { csv_base64: base64(file), dry_run: true },
      { cookie: user.cookie, url: spyBaseUrl },
    );
    expect(
      statements.filter((sql) => /insert into (debtors|invoices)/.test(sql)),
    ).toHaveLength(0);
    expect(statements.filter((sql) => /unnest/.test(sql))).toHaveLength(1);
    expect(statements.length).toBeLessThanOrEqual(5);
  });
});

describe('POST /api/imports fatal problems', () => {
  // The marker sits in a data cell: it must never come back in an error.
  const MARKER = 'SECRETMARKER';
  const rows501 = Array.from(
    { length: 501 },
    (_, i) => `T-${String(i)};${MARKER} ${String(i)};;;01/01/2026;;10,00`,
  );

  it.each([
    ['CSV_EMPTY', 422, Buffer.from(HEADER), undefined],
    [
      'CSV_MISSING_COLUMNS',
      422,
      Buffer.from(`Factura;Cliente;Importe\nM-1;${MARKER};10,00`),
      { missing: ['issueDate'] },
    ],
    [
      'CSV_DUPLICATE_COLUMNS',
      422,
      Buffer.from(
        `Factura;Cliente;Fecha;Importe;Total\nD-1;${MARKER};01/01/2026;10,00;10,00`,
      ),
      { duplicated: ['amount'] },
    ],
    [
      'CSV_MALFORMED',
      422,
      Buffer.from(csv(`Q-1;"${MARKER} never closed;;;01/01/2026;;10,00`)),
      undefined,
    ],
    ['TOO_MANY_ROWS', 422, Buffer.from(csv(...rows501)), { limit: 500 }],
    [
      'CSV_TOO_LARGE',
      413,
      Buffer.concat([
        Buffer.from(csv(`L-1;${MARKER};;;01/01/2026;;10,00\n`)),
        Buffer.alloc(MAX_CSV_BYTES, ' '),
      ]),
      { limit: MAX_CSV_BYTES },
    ],
  ])(
    'answers %s with %i, the standard error shape and no file content',
    async (code, status, file, details) => {
      const user = await makeUser();
      const debtorsBefore = await count('debtors');

      const res = await post(
        { csv_base64: base64(file) },
        { cookie: user.cookie },
      );

      expect(res.status).toBe(status);
      const { error } = res.json as ErrorBody;
      expect(error.code).toBe(code);
      expect(error.request_id).toBe(res.headers.get('x-request-id'));
      expect(error.details).toEqual(details);
      expect(res.text).not.toContain(MARKER);
      expect(await count('debtors')).toBe(debtorsBefore);
    },
  );

  it('answers an empty string as CSV_EMPTY', async () => {
    const user = await makeUser();

    const res = await post({ csv_base64: '' }, { cookie: user.cookie });

    expect(res.status).toBe(422);
    expect((res.json as ErrorBody).error.code).toBe('CSV_EMPTY');
  });
});

describe('POST /api/imports validation', () => {
  const SENT = 'SECRETMARKER!!';

  it.each([
    ['invalid characters', { csv_base64: SENT }],
    ['wrong padding', { csv_base64: 'QUJDRA=' }],
    ['no padding where it is needed', { csv_base64: 'QUJDRA' }],
    ['the URL-safe alphabet', { csv_base64: 'QU-_' }],
    ['line breaks inside the base64', { csv_base64: 'QUJD\nRA==' }],
    ['a missing csv_base64', {}],
    ['a number as csv_base64', { csv_base64: 12345 }],
    ['null as csv_base64', { csv_base64: null }],
    ['a string as dry_run', { csv_base64: 'QUJD', dry_run: 'yes' }],
    ['a number as dry_run', { csv_base64: 'QUJD', dry_run: 1 }],
    ['an array as the body', [SENT]],
  ])(
    'answers 400 VALIDATION_ERROR for %s without echoing the input',
    async (_name, body) => {
      const user = await makeUser();

      const res = await post(body, { cookie: user.cookie });

      expect(res.status).toBe(400);
      const { error } = res.json as ErrorBody;
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(Array.isArray(error.details)).toBe(true);
      expect(res.text).not.toContain(SENT);
      expect(res.text).not.toContain('12345');
    },
  );

  it('refuses a body that is a bare string, without echoing it', async () => {
    const user = await makeUser();

    const res = await post(SENT, { cookie: user.cookie });

    expect(res.status).toBe(400); // the JSON parser is strict: only objects and arrays
    expect(res.text).not.toContain(SENT);
  });

  it('refuses a dry_run query that is not true or false', async () => {
    const user = await makeUser();

    for (const query of [
      '?dry_run=maybe',
      '?dry_run=1',
      '?dry_run=true&dry_run=false',
    ]) {
      const res = await post(
        { csv_base64: base64(SAMPLE) },
        { cookie: user.cookie, query },
      );
      expect(res.status, query).toBe(400);
      expect((res.json as ErrorBody).error.code).toBe('VALIDATION_ERROR');
    }
    expect(await count('invoices', user.id)).toBe(0);
  });

  it('ignores keys it does not know', async () => {
    const user = await makeUser();
    const stranger = await makeUser();

    const res = await post(
      { csv_base64: base64(SAMPLE), user_id: stranger.id, userId: stranger.id },
      { cookie: user.cookie },
    );

    expect(res.status).toBe(200);
    expect(await count('invoices', user.id)).toBe(11);
    expect(await count('invoices', stranger.id)).toBe(0);
  });
});

describe('POST /api/imports authentication', () => {
  it('answers 401 without a session, with a garbage session, and writes nothing', async () => {
    const body = { csv_base64: base64(SAMPLE) };
    const debtorsBefore = await count('debtors');

    const anonymous = await post(body);
    const garbage = await post(body, {
      cookie: `${SESSION_COOKIE}=${generateToken()}`,
    });

    for (const res of [anonymous, garbage]) {
      expect(res.status).toBe(401);
      expect((res.json as ErrorBody).error.code).toBe('UNAUTHENTICATED');
    }
    expect(await count('debtors')).toBe(debtorsBefore);
  });
});

describe('POST /api/imports isolation between users', () => {
  it('gives every user their own copy of the same file', async () => {
    const a = await makeUser();
    const b = await makeUser();

    const first = await importCsv(a, SAMPLE);
    const second = await importCsv(b, SAMPLE);

    expect(first).toMatchObject({ debtors_created: 6, invoices_created: 11 });
    expect(second).toMatchObject({
      debtors_created: 6,
      invoices_created: 11,
      invoices_already_imported: 0,
    });
    expect(await count('invoices', a.id)).toBe(11);
    expect(await count('invoices', b.id)).toBe(11);
    expect(await count('invoices')).toBeGreaterThanOrEqual(22);
    const { rows } = await db.query(
      `select count(*)::int as n from invoices i
         join debtors d on d.id = i.debtor_id where d.user_id <> i.user_id`,
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('lets another user use the same invoice number without touching the first one', async () => {
    const a = await makeUser();
    const b = await makeUser();
    await importCsv(
      a,
      csv('X-1;Acme S.L.;B33333333;a@example.com;01/01/2026;;10,00'),
    );

    const data = await importCsv(
      b,
      csv('X-1;Acme S.L.;B33333333;b@example.com;02/02/2026;;99,00'),
    );

    expect(data).toMatchObject({
      debtors_created: 1,
      invoices_created: 1,
      invoices_already_imported: 0,
    });
    const { rows } = await db.query(
      `select i.user_id, i.amount_cents, i.issue_date, d.email from invoices i
         join debtors d on d.user_id = i.user_id and d.id = i.debtor_id
        where i.number = 'X-1' order by i.amount_cents`,
    );
    expect(rows).toEqual([
      {
        user_id: a.id,
        amount_cents: 1000,
        issue_date: '2026-01-01',
        email: 'a@example.com',
      },
      {
        user_id: b.id,
        amount_cents: 9900,
        issue_date: '2026-02-02',
        email: 'b@example.com',
      },
    ]);
  });

  it("does not see another user's invoices in a dry run", async () => {
    const a = await makeUser();
    const b = await makeUser();
    await importCsv(a, SAMPLE);

    const data = await importCsv(b, SAMPLE, { dry_run: true });

    expect(data).toMatchObject({
      debtors_created: 6,
      invoices_created: 11,
      invoices_already_imported: 0,
    });
  });
});

describe('POST /api/imports body limit', () => {
  // Blank lines are ignored by the parser, so a big file can be made of one valid row and spaces.
  const padded = (size: number) =>
    Buffer.concat([
      Buffer.from(csv('B-1;Acme S.L.;;;01/01/2026;;10,00\n')),
      Buffer.alloc(size, ' '),
    ]);

  it('accepts a body of about 1.3 MB', async () => {
    const user = await makeUser();
    const body = JSON.stringify({ csv_base64: base64(padded(970_000)) });
    expect(body.length).toBeGreaterThan(1_290_000);
    expect(body.length).toBeLessThan(1_400_000);

    const res = await post(JSON.parse(body), { cookie: user.cookie });

    expect(res.status).toBe(200);
    expect((res.json as { data: ImportData }).data).toMatchObject({
      rows_valid: 1,
      invoices_created: 1,
    });
  });

  it('answers 413 PAYLOAD_TOO_LARGE when the body is over the limit of this route', async () => {
    const user = await makeUser();

    const res = await post(
      { csv_base64: 'A'.repeat(IMPORT_BODY_LIMIT_BYTES) },
      { cookie: user.cookie },
    );

    expect(res.status).toBe(413);
    expect((res.json as ErrorBody).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('answers 401 to an anonymous caller before reading a body that is huge or broken', async () => {
    // Over the route limit AND not valid JSON: if the big parser ran before the session check this
    // would be a 413 (or a 400), so a 401 proves that nothing was buffered or parsed for the caller.
    const res = await fetch(`${baseUrl}/api/imports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"csv_base64":"' + 'A'.repeat(IMPORT_BODY_LIMIT_BYTES),
    });

    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrorBody).error.code).toBe(
      'UNAUTHENTICATED',
    );
  });

  it('does not use up the rate limit when the body is refused', async () => {
    const user = await makeUser();

    await post(
      { csv_base64: 'A'.repeat(IMPORT_BODY_LIMIT_BYTES) },
      { cookie: user.cookie },
    );

    const { rows } = await db.query(
      "select key from rate_limits where key like 'import:%'",
    );
    expect(rows).toEqual([]);
  });

  it('keeps the 10 kB limit on every other route', async () => {
    const user = await makeUser();
    const big = { padding: 'a'.repeat(20_000) };

    const checks = [
      await post(big, { cookie: user.cookie, path: '/api/auth/login' }),
      await post(big, { path: '/api/auth/register' }),
      // Only the exact path of the import has the bigger limit.
      await post(big, { cookie: user.cookie, path: '/api/imports/other' }),
      await post(big, { cookie: user.cookie, path: '/api/imports2' }),
    ];

    for (const res of checks) {
      expect(res.status).toBe(413);
      expect((res.json as ErrorBody).error.code).toBe('PAYLOAD_TOO_LARGE');
    }
    const patch = await fetch(`${baseUrl}/api/me/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: user.cookie },
      body: JSON.stringify({ business_name: 'a'.repeat(20_000) }),
    });
    expect(patch.status).toBe(413);
  });
});

describe('POST /api/imports rate limit', () => {
  it('allows 20 per hour per user, counts only valid requests and frees the user in the next hour', async () => {
    const user = await makeUser();
    const other = await makeUser();
    const body = { csv_base64: base64(SAMPLE), dry_run: true };

    // Invalid requests are refused before the limit counts them.
    for (let i = 0; i < 3; i++) {
      expect(
        (await post({ csv_base64: '!' }, { cookie: user.cookie })).status,
      ).toBe(400);
    }
    for (let i = 0; i < 20; i++) {
      expect(
        (await post(body, { cookie: user.cookie })).status,
        String(i),
      ).toBe(200);
    }
    const limited = await post(body, { cookie: user.cookie });

    expect(limited.status).toBe(429);
    expect((limited.json as ErrorBody).error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await post(body, { cookie: other.cookie })).status).toBe(200);

    // The key holds a hash of the user id, never the id itself.
    const { rows } = await db.query(
      "select key, hits from rate_limits where key like 'import:%' order by hits desc",
    );
    expect(rows).toEqual([
      { key: `import:${hashKeyPart(user.id)}`, hits: 21 },
      { key: `import:${hashKeyPart(other.id)}`, hits: 1 },
    ]);

    nowMs += HOUR;
    expect((await post(body, { cookie: user.cookie })).status).toBe(200);
  }, 30_000);

  it('counts real imports and dry runs together', async () => {
    const user = await makeUser();

    for (let i = 0; i < 20; i++) {
      await post(
        { csv_base64: base64(SAMPLE), dry_run: i % 2 === 0 },
        { cookie: user.cookie },
      );
    }

    const res = await post(
      { csv_base64: base64(SAMPLE) },
      { cookie: user.cookie },
    );
    expect(res.status).toBe(429);
  }, 30_000);
});

describe('POST /api/imports invoice limit', () => {
  // A user who already has `existing` invoices (written straight to the database).
  async function userWithInvoices(existing: number) {
    const user = await makeUser();
    const debtor = await findOrCreateDebtor(db, user.id, { name: 'Existing' });
    await db.query(
      `insert into invoices (user_id, debtor_id, number, issue_date, amount_cents)
       select $1, $2, 'E-' || g, '2026-01-01', 1000 from generate_series(1, $3::int) g`,
      [user.id, debtor.id, existing],
    );
    return user;
  }
  const newRows = (n: number) =>
    csv(
      ...Array.from(
        { length: n },
        (_, i) =>
          `N-${String(i)};Cliente ${String(i)} S.L.;;;01/01/2026;31/01/2026;10,00`,
      ),
    );

  it('refuses a file that would pass the limit, in a dry run and for real, writing nothing', async () => {
    const user = await userWithInvoices(MAX_INVOICES_PER_USER - 10);
    const file = base64(newRows(11));

    const dry = await post(
      { csv_base64: file, dry_run: true },
      { cookie: user.cookie },
    );
    const real = await post({ csv_base64: file }, { cookie: user.cookie });

    for (const res of [dry, real]) {
      expect(res.status).toBe(422);
      expect((res.json as ErrorBody).error).toMatchObject({
        code: 'INVOICE_LIMIT_REACHED',
        details: { limit: MAX_INVOICES_PER_USER },
      });
    }
    expect(await count('invoices', user.id)).toBe(MAX_INVOICES_PER_USER - 10);
    expect(await count('debtors', user.id)).toBe(1);
  }, 30_000);

  it('accepts a file that fills the limit exactly, and then the same file again', async () => {
    const user = await userWithInvoices(MAX_INVOICES_PER_USER - 10);

    const dry = await importCsv(user, newRows(10), { dry_run: true });
    const first = await importCsv(user, newRows(10));
    // Nothing new in the second file: the invoices that already exist do not count.
    const again = await importCsv(user, newRows(10));

    expect(dry.invoices_created).toBe(10);
    expect(first.invoices_created).toBe(10);
    expect(again).toMatchObject({
      invoices_created: 0,
      invoices_already_imported: 10,
    });
    expect(await count('invoices', user.id)).toBe(MAX_INVOICES_PER_USER);
    const over = await post(
      { csv_base64: base64(newRows(11)) },
      { cookie: user.cookie },
    );
    expect(over.status).toBe(422);
  }, 30_000);
});
