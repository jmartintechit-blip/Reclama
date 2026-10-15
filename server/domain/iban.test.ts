import { describe, expect, it } from 'vitest';
import { parseIban } from './iban.ts';

describe('parseIban', () => {
  it.each([
    ['ES91 2100 0418 4502 0005 1332', 'ES9121000418450200051332'],
    ['es91 2100 0418 4502 0005 1332', 'ES9121000418450200051332'],
    ['  ES91\u00a021000418450200051332  ', 'ES9121000418450200051332'], // non-breaking space
    ['GB82 WEST 1234 5698 7654 32', 'GB82WEST12345698765432'], // letters in the account part
    ['DE89 3704 0044 0532 0130 00', 'DE89370400440532013000'],
    ['FR20 2100 0418 4502 0005 1332 9', 'FR20210004184502000513329'], // 25 characters is fine outside Spain
  ])('accepts %j and returns %j', (input, expected) => {
    expect(parseIban(input)).toBe(expected);
  });

  it.each([
    ['a wrong check digit', 'ES92 2100 0418 4502 0005 1332'],
    ['a changed digit', 'ES91 2100 0418 4502 0005 1333'],
    ['two swapped digits', 'ES91 2100 0418 4502 0005 1323'],
    [
      'ES with 23 characters although its checksum is valid',
      'ES26 2100 0418 4502 0005 1332 9',
    ],
    ['ES with letters', 'ES91 2100 0418 4502 0005 133A'],
    ['35 characters', 'GB82 WEST 1234 5698 7654 3200'],
    ['too short', 'ES91'],
    ['empty', ''],
    ['only spaces', '   '],
    ['digits where the country goes', '1291 2100 0418 4502 0005 1332'],
    ['a letter in the check digits', 'ESA1 2100 0418 4502 0005 1332'],
    ['a dash', 'ES91-2100-0418-4502-0005-1332'],
    [
      'a non-ASCII letter that upper-cases to ASCII',
      'GB82 WEST 1234 5698 7654 3\u0131',
    ],
  ])('rejects %s', (_label, input) => {
    expect(parseIban(input)).toBeNull();
  });

  it('accepts the same digits under another country code once the checksum matches (control)', () => {
    expect(parseIban('FR20 2100 0418 4502 0005 1332 9')).not.toBeNull();
    expect(parseIban('ES26 2100 0418 4502 0005 1332 9')).toBeNull();
  });
});
