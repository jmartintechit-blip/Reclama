import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateToken, hashToken, readSessionToken } from './session.ts';

describe('generateToken', () => {
  it('makes 32 random bytes as 43 base64url characters, different every time', () => {
    const tokens = new Set(Array.from({ length: 50 }, generateToken));

    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    }
  });
});

describe('hashToken', () => {
  it('is the SHA-256 of the token text, 32 bytes', () => {
    const token = generateToken();

    expect(hashToken(token)).toEqual(
      createHash('sha256').update(token).digest(),
    );
    expect(hashToken(token)).toHaveLength(32);
  });
});

describe('readSessionToken', () => {
  const token = generateToken();

  it('finds the cookie among others, ignoring spaces', () => {
    expect(readSessionToken(`a=1; __Host-sid=${token} ;b=2`)).toBe(token);
    expect(readSessionToken(`__Host-sid=${token}`)).toBe(token);
  });

  it.each([
    ['no header', undefined],
    ['empty header', ''],
    ['other cookies only', 'a=1; b=2'],
    ['a similar name', `sid=${token}; __Secure-sid=${token}`],
    ['no value', '__Host-sid='],
    ['no equals sign', '__Host-sid'],
    ['too short', `__Host-sid=${token.slice(1)}`],
    ['too long', `__Host-sid=${token}A`],
    ['characters outside base64url', `__Host-sid=${'%'.repeat(43)}`],
    ['a quoted value', `__Host-sid="${token}"`],
    ['the cookie twice', `__Host-sid=${token}; __Host-sid=${token}`],
    ['a huge header', `__Host-sid=${'A'.repeat(100_000)}`],
  ])('returns null for %s', (_name, header) => {
    expect(readSessionToken(header)).toBeNull();
  });
});
