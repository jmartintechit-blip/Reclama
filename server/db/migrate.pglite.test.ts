import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations, runMigrations, type Migration } from './migrate.ts';
import { createTestDb, type TestDb } from './test-db.ts';

// migrate.test.ts checks the runner's SQL with a fake. Here the same runner talks to a real
// Postgres (PGlite): it is the only way to know that BEGIN, ROLLBACK, the advisory lock and
// the schema file really work. The database is shared by the tests of this file because none
// of them leaves a change behind (except the last describe, which has its own).
const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

let db: TestDb;
let real: Migration[];

beforeAll(async () => {
  real = await loadMigrations(
    fileURLToPath(new URL('./migrations', import.meta.url)),
  );
  db = await createTestDb(); // applies every migration with the real runner
}, 30_000);
afterAll(async () => {
  await db.close();
});

describe('runMigrations against a real Postgres', () => {
  it('applied 0001 and recorded its checksum', async () => {
    const initial = real.find((m) => m.name === '0001_initial_schema.sql');
    const { rows } = await db.query(
      'select name, checksum from schema_migrations',
    );

    expect(rows).toEqual([
      { name: '0001_initial_schema.sql', checksum: sha256(initial?.sql ?? '') },
    ]);
    const tables = await db.query(
      `select table_name from information_schema.tables
       where table_schema = 'public' order by table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'claim_events',
      'claim_invoices',
      'claims',
      'debtors',
      'email_log',
      'invoices',
      'legal_interest_rates',
      'payments',
      'profiles',
      'rate_limits',
      'schema_migrations',
      'sessions',
      'users',
    ]);
  });

  it('a second run applies nothing', async () => {
    expect(await runMigrations(db, real)).toEqual([]);

    const { rows } = await db.query(
      'select count(*) as n from schema_migrations',
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('detects a migration that was modified after being applied', async () => {
    const edited = real.map((m) => ({ ...m, sql: `${m.sql}\n-- edited` }));

    await expect(runMigrations(db, edited)).rejects.toThrow(
      '0001_initial_schema.sql was modified after being applied',
    );
    // Control: the untouched files are still accepted.
    expect(await runMigrations(db, real)).toEqual([]);
  });
});

// This one changes the database (it ends with a new migration applied), so it gets its own.
describe('a broken migration', () => {
  let own: TestDb;
  beforeAll(async () => {
    own = await createTestDb();
  }, 30_000);
  afterAll(async () => {
    await own.close();
  });

  it('rolls back a broken migration, records nothing and applies it once fixed', async () => {
    const broken: Migration = {
      name: '0002_broken.sql',
      sql: `create table half_done (id int);
            insert into half_done values (1);
            select * from does_not_exist;`,
    };

    await expect(runMigrations(own, [...real, broken])).rejects.toThrow(
      'does_not_exist',
    );
    // The statements before the error were undone with it...
    const table = await own.query(`select to_regclass('half_done') as t`);
    expect(table.rows[0]?.t).toBeNull();
    // ...and the failed migration was not recorded.
    const recorded = await own.query('select name from schema_migrations');
    expect(recorded.rows.map((row) => row.name)).toEqual([
      '0001_initial_schema.sql',
    ]);

    // Control: without the bad statement, the same migration is applied and recorded.
    const fixed: Migration = {
      name: broken.name,
      sql: 'create table half_done (id int);',
    };
    expect(await runMigrations(own, [...real, fixed])).toEqual([fixed.name]);
    const after = await own.query("select to_regclass('half_done') as t");
    expect(after.rows[0]?.t).toBe('half_done');
  });
});
