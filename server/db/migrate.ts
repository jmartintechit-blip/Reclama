import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Migration {
  name: string;
  sql: string;
}

// The runner needs ONE dedicated connection (a pg Client, not a Pool): BEGIN, the lock and
// COMMIT must travel through the same connection.
export interface Queryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

// Arbitrary fixed number that identifies "a migration is running" for pg_advisory_xact_lock.
const LOCK_KEY = 7_283_001;
const NAME_PATTERN = /^\d{4}_[a-z][a-z0-9_]*\.sql$/;

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

// Checks the file names and returns the migrations in numeric order.
function validate(migrations: Migration[]): Migration[] {
  const numbers = new Set<string>();
  for (const { name } of migrations) {
    if (!NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid migration name "${name}": expected NNNN_snake_case.sql`,
      );
    }
    const number = name.slice(0, 4);
    if (numbers.has(number)) {
      throw new Error(`Duplicate migration number ${number}`);
    }
    numbers.add(number);
  }
  // The numbers have 4 digits, so comparing the names as text is the same as comparing numbers.
  return [...migrations].sort((a, b) => (a.name < b.name ? -1 : 1));
}

// Each migration runs in its own transaction. The lock is transaction-scoped on purpose:
// behind a transaction pooler (Neon) a session-level lock could be released on another
// connection. The second runner waits for the lock and then sees the migration already recorded.
async function applyOne(db: Queryable, migration: Migration): Promise<boolean> {
  await db.query('begin');
  try {
    await db.query('select pg_advisory_xact_lock($1)', [LOCK_KEY]);
    const done = await db.query(
      'select 1 from schema_migrations where name = $1',
      [migration.name],
    );
    const isPending = done.rows.length === 0;
    if (isPending) {
      await db.query(migration.sql);
      await db.query(
        'insert into schema_migrations (name, checksum) values ($1, $2)',
        [migration.name, checksum(migration.sql)],
      );
    }
    await db.query('commit');
    return isPending;
  } catch (error) {
    // If the rollback fails too (lost connection), the original error is the useful one.
    await db.query('rollback').catch(() => undefined);
    throw error;
  }
}

// Forward-only: there are no "down" migrations. Returns the names it applied.
export async function runMigrations(
  db: Queryable,
  migrations: Migration[],
): Promise<string[]> {
  const ordered = validate(migrations);

  await db.query(`create table if not exists schema_migrations (
    name text primary key,
    checksum text not null,
    applied_at timestamptz not null default now()
  )`);
  const recorded = await db.query(
    'select name, checksum from schema_migrations',
  );
  const checksums = new Map(
    recorded.rows.map((row) => [row.name, row.checksum]),
  );

  // Check everything before touching the database, so a modified file stops the whole run.
  for (const { name, sql } of ordered) {
    if (checksums.has(name) && checksums.get(name) !== checksum(sql)) {
      throw new Error(`Migration ${name} was modified after being applied`);
    }
  }

  const applied: string[] = [];
  for (const migration of ordered) {
    if (!checksums.has(migration.name) && (await applyOne(db, migration))) {
      applied.push(migration.name);
    }
  }
  return applied;
}

export async function loadMigrations(dir: string): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith('.sql'));
  return Promise.all(
    files.map(async (name) => ({
      name,
      sql: await readFile(join(dir, name), 'utf8'),
    })),
  );
}
