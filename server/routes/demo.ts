import { DEMO_SESSION_LIFETIME_MS, startSession } from '../auth/session.ts';
import type { Db } from '../db/client.ts';
import {
  countActiveDemoUsers,
  createDemoUser,
  purgeExpiredDemoUsers,
} from '../db/demo.ts';
import { listVerifiedRates } from '../db/rates.ts';
import { deleteUser } from '../db/users.ts';
import { todayMadrid, type Clock } from '../domain/dates.ts';
import { buildDemoData, demoToday } from '../domain/demo-data.ts';
import type { DefineRoute } from '../http/routes.ts';
import { sendError } from '../middleware/errors.ts';
import { getRequestId } from '../middleware/request-id.ts';

const HOUR_MS = 60 * 60 * 1000;
const DEMO_USER_LIFETIME_MS = 24 * HOUR_MS;
export const MAX_ACTIVE_DEMO_USERS = 200;
// At most this many expired demo users are deleted per request, so no request does unbounded work.
const PURGE_BATCH = 100;

export function registerDemoRoutes(
  defineRoute: DefineRoute,
  { db, clock }: { db: Db; clock: Clock },
) {
  // Opens a sandbox for a visitor who has not registered: a user with no email and no password,
  // pre-loaded with fictitious data, and a short session. Anyone can call it, so it is limited:
  // 10 per hour per IP, and at most MAX_ACTIVE_DEMO_USERS sandboxes alive at once.
  defineRoute({
    method: 'POST',
    path: '/api/demo/session',
    auth: 'public',
    rateLimit: {
      name: 'demo-session',
      limit: 10,
      windowSeconds: 60 * 60,
      key: (_body, ip) => ip,
    },
    handler: async ({ res }) => {
      const now = clock.now();
      const today = demoToday(todayMadrid(clock), await listVerifiedRates(db));
      if (today === null) {
        sendError(
          res,
          503,
          'DEMO_UNAVAILABLE',
          'The demo is not available right now',
        );
        return;
      }

      // Housekeeping without a cron job (as in the rate limits): a request that wants a new
      // sandbox first removes expired ones. Best effort: a failure here must never fail the
      // request, so only the error name is logged.
      try {
        await purgeExpiredDemoUsers(db, now, PURGE_BATCH);
      } catch (error) {
        console.error(
          JSON.stringify({
            level: 'error',
            request_id: getRequestId(res),
            error_name: error instanceof Error ? error.name : 'NonError',
          }),
        );
      }

      // shortcut: the count and the insert are two statements, so requests that run at the same
      // instant can all pass the check and the limit may be overshot by a few. Acceptable for a
      // free-tier demo whose per-IP limit already bounds the burst; use a lock if it ever matters.
      if ((await countActiveDemoUsers(db, now)) >= MAX_ACTIVE_DEMO_USERS) {
        sendError(
          res,
          503,
          'DEMO_FULL',
          'The demo is full right now, try again later',
        );
        return;
      }

      const expiresAt = new Date(now.getTime() + DEMO_USER_LIFETIME_MS);
      const user = await createDemoUser(db, expiresAt, buildDemoData(today));
      let sessionExpiresAt: Date;
      try {
        sessionExpiresAt = await startSession(
          db,
          clock,
          res,
          user.id,
          DEMO_SESSION_LIFETIME_MS,
        );
      } catch (error) {
        // The sandbox is seeded by one statement but its session is a second one: without a
        // session nobody can ever use it, so remove it now instead of waiting for the purge.
        // Best effort: if this fails too, the purge removes it once it has expired.
        await deleteUser(db, user.id).catch(() => false);
        throw error;
      }
      res.status(201).json({
        data: {
          user: { id: user.id, is_demo: true },
          expires_at: expiresAt.toISOString(),
          session_expires_at: sessionExpiresAt.toISOString(),
        },
      });
    },
  });
}
