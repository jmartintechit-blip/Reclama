import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadMigrations, runMigrations, type Queryable } from './migrate.ts';

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');
const oneLine = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

const m1 = { name: '0001_first.sql', sql: 'create table a (id int);' };
const m2 = { name: '0002_second.sql', sql: 'create table b (id int);' };

// A fake connection: it records every SQL it receives and simulates the two things the runner
// reads (schema_migrations and the lock). Nothing here needs a database.
function fakeDb(options: {
  recorded?: Record<string, string>; // name -> checksum already in schema_migrations
  recordedWhileWaiting?: string; // a migration another runner finishes while we wait for the lock
  failOn?: string; // SQL text that makes the fake throw
}) {
  const log: string[] = [];
  const recorded = new Map(Object.entries(options.recorded ?? {}));
  let inserted: string[] = []; // inserts of the open transaction: lost on rollback
  const db: Queryable = {
    query(sql, params) {
      log.push(oneLine(sql));
      if (sql === options.failOn) {
        return Promise.reject(new Error('boom'));
      }
      if (sql === 'select name, checksum from schema_migrations') {
        const rows = [...recorded].map(([name, checksum]) => ({
          name,
          checksum,
        }));
        return Promise.resolve({ rows });
      }
      if (sql.startsWith('select 1 from schema_migrations')) {
        const name = params?.[0];
        const found =
          recorded.has(String(name)) || name === options.recordedWhileWaiting;
        return Promise.resolve({ rows: found ? [{ '?column?': 1 }] : [] });
      }
      if (sql.startsWith('insert into schema_migrations')) {
        inserted.push(String(params?.[0]));
      }
      if (sql === 'commit') {
        for (const name of inserted) recorded.set(name, '');
      }
      if (sql === 'commit' || sql === 'rollback') {
        inserted = [];
      }
      return Promise.resolve({ rows: [] });
    },
  };
  return { db, log, recorded };
}

describe('runMigrations', () => {
  it('applies in numeric order, each one in its own transaction with the advisory lock', async () => {
    const { db, log } = fakeDb({});
    const applied = await runMigrations(db, [m2, m1]);

    expect(applied).toEqual([m1.name, m2.name]);
    const transaction = (m: { name: string; sql: string }): string[] => [
      'begin',
      'select pg_advisory_xact_lock($1)',
      'select 1 from schema_migrations where name = $1',
      m.sql,
      'insert into schema_migrations (name, checksum) values ($1, $2)',
      'commit',
    ];
    expect(log.slice(1)).toEqual([
      'select name, checksum from schema_migrations',
      ...transaction(m1),
      ...transaction(m2),
    ]);
    expect(log[0]).toContain('create table if not exists schema_migrations');
  });

  it('skips the migrations that are already recorded', async () => {
    const { db, log } = fakeDb({ recorded: { [m1.name]: sha256(m1.sql) } });
    const applied = await runMigrations(db, [m1, m2]);

    expect(applied).toEqual([m2.name]);
    expect(log).not.toContain(m1.sql);
  });

  it('applies nothing when another runner recorded the migration while we waited for the lock', async () => {
    const { db, log } = fakeDb({ recordedWhileWaiting: m1.name });
    const applied = await runMigrations(db, [m1]);

    expect(applied).toEqual([]);
    expect(log).not.toContain(m1.sql);
    expect(log.at(-1)).toBe('commit');
  });

  it('rolls back, records nothing for the failed migration and rethrows', async () => {
    const { db, log, recorded } = fakeDb({ failOn: m2.sql });

    await expect(runMigrations(db, [m1, m2])).rejects.toThrow('boom');
    expect(log.at(-1)).toBe('rollback');
    expect(log.filter((sql) => sql.startsWith('insert'))).toHaveLength(1);
    expect([...recorded.keys()]).toEqual([m1.name]); // only the one that committed before
  });

  it('fails before running anything when an applied migration was modified', async () => {
    const { db, log } = fakeDb({
      recorded: { [m1.name]: sha256('something else') },
    });

    await expect(runMigrations(db, [m1, m2])).rejects.toThrow(
      '0001_first.sql was modified after being applied',
    );
    expect(log).not.toContain('begin');
  });

  it.each([
    '1_first.sql',
    '0001-first.sql',
    '0001_First.sql',
    '0001_first.txt',
    'first.sql',
  ])('rejects the bad name %s', async (name) => {
    const { db } = fakeDb({});
    await expect(
      runMigrations(db, [{ name, sql: 'select 1' }]),
    ).rejects.toThrow('Invalid migration name');
  });

  it('rejects two migrations with the same number', async () => {
    const { db } = fakeDb({});
    const other = { name: '0001_other.sql', sql: 'select 1' };
    await expect(runMigrations(db, [m1, other])).rejects.toThrow(
      'Duplicate migration number 0001',
    );
  });
});

describe('loadMigrations', () => {
  const dir = fileURLToPath(new URL('./migrations', import.meta.url));

  it('loads the real initial schema with LF line endings and a pinned checksum', async () => {
    const migrations = await loadMigrations(dir);
    const initial = migrations.find(
      (m) => m.name === '0001_initial_schema.sql',
    );

    expect(initial?.sql).toContain('create table users');
    expect(initial?.sql).not.toContain('\r');
    // If this fails you edited a migration. Add a new migration instead of changing this one:
    // after it is applied anywhere, the runner refuses a modified file.
    expect(sha256(initial?.sql ?? '')).toBe(
      'e04f5135aff3ddd16609a289c0bdd3ceb18c475c44bb178909f3f5b01375f19e',
    );
  });

  it('gives names and order the runner accepts', async () => {
    const { db } = fakeDb({});
    const applied = await runMigrations(db, await loadMigrations(dir));
    expect(applied[0]).toBe('0001_initial_schema.sql');
  });
});
