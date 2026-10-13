import { argon2Sync, randomBytes } from 'node:crypto';
import * as crypto from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  hashPassword,
  needsRehash,
  validatePassword,
  verifyAgainstDummy,
  verifyPassword,
} from './password.ts';

// Wrap the real argon2 in a spy, to count how many hashes a call really computes.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, argon2: vi.fn(actual.argon2) };
});

const PASSWORD = 'correct horse battery';
const WRONG = 'correct horse batterz';
const PHC_SHAPE =
  /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/;

const argon2Calls = () => vi.mocked(crypto.argon2).mock.calls.length;

// Builds a valid hash with chosen parameters (the module only produces the current ones).
function makeStored(
  password: string,
  m: number,
  t: number,
  p: number,
  tag = 32,
): string {
  const salt = randomBytes(16);
  const hash = argon2Sync('argon2id', {
    message: password.normalize('NFKC'),
    nonce: salt,
    memory: m,
    passes: t,
    parallelism: p,
    tagLength: tag,
  });
  const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');
  return `$argon2id$v=19$m=${String(m)},t=${String(t)},p=${String(p)}$${b64(salt)}$${b64(hash)}`;
}

// A valid hash with the current parameters, built synchronously so describe-time tables can
// use its salt and hash fields.
const SAMPLE = makeStored(PASSWORD, 19456, 2, 1);
const [, , , SAMPLE_PARAMS = '', SALT = '', HASH = ''] = SAMPLE.split('$');

let stored: string;

beforeAll(async () => {
  stored = await hashPassword(PASSWORD);
});

afterEach(() => {
  vi.mocked(crypto.argon2).mockClear();
  vi.restoreAllMocks();
});

describe('validatePassword', () => {
  it('accepts 10 and 128 characters, rejects 9 and 129', () => {
    expect(validatePassword('a'.repeat(10))).toEqual({ ok: true });
    expect(validatePassword('a'.repeat(128))).toEqual({ ok: true });
    expect(validatePassword('a'.repeat(9))).toEqual({
      ok: false,
      code: 'TOO_SHORT',
    });
    expect(validatePassword('a'.repeat(129))).toEqual({
      ok: false,
      code: 'TOO_LONG',
    });
  });

  it('counts code points: a 4-byte emoji is one character', () => {
    expect(validatePassword('😀'.repeat(10)).ok).toBe(true);
    expect(validatePassword('😀'.repeat(128)).ok).toBe(true);
    expect(validatePassword('😀'.repeat(9))).toEqual({
      ok: false,
      code: 'TOO_SHORT',
    });
    expect(validatePassword('😀'.repeat(129))).toEqual({
      ok: false,
      code: 'TOO_LONG',
    });
  });

  it('has no composition rules', () => {
    expect(validatePassword('          ').ok).toBe(true);
    expect(validatePassword('aaaaaaaaaaaa').ok).toBe(true);
  });

  it('rejects a huge string as TOO_LONG', () => {
    expect(validatePassword('a'.repeat(1_000_000))).toEqual({
      ok: false,
      code: 'TOO_LONG',
    });
  });

  it.each([undefined, null, 12345678901, {}, ['a'.repeat(10)]])(
    'rejects a non-string (%s)',
    (value) => {
      expect(validatePassword(value)).toEqual({
        ok: false,
        code: 'NOT_A_STRING',
      });
    },
  );

  it('rejects a lone surrogate', () => {
    expect(validatePassword('a'.repeat(10) + '\ud800')).toEqual({
      ok: false,
      code: 'MALFORMED_UNICODE',
    });
  });
});

describe('hashPassword', () => {
  it('produces a PHC string with the current parameters', () => {
    expect(stored).toMatch(PHC_SHAPE);
  });

  it('gives a different hash each time (random salt)', async () => {
    const other = await hashPassword(PASSWORD);
    expect(other).toMatch(PHC_SHAPE);
    expect(other).not.toBe(stored);
  });

  it('refuses an invalid password without echoing it', async () => {
    const error = await hashPassword('short').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).not.toContain('short');
    expect(argon2Calls()).toBe(0);
  });

  it('does not contain the password', () => {
    expect(stored).not.toContain(PASSWORD);
  });
});

describe('verifyPassword', () => {
  it('accepts the right password and rejects a wrong one', async () => {
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyPassword(WRONG, stored)).toBe(false);
  });

  it('verifies the same visible password in composed and decomposed form', async () => {
    const composed = 'café con leche!';
    const decomposed = 'café con leche!';
    expect(composed).not.toBe(decomposed);
    const hash = await hashPassword(composed);
    expect(await verifyPassword(decomposed, hash)).toBe(true);
    expect(await verifyPassword(composed, hash)).toBe(true);
    expect(await verifyPassword(composed + '.', hash)).toBe(false);
  });

  it('reads the parameters from the stored string', async () => {
    const lighter = makeStored(PASSWORD, 8192, 3, 2, 24);
    expect(await verifyPassword(PASSWORD, lighter)).toBe(true);
    expect(await verifyPassword(WRONG, lighter)).toBe(false);
  });

  it('returns false for a non-string or an over-long password, without hashing', async () => {
    expect(await verifyPassword(undefined, stored)).toBe(false);
    expect(await verifyPassword(123, stored)).toBe(false);
    expect(await verifyPassword('a'.repeat(129), stored)).toBe(false);
    expect(await verifyPassword('a'.repeat(1_000_000), stored)).toBe(false);
    expect(argon2Calls()).toBe(0);
  });

  describe('malformed or unsupported stored values', () => {
    const prefix = '$argon2id$v=19$m=19456,t=2,p=1';
    const salt = SALT;
    const hash = HASH;
    const params = (p: string) => `$argon2id$v=19$${p}$${salt}$${hash}`;

    // None of these may reach crypto.argon2, so none can allocate memory.
    const rejected: [string, string][] = [
      ['empty', ''],
      ['garbage', 'not a hash at all'],
      [
        'bcrypt',
        '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234',
      ],
      ['argon2i', `$argon2i$v=19$m=19456,t=2,p=1$${salt}$${hash}`],
      ['argon2d', `$argon2d$v=19$m=19456,t=2,p=1$${salt}$${hash}`],
      ['old version', `$argon2id$v=16$m=19456,t=2,p=1$${salt}$${hash}`],
      ['no version', `$argon2id$m=19456,t=2,p=1$${salt}$${hash}`],
      ['missing hash', `${prefix}$${salt}`],
      ['missing salt and hash', prefix],
      ['bad base64 in hash', `${prefix}$${salt}$${hash.slice(0, 40)}!!!`],
      ['padded base64', `${prefix}$${salt}$${hash}=`],
      ['bad base64 in salt', `${prefix}$${salt.slice(0, 20)}!!$${hash}`],
      ['trailing newline', `${stored}\n`],
      ['leading space', ` ${stored}`],
      ['extra field', `${stored}$extra`],
      ['m huge', params('m=4294967295,t=2,p=1')],
      ['m just over the bound', params('m=65537,t=2,p=1')],
      ['m beyond number precision', params('m=99999999999999999999,t=2,p=1')],
      ['t huge', params('m=19456,t=4294967295,p=1')],
      ['p huge', params('m=19456,t=2,p=16777215')],
      ['m zero', params('m=0,t=2,p=1')],
      ['t zero', params('m=19456,t=0,p=1')],
      ['p zero', params('m=19456,t=2,p=0')],
      ['m below 8 * p', params('m=16,t=2,p=4')],
      ['leading zero', params('m=019456,t=2,p=1')],
      ['negative', params('m=-19456,t=2,p=1')],
      ['wrong order', params('t=2,m=19456,p=1')],
      ['extra parameter', params('m=19456,t=2,p=1,keyid=a')],
      ['salt too short', `${prefix}$AAAA$${hash}`],
      ['hash too short', `${prefix}$${salt}$AAAA`],
      ['1 MB of junk', '$argon2id$v=19$' + 'x'.repeat(1_000_000)],
    ];

    it.each(rejected)('returns false for %s', async (_name, value) => {
      await expect(verifyPassword(PASSWORD, value)).resolves.toBe(false);
      expect(argon2Calls()).toBe(0);
    });

    it('returns false (not an exception) when node rejects the parameters', async () => {
      // Within our bounds, but below what node:crypto accepts: it throws, we answer false.
      await expect(
        verifyPassword(PASSWORD, params('m=8,t=1,p=1')),
      ).resolves.toBe(false);
    });
  });
});

describe('needsRehash', () => {
  it('is false for a hash made with the current parameters', () => {
    expect(needsRehash(stored)).toBe(false);
  });

  it('is false for stronger parameters', () => {
    expect(needsRehash(makeStored(PASSWORD, 24576, 3, 2))).toBe(false);
  });

  it.each([
    ['lower memory', 'm=19455,t=2,p=1'],
    ['fewer passes', 'm=19456,t=1,p=1'],
  ])('is true for %s', (_name, params) => {
    expect(needsRehash(`$argon2id$v=19$${params}$${SALT}$${HASH}`)).toBe(true);
  });

  it('is true for a shorter tag or salt', () => {
    expect(needsRehash(makeStored(PASSWORD, 19456, 2, 1, 16))).toBe(true);
    expect(
      needsRehash(`$argon2id$v=19$${SAMPLE_PARAMS}$AAAAAAAAAAAAAAA$${HASH}`),
    ).toBe(true);
  });

  it.each(['', 'garbage', '$2b$10$abcdefghijklmnopqrstuu'])(
    'is true for an unreadable value (%j)',
    (value) => {
      expect(needsRehash(value)).toBe(true);
    },
  );

  it('is true for a value with parameters above the safety bounds', () => {
    expect(
      needsRehash(`$argon2id$v=19$m=4294967295,t=2,p=1$${SALT}$${HASH}`),
    ).toBe(true);
  });
});

describe('verifyAgainstDummy', () => {
  it('computes exactly one argon2id, like a real verification', async () => {
    await verifyAgainstDummy('nobody@example.com password');
    expect(argon2Calls()).toBe(1);
    await verifyPassword(PASSWORD, stored);
    expect(argon2Calls()).toBe(2);
  });

  it('also spends the time for input that can never match', async () => {
    await verifyAgainstDummy(undefined);
    await verifyAgainstDummy('a'.repeat(1_000));
    expect(argon2Calls()).toBe(2);
  });

  it('takes the same order of time as a real verification', async () => {
    const timeOf = async (run: () => Promise<unknown>) => {
      const start = performance.now();
      await run();
      return performance.now() - start;
    };
    const real = await timeOf(() => verifyPassword(PASSWORD, stored));
    const dummy = await timeOf(() => verifyAgainstDummy(PASSWORD));
    // Loose on purpose: both do real argon2 work (about 40 ms here), neither is skipped.
    expect(real).toBeGreaterThan(10);
    expect(dummy).toBeGreaterThan(10);
  });
});

describe('secrets', () => {
  it('never logs or prints a password', async () => {
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'debug'),
      vi.spyOn(process.stdout, 'write'),
      vi.spyOn(process.stderr, 'write'),
    ];
    const hash = await hashPassword(PASSWORD);
    await verifyPassword(PASSWORD, hash);
    await verifyPassword(WRONG, 'garbage');
    await verifyAgainstDummy(PASSWORD);
    await hashPassword('short').catch(() => undefined);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
