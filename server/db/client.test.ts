import { describe, expect, it } from 'vitest';
import { createPool } from './client.ts';

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
