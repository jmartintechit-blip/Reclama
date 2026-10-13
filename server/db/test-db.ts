import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations, runMigrations, type Queryable } from './migrate.ts';
import { typeParsers } from './types.ts';

export interface TestDb extends Queryable {
  close(): Promise<void>;
}

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

// A fresh in-memory Postgres (PGlite) with every migration applied by the real runner and the
// same type parsers as production. It has ONE connection and no concurrency: do not run two
// queries at the same time on it, and use begin/rollback to keep a test from leaking rows.
export async function createTestDb(): Promise<TestDb> {
  const pglite = new PGlite({ parsers: typeParsers });
  const db: TestDb = {
    async query(sql, params) {
      // Without parameters `exec` is used because it accepts several statements (a migration
      // file); `query` accepts only one. Both use the same parsers.
      if (params === undefined) {
        const results = await pglite.exec(sql);
        return { rows: results.at(-1)?.rows ?? [] };
      }
      const { rows } = await pglite.query<Record<string, unknown>>(sql, params);
      return { rows };
    },
    close: () => pglite.close(),
  };
  await runMigrations(db, await loadMigrations(MIGRATIONS_DIR));
  return db;
}
