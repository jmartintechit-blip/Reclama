import { describe, expect, it } from 'vitest';
import { sanitizeForPdf } from './pdf-text.ts';

const clean = (input: string) => sanitizeForPdf(input).text;

describe('sanitizeForPdf', () => {
  it('keeps everything Windows-1252 supports exactly as it is', () => {
    const text = 'Ñandú Ángel Güell € ª º « » ¿ ¡ ß “quoted” – — … ç Ç ÿ Ž';
    expect(sanitizeForPdf(text)).toEqual({ text, replaced: false });
  });

  it('composes decomposed letters (NFC) without calling it a replacement', () => {
    const decomposed = 'n\u0303a\u0301'; // n + tilde, a + acute
    expect(sanitizeForPdf(decomposed)).toEqual({ text: 'ñá', replaced: false });
  });

  it.each([
    ['ł', 'l'],
    ['Ł', 'L'],
    ['ș', 's'],
    ['Ț', 'T'],
    ['ő', 'o'],
    ['ž', 'ž'], // already Windows-1252
    ['ğ', 'g'],
    ['ı', 'i'],
    ['ﬁ', 'fi'],
    ['\u2212', '-'],
  ])('replaces %s by its closest equivalent %s', (char, expected) => {
    expect(clean(`a${char}b`)).toBe(`a${expected}b`);
  });

  it('flags a replacement', () => {
    expect(sanitizeForPdf('Łukasz')).toEqual({
      text: 'Lukasz',
      replaced: true,
    });
    expect(sanitizeForPdf('Lukasz').replaced).toBe(false);
  });

  it('replaces characters without an equivalent by one "?" per character', () => {
    expect(clean('株式会社')).toBe('????');
    expect(clean('Pago 💸')).toBe('Pago ?');
    expect(clean('x\u{1F600}\u{1F600}y')).toBe('x??y');
  });

  it('drops bidi overrides and other invisible format characters', () => {
    expect(clean('abc\u202Edef')).toBe('abcdef'); // right-to-left override
    expect(clean('a\u200Bb\u200Fc\u2066d\uFEFFe\u00ADf')).toBe('abcdef');
    expect(sanitizeForPdf('abc\u202Edef').replaced).toBe(true);
  });

  it('drops control characters and the separators of lines and paragraphs', () => {
    expect(clean('a\u0000b\u0007c\u001Bd\u0085e\u007Ff')).toBe('abcdef');
    expect(clean('a\u2028b\u2029c')).toBe('abc');
  });

  it('turns tabs and line breaks into a space so that two words stay two words', () => {
    expect(clean('Calle\nMayor\r\n5\tA')).toBe('Calle Mayor  5 A');
  });

  it('turns exotic spaces into a normal space and keeps the no-break space', () => {
    expect(clean('a\u2003b\u3000c')).toBe('a b c');
    expect(clean('a\u00A0b')).toBe('a\u00A0b');
  });

  it('drops a lone combining mark', () => {
    expect(clean('1\u0301')).toBe('1');
  });

  it('copes with empty and very long strings', () => {
    expect(sanitizeForPdf('')).toEqual({ text: '', replaced: false });
    const long = 'ł株'.repeat(50_000);
    expect(clean(long)).toBe('l?'.repeat(50_000));
  });

  it('only ever returns characters that Windows-1252 can show', () => {
    const everything = Array.from({ length: 0x3000 }, (_, i) =>
      String.fromCodePoint(i),
    ).join('');
    const decoder = new TextDecoder('windows-1252');
    const encodable = new Set(
      Array.from({ length: 256 }, (_, byte) =>
        decoder.decode(new Uint8Array([byte])),
      ),
    );
    for (const char of clean(everything)) {
      const code = char.codePointAt(0) ?? 0;
      expect(/\p{Cc}|\p{Cf}/u.test(char), `U+${code.toString(16)}`).toBe(false);
      expect(encodable.has(char), `U+${code.toString(16)}`).toBe(true);
    }
  });
});
