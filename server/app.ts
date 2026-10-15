import express from 'express';
import { systemClock } from './clock.ts';
import { errorHandler, notFoundHandler } from './middleware/errors.ts';
import { originGuard } from './middleware/origin-guard.ts';
import { requestId } from './middleware/request-id.ts';
import { createRequireSession } from './middleware/require-session.ts';
import { securityHeaders } from './middleware/security-headers.ts';
import type { Db } from './db/client.ts';
import { hitRateLimit } from './db/rate-limits.ts';
import type { Clock } from './domain/dates.ts';
import { createRouteRegistry } from './http/routes.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerHealthRoutes } from './routes/health.ts';
import {
  IMPORT_BODY_LIMIT_BYTES,
  IMPORTS_PATH,
  registerImportRoutes,
} from './routes/imports.ts';
import { registerMeRoutes } from './routes/me.ts';

// Without a database the app still starts (liveness must work); every query then fails.
const noDb: Db = {
  query: () => Promise.reject(new Error('No database configured')),
};

// `mailer` will join `db` and `clock` here later (plan section 2).
export function createApp({
  db,
  clock = systemClock,
}: { db?: Db; clock?: Clock } = {}) {
  const app = express();

  app.disable('x-powered-by'); // do not advertise the framework and its version
  app.set('etag', false); // every answer is "no-store", so a weak ETag would only add bytes
  app.use(securityHeaders); // first, so that errors and 404s get the headers too
  app.use(requestId);
  app.use(originGuard); // before the body is read: a foreign origin or a non-JSON body never reaches the parser
  const sessionDb = db ?? noDb;
  const requireSession = createRequireSession(sessionDb, clock);
  // The CSV import carries a file of up to 1 MB as base64, so its path gets its own, bigger JSON
  // parser. It comes BEFORE the global one (the body is read once, and the global parser skips a
  // request whose body is already consumed) and AFTER the session check, so an anonymous caller
  // can never make the server buffer and parse 1.4 MB: it gets a 401 first.
  app.post(
    IMPORTS_PATH,
    requireSession,
    express.json({ limit: IMPORT_BODY_LIMIT_BYTES }),
  );
  // Small on purpose: normal JSON bodies in this API are a few fields.
  app.use(express.json({ limit: '10kb' }));

  // Request flow: request id -> origin guard -> [session, bigger parser for the import path only]
  // -> body parser -> session -> validation -> rate limit -> handler. The last four are applied by
  // defineRoute to each route, in that order. The rate limit comes after validation so that its
  // key can use the normalised email.
  const defineRoute = createRouteRegistry(app, requireSession, (rule) =>
    hitRateLimit(sessionDb, clock, rule),
  );
  registerHealthRoutes(defineRoute, db);
  registerAuthRoutes(defineRoute, { db: sessionDb, clock });
  registerMeRoutes(defineRoute, { db: sessionDb });
  registerImportRoutes(defineRoute, { db: sessionDb });

  // After all the routes: the not-found handler catches what no route matched,
  // and the error handler must be the last middleware to receive every error.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
