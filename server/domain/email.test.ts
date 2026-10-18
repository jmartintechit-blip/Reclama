import { describe, expect, it } from 'vitest';
import { EMAIL_MAX_LENGTH, normalizeEmail } from './email.ts';

describe('normalizeEmail', () => {
  it('trims and lowercases a valid address', () => {
    expect(normalizeEmail('  Pay@Acme.COM ')).toBe('pay@acme.com');
  });

  it.each([
    '',
    'plain',
    'a@b',
    'a b@example.com',
    'a@x.com,b@y.com',
    'a@x.com;b@y.com',
    '<a@x.com>',
    '"a"@x.com',
    'Ana <a@x.com>',
    'a@x..com',
    'ñ@example.com',
  ])('rejects %j', (value) => {
    expect(normalizeEmail(value)).toBeNull();
  });

  it('accepts the maximum length and rejects one more', () => {
    const domain = '@example.com';
    const at = (length: number) => 'a'.repeat(length - domain.length) + domain;

    expect(normalizeEmail(at(EMAIL_MAX_LENGTH))).not.toBeNull();
    expect(normalizeEmail(at(EMAIL_MAX_LENGTH + 1))).toBeNull();
  });
});
