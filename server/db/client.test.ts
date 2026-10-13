import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createDbFromEnv, createPool } from './client.ts';

describe('createPool', () => {
  it('sets the timeouts and listens for idle-client errors, without connecting', async () => {
    const pool = createPool('postgres://user:secret@localhost:5432/db');
    try {
      expect(pool.options.max).toBe(3);
      expect(pool.options.connectionTimeoutMillis).toBe(5_000);
      expect(pool.options.statement_timeout).toBe(5_000);
      expect(pool.listenerCount('error')).toBe(1);
    } finally {
      await pool.end();
    }
  });
});

describe('createDbFromEnv', () => {
  it.each([
    'postgres://u:p@localhost:5432/db',
    'postgresql://u:p@localhost/db',
  ])(
    'builds a pool, without connecting, from a valid URL (%#)',
    async (url) => {
      const db = createDbFromEnv({ DATABASE_URL: url });
      try {
        expect(db).toBeInstanceOf(Pool);
        expect((db as Pool).totalCount).toBe(0); // no connection was opened
      } finally {
        await (db as Pool).end();
      }
    },
  );

  it.each([undefined, '', 'mysql://u:p@localhost/db', 'not a url'])(
    'returns a stand-in whose query rejects when DATABASE_URL is missing or invalid (%#)',
    async (url) => {
      const db = createDbFromEnv(
        url === undefined ? {} : { DATABASE_URL: url },
      );

      expect(db).not.toBeInstanceOf(Pool);
      await expect(db.query('select 1')).rejects.toThrow(
        'DATABASE_URL is not configured',
      );
    },
  );
});
