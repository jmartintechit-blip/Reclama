import { z } from 'zod';
import { clearSessionCookie } from '../auth/session.ts';
import { PASSWORD_MAX_LENGTH, verifyPassword } from '../auth/password.ts';
import type { Db } from '../db/client.ts';
import { getProfile, updateProfile } from '../db/profile.ts';
import { hashKeyPart } from '../db/rate-limits.ts';
import { deleteUser, getPasswordHash } from '../db/users.ts';
import { parseIban } from '../domain/iban.ts';
import type { DefineRoute } from '../http/routes.ts';
import { sendError } from '../middleware/errors.ts';
import { MAX_SENDER_ADDRESS_LINES } from '../services/letter.ts';

// A text field of the profile: trimmed, not empty (send null to clear it), at most `max`
// characters, and without control characters (a NUL byte makes Postgres fail with a 500).
// `multiline` also allows line breaks and tabs, for the postal address.
const profileText = (max: number, multiline = false) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (value) => !(multiline ? /[^\P{Cc}\n\r\t]/u : /\p{Cc}/u).test(value),
      {
        message: 'Must not contain control characters',
      },
    );

// Spaces are removed and letters upper-cased before the check; the stored value is the clean one.
const iban = z
  .string()
  .max(64)
  .transform((value, ctx) => {
    const parsed = parseIban(value);
    if (parsed === null) {
      ctx.issues.push({
        code: 'custom',
        message: 'Must be a valid IBAN',
        input: value,
      });
      return z.NEVER;
    }
    return parsed;
  });

// Every field is optional (a missing key keeps the stored value) and the text fields accept
// null to clear them. Keys that are not listed here are dropped by Zod, so a client can never
// write anything else (user_id, for example).
const profileSchema = z.object({
  business_name: profileText(200).nullable().optional(),
  tax_id: profileText(30).nullable().optional(),
  address: profileText(500, true)
    .refine(
      (value) => value.split(/\r\n|\r|\n/).length <= MAX_SENDER_ADDRESS_LINES,
      {
        message: `Must have at most ${String(MAX_SENDER_ADDRESS_LINES)} lines`,
      },
    )
    .nullable()
    .optional(),
  iban: iban.nullable().optional(),
  default_compensation: z.enum(['NONE', 'PER_INVOICE', 'PER_CLAIM']).optional(),
});

// verifyPassword never throws and does not hash a password it can never match; the limit only
// keeps absurdly long input out of it.
const deleteAccountSchema = z.object({
  password: z.string().max(PASSWORD_MAX_LENGTH * 2),
});

export function registerMeRoutes(defineRoute: DefineRoute, { db }: { db: Db }) {
  defineRoute({
    method: 'GET',
    path: '/api/me',
    handler: async ({ res, session }) => {
      const { id, email, is_demo } = session.user;
      const profile = await getProfile(db, id);
      res.json({ data: { user: { id, email, is_demo }, profile } });
    },
  });

  defineRoute({
    method: 'PATCH',
    path: '/api/me/profile',
    schema: { body: profileSchema },
    handler: async ({ res, body, session }) => {
      const profile = await updateProfile(db, session.user.id, body);
      if (!profile) {
        sendError(res, 404, 'NOT_FOUND', 'Not found');
        return;
      }
      res.json({ data: { profile } });
    },
  });

  defineRoute({
    method: 'DELETE',
    path: '/api/me',
    schema: { body: deleteAccountSchema },
    // Every attempt counts, right or wrong: argon2 is expensive and the password is the only
    // thing standing between a stolen session and the loss of the whole account.
    rateLimit: {
      name: 'delete-account',
      limit: 5,
      windowSeconds: 15 * 60,
      key: (_body, _ip, session) => hashKeyPart(session.user.id),
    },
    handler: async ({ res, body, session }) => {
      if (session.user.is_demo) {
        sendError(res, 403, 'DEMO_ACCOUNT', 'Demo accounts cannot be deleted');
        return;
      }
      const storedHash = await getPasswordHash(db, session.user.id);
      const valid =
        storedHash !== null &&
        (await verifyPassword(body.password, storedHash));
      if (!valid) {
        // Same answer as a failed login.
        sendError(res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password');
        return;
      }
      await deleteUser(db, session.user.id); // the cascade removes the sessions and all the data
      clearSessionCookie(res);
      res.status(204).end();
    },
  });
}
