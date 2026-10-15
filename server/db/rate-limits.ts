import { createHash } from 'node:crypto';
import type { Clock } from '../domain/dates.ts';
import type { Db } from './client.ts';

export interface RateLimitRule {
  key: string;
  limit: number;
  windowSeconds: number; // at most one day: rows older than RETENTION_MS are deleted
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number; // seconds until the current window ends (>= 1)
}

export type RateLimiter = (rule: RateLimitRule) => Promise<RateLimitResult>;

const RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

// Keys are stored in the database, so personal data (an email) goes in as a hash, never raw.
export function hashKeyPart(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// Fixed-window counter (plan section 5). Windows start at multiples of their length counted
// from the epoch, and `now` comes from the injected clock. The count is ONE atomic statement,
// so two simultaneous requests can never read the same value. A database error is not caught:
// the caller fails closed (500) instead of letting the request through unlimited.
export async function hitRateLimit(
  db: Db,
  clock: Clock,
  { key, limit, windowSeconds }: RateLimitRule,
): Promise<RateLimitResult> {
  const now = clock.now().getTime();
  const windowMs = windowSeconds * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;

  const { rows } = await db.query(
    `insert into rate_limits (key, window_start, hits) values ($1, $2, 1)
     on conflict (key, window_start) do update set hits = rate_limits.hits + 1
     returning hits`,
    [key, new Date(windowStart).toISOString()],
  );
  const { hits } = rows[0] as { hits: number };

  // Cleanup without a cron job: whoever opens a new window also removes the old ones.
  if (hits === 1) {
    await db.query('delete from rate_limits where window_start < $1', [
      new Date(now - RETENTION_MS).toISOString(),
    ]);
  }

  return {
    allowed: hits <= limit,
    retryAfterSeconds: Math.ceil((windowStart + windowMs - now) / 1000),
  };
}
