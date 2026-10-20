// Password hashing with argon2id from node:crypto. No dependency, and the
// asynchronous crypto.argon2 runs on the thread pool, so a login does not block the event loop.
import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

// OWASP Password Storage Cheat Sheet minimum for argon2id: 19 MiB of memory, 2 passes,
// 1 lane. Measured at 58-91 ms on the Netlify runtime. Raise these here and old hashes keep
// verifying (their parameters are read from the stored string); needsRehash flags them.
const CURRENT = {
  memory: 19456, // KiB
  passes: 2,
  parallelism: 1,
  tagLength: 32, // bytes
} as const;
const SALT_BYTES = 16;

// Upper bounds for parameters read from a stored string, so a tampered row cannot make the
// server allocate gigabytes or spin for minutes. Lower bounds come from node:crypto itself.
const MAX_MEMORY_KIB = 65536;
const MAX_PASSES = 10;
const MAX_PARALLELISM = 4;

export type PasswordErrorCode =
  'NOT_A_STRING' | 'MALFORMED_UNICODE' | 'TOO_SHORT' | 'TOO_LONG';

export type PasswordValidation =
  { ok: true } | { ok: false; code: PasswordErrorCode };

const fail = (code: PasswordErrorCode): PasswordValidation => ({
  ok: false,
  code,
});

// Length is counted in Unicode code points (a 4-byte emoji is one character) on what the
// user typed. No composition rules and no truncation.
export function validatePassword(plain: unknown): PasswordValidation {
  if (typeof plain !== 'string') return fail('NOT_A_STRING');
  // A code point takes at most 2 UTF-16 units: this avoids iterating a huge string.
  if (plain.length > PASSWORD_MAX_LENGTH * 2) return fail('TOO_LONG');
  // A lone surrogate would silently become U+FFFD when encoded, so two different passwords
  // could collide.
  if (!plain.isWellFormed()) return fail('MALFORMED_UNICODE');
  const length = Array.from(plain).length;
  if (length < PASSWORD_MIN_LENGTH) return fail('TOO_SHORT');
  if (length > PASSWORD_MAX_LENGTH) return fail('TOO_LONG');
  return { ok: true };
}

// Unicode NFKC before hashing and verifying: the same visible password typed on another
// keyboard or OS (composed "é" vs "e" + combining accent) must verify. Trade-off: NFKC also
// folds compatibility forms (full-width letters), as NIST SP 800-63B allows.
// Returns null for input that can never match, without spending any hashing time.
function toKeyMaterial(plain: unknown): Buffer | null {
  if (typeof plain !== 'string') return null;
  if (plain.length > PASSWORD_MAX_LENGTH * 2) return null;
  if (!plain.isWellFormed()) return null;
  if (Array.from(plain).length > PASSWORD_MAX_LENGTH) return null;
  return Buffer.from(plain.normalize('NFKC'), 'utf8');
}

interface KdfParams {
  memory: number;
  passes: number;
  parallelism: number;
  tagLength: number;
}

function derive(
  message: Buffer,
  salt: Buffer,
  params: KdfParams,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      { message, nonce: salt, ...params },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

// PHC string format, unpadded standard base64.
const toB64 = (bytes: Buffer): string =>
  bytes.toString('base64').replace(/=+$/, '');

function fromB64(text: string): Buffer | null {
  const bytes = Buffer.from(text, 'base64');
  // Buffer.from ignores bad characters and stray bits; only the canonical form is accepted.
  return toB64(bytes) === text ? bytes : null;
}

// Digits without leading zeros; the {n,m} limits on salt and hash are 8-64 bytes and
// 16-64 bytes. The regex is anchored and bounded, so a huge stored value fails fast.
const PHC =
  /^\$argon2id\$v=19\$m=([1-9]\d{0,9}),t=([1-9]\d{0,9}),p=([1-9]\d{0,9})\$([A-Za-z0-9+/]{11,86})\$([A-Za-z0-9+/]{22,86})$/;

interface ParsedHash extends KdfParams {
  salt: Buffer;
  hash: Buffer;
}

// Returns null for anything that is not a well-formed, supported, sanely-sized argon2id hash.
function parseStored(stored: string): ParsedHash | null {
  const match = PHC.exec(stored);
  if (!match) return null;
  const memory = Number(match[1]);
  const passes = Number(match[2]);
  const parallelism = Number(match[3]);
  const salt = fromB64(match[4] ?? '');
  const hash = fromB64(match[5] ?? '');
  if (salt === null || hash === null) return null;
  if (memory > MAX_MEMORY_KIB || memory < 8 * parallelism) return null;
  if (passes > MAX_PASSES || parallelism > MAX_PARALLELISM) return null;
  return { memory, passes, parallelism, tagLength: hash.length, salt, hash };
}

// Throws RangeError (never containing the password) for a password that fails
// validatePassword: callers validate first and answer 400.
export async function hashPassword(plain: string): Promise<string> {
  const message = validatePassword(plain).ok ? toKeyMaterial(plain) : null;
  if (message === null) throw new RangeError('Invalid password');
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(message, salt, CURRENT);
  return `$argon2id$v=19$m=${String(CURRENT.memory)},t=${String(CURRENT.passes)},p=${String(CURRENT.parallelism)}$${toB64(salt)}$${toB64(hash)}`;
}

// Never throws: a wrong password, a malformed or unsupported stored value and a password
// that can never match all give false. The minimum length is not enforced here, only the
// maximum (so a huge input cannot be used to burn CPU).
export async function verifyPassword(
  plain: unknown,
  stored: string,
): Promise<boolean> {
  const message = toKeyMaterial(plain);
  const parsed = parseStored(stored);
  if (message === null || parsed === null) return false;
  try {
    const actual = await derive(message, parsed.salt, parsed);
    return timingSafeEqual(actual, parsed.hash);
  } catch {
    return false;
  }
}

// True when the hash was made with weaker parameters than the current ones, or is not
// a hash this module can read: the caller can re-hash after a successful login.
export function needsRehash(stored: string): boolean {
  const parsed = parseStored(stored);
  return (
    parsed === null ||
    parsed.memory < CURRENT.memory ||
    parsed.passes < CURRENT.passes ||
    parsed.parallelism < CURRENT.parallelism ||
    parsed.tagLength < CURRENT.tagLength ||
    parsed.salt.length < SALT_BYTES
  );
}

// For a login with an unknown email: one argon2id with the current parameters and
// a random salt, whose result is thrown away, so that case takes as long as a real
// verification. Nothing is stored, so there is no fake hash in the repo or in memory.
export async function verifyAgainstDummy(plain: unknown): Promise<void> {
  await derive(
    toKeyMaterial(plain) ?? Buffer.alloc(0),
    randomBytes(SALT_BYTES),
    CURRENT,
  );
}
