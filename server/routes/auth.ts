import { z } from 'zod';
import { clearSessionCookie, startSession } from '../auth/session.ts';
import {
  hashPassword,
  needsRehash,
  validatePassword,
  verifyAgainstDummy,
  verifyPassword,
  type PasswordErrorCode,
} from '../auth/password.ts';
import type { Db } from '../db/client.ts';
import { hashKeyPart } from '../db/rate-limits.ts';
import { deleteSession } from '../db/sessions.ts';
import {
  createUserWithProfile,
  findUserByEmail,
  replacePasswordHash,
} from '../db/users.ts';
import type { Clock } from '../domain/dates.ts';
import type { DefineRoute } from '../http/routes.ts';
import { sendError } from '../middleware/errors.ts';

// Trim and lowercase first, then the length, then the shape. ASCII only on purpose: the
// database check `email = lower(email)` must agree with JavaScript's toLowerCase(), and for
// non-ASCII letters the two can differ. The shape is "something@label.label" with a linear
// regex (no nested repeats), so a long input cannot make it slow.
export const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, { abort: true })
  .regex(/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/, {
    message: 'Must be a valid email address',
  });

const PASSWORD_MESSAGES: Record<PasswordErrorCode, string> = {
  NOT_A_STRING: 'Must be a string',
  MALFORMED_UNICODE: 'Must be valid text',
  TOO_SHORT: 'Must have at least 10 characters',
  TOO_LONG: 'Must have at most 128 characters',
};

const registerSchema = z.object({
  email,
  password: z.string().superRefine((value, ctx) => {
    const result = validatePassword(value);
    if (!result.ok) {
      ctx.addIssue({ code: 'custom', message: PASSWORD_MESSAGES[result.code] });
    }
  }),
});

// Login does not enforce the minimum length (a wrong short password is just a wrong password),
// but it does refuse what verifyPassword would reject without hashing (too long, malformed
// text). Otherwise an over-long password would answer faster for a registered email than for
// an unknown one, and that difference would reveal which emails have an account.
const loginSchema = z.object({
  email,
  password: z.string().superRefine((value, ctx) => {
    const result = validatePassword(value);
    if (!result.ok && result.code !== 'TOO_SHORT') {
      ctx.addIssue({ code: 'custom', message: PASSWORD_MESSAGES[result.code] });
    }
  }),
});

export function registerAuthRoutes(
  defineRoute: DefineRoute,
  { db, clock }: { db: Db; clock: Clock },
) {
  defineRoute({
    method: 'POST',
    path: '/api/auth/register',
    auth: 'public',
    schema: { body: registerSchema },
    rateLimit: {
      name: 'register',
      limit: 5,
      windowSeconds: 60 * 60,
      key: (_body, ip) => ip,
    },
    handler: async ({ res, body }) => {
      // The hash is computed before looking at the database, so "email already taken" costs
      // the same time as a success.
      const passwordHash = await hashPassword(body.password);
      const user = await createUserWithProfile(db, body.email, passwordHash);
      if (!user) {
        sendError(res, 409, 'EMAIL_TAKEN', 'Email already registered');
        return;
      }
      await startSession(db, clock, res, user.id);
      res.status(201).json({ data: { user } });
    },
  });

  defineRoute({
    method: 'POST',
    path: '/api/auth/login',
    auth: 'public',
    schema: { body: loginSchema },
    rateLimit: {
      name: 'login',
      limit: 5,
      windowSeconds: 15 * 60,
      key: (body, ip) => `${ip}:${hashKeyPart(body.email)}`,
    },
    handler: async ({ res, body }) => {
      const found = await findUserByEmail(db, body.email);
      const storedHash = found?.password_hash ?? null;
      let valid = false;
      if (storedHash === null) {
        // Unknown email, or a demo user without a password: spend the same time as a real check.
        await verifyAgainstDummy(body.password);
      } else {
        valid = await verifyPassword(body.password, storedHash);
      }
      if (!found || storedHash === null || !valid) {
        sendError(res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password');
        return;
      }

      // Hashes made with older, weaker parameters are upgraded now that we hold the password.
      // Best effort: a failure here must never fail a login that was correct.
      if (needsRehash(storedHash)) {
        try {
          const upgraded = await hashPassword(body.password);
          await replacePasswordHash(db, found.id, storedHash, upgraded);
        } catch {
          // The old hash still works; the upgrade is tried again at the next login.
        }
      }

      await startSession(db, clock, res, found.id);
      res.json({ data: { user: { id: found.id, email: found.email } } });
    },
  });

  defineRoute({
    method: 'POST',
    path: '/api/auth/logout',
    handler: async ({ res, session }) => {
      await deleteSession(db, session.tokenHash);
      clearSessionCookie(res);
      res.status(204).end();
    },
  });
}
