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

// Fixed-window counter. Windows start at multiples of their length counted
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

// Gives back one hit that hitRateLimit counted, for a request that ended up doing nothing the
// limit is meant to bound (an email that was never sent). Same key and window computation as
// hitRateLimit. The counter never goes below zero: a row at one hit is removed (the column must
// stay above zero) and a window that has no row is left alone. ONE statement whose two parts
// see the same snapshot, so they never touch the same row. If another request raises the
// counter at that very moment, the refund may not be applied, which only favours the limit.
export async function refundRateLimit(
  db: Db,
  clock: Clock,
  { key, windowSeconds }: RateLimitRule,
): Promise<void> {
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(
    Math.floor(clock.now().getTime() / windowMs) * windowMs,
  ).toISOString();
  await db.query(
    `with lowered as (
       update rate_limits set hits = hits - 1
        where key = $1 and window_start = $2 and hits > 1
       returning 1
     )
     delete from rate_limits where key = $1 and window_start = $2 and hits <= 1`,
    [key, windowStart],
  );
}
