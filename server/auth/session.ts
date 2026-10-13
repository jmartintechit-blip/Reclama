// Session tokens and the session cookie (plan sections 2, 3 and 7). The browser keeps the
// token; the database keeps only its SHA-256, so a leaked sessions table cannot be used to log in.
import { createHash, randomBytes } from 'node:crypto';
import type { Response } from 'express';
import type { Clock } from '../domain/dates.ts';
import type { Db } from '../db/client.ts';
import { createSession } from '../db/sessions.ts';

// The `__Host-` prefix makes browsers accept the cookie only if it is Secure, has Path=/ and
// has no Domain: no sibling subdomain can set or overwrite it.
export const SESSION_COOKIE = '__Host-sid';

// Absolute lifetime: a session ends 7 days after it was created, however often it is used
// (no sliding renewal). A stolen cookie therefore stops working by itself. The demo sandbox
// (T27) will create shorter sessions.
export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const TOKEN_BYTES = 32; // 256 bits from the OS random generator: impossible to guess
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 bytes in base64url

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

// SHA-256 is enough here (no slow hash needed): the token is random, not a human password.
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

// Reads our one cookie from the raw Cookie header (no cookie-parser). Returns null if it is
// missing, appears twice (a browser never sends two: the request was forged) or does not
// look like a token, so malformed input never reaches the database.
export function readSessionToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  let found: string | null = null;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (
      separator === -1 ||
      pair.slice(0, separator).trim() !== SESSION_COOKIE
    ) {
      continue;
    }
    if (found !== null) return null;
    found = pair.slice(separator + 1).trim();
  }
  return found !== null && TOKEN_PATTERN.test(found) ? found : null;
}

// No `domain` on purpose (required by __Host-). Max-Age rather than Expires so the browser's
// own clock does not matter; the server enforces the real expiry from the database row.
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
} as const;

// A new token for every call: login never reuses a token (session fixation).
export async function startSession(
  db: Db,
  clock: Clock,
  res: Response,
  userId: string,
): Promise<void> {
  const token = generateToken();
  const expiresAt = new Date(clock.now().getTime() + SESSION_LIFETIME_MS);
  await createSession(db, hashToken(token), userId, expiresAt);
  res.cookie(SESSION_COOKIE, token, {
    ...COOKIE_OPTIONS,
    maxAge: SESSION_LIFETIME_MS,
  });
}

// The attributes must match the ones used to set the cookie, or the browser ignores the removal.
export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, COOKIE_OPTIONS);
}
