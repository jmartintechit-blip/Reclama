import express from 'express';
import type { Db } from '../db/client.ts';
import { sendError } from '../middleware/errors.ts';
import { getRequestId } from '../middleware/request-id.ts';

export function createHealthRouter(db?: Db) {
  const router = express.Router();

  // "Alive" check only: it never touches the database, so it answers even when the database is down.
  router.get('/api/health', (_req, res) => {
    res.json({ data: { status: 'ok' } });
  });

  // "Ready" check: the database answers AND the schema has been migrated (the runner records
  // every migration in schema_migrations). The response never says which migration is the last.
  router.get('/api/health/ready', async (_req, res) => {
    let errorName = 'NotMigrated';
    try {
      if (!db) {
        errorName = 'NoDatabase';
      } else {
        const { rows } = await db.query(
          'select name from schema_migrations order by name desc limit 1',
        );
        if (rows.length === 1) {
          res.json({ data: { status: 'ready' } });
          return;
        }
      }
    } catch (error) {
      errorName = error instanceof Error ? error.name : 'NonError';
    }
    // Only the error name is logged: a database error message can contain host names or SQL.
    console.warn(
      JSON.stringify({
        level: 'warn',
        request_id: getRequestId(res),
        error_name: errorName,
      }),
    );
    sendError(res, 503, 'NOT_READY', 'Service not ready');
  });

  return router;
}
