// The PDF letter uses the standard Helvetica font, which can only draw the characters of
// Windows-1252 (WinAnsi). This module is the single gate for text that a user typed and that
// ends up in the PDF.

// Every character that Windows-1252 can show: printable ASCII, the printable part of 0x80-0x9F
// (euro sign, curly quotes, dashes...) and 0xA0-0xFF. The WHATWG decoder is the source, so the
// table cannot drift from the real code page. Bytes with no character (0x81, 0x8D, 0x8F, 0x90,
// 0x9D) decode to C1 controls and are left out.
const WIN_ANSI: ReadonlySet<string> = (() => {
  const decoder = new TextDecoder('windows-1252');
  const chars = new Set<string>();
  for (let byte = 0x20; byte <= 0xff; byte += 1) {
    if (byte === 0x7f) continue;
    const char = decoder.decode(new Uint8Array([byte]));
    if (!/\p{Cc}/u.test(char)) chars.add(char);
  }
  return chars;
})();

// Letters that Unicode does not decompose into a base letter plus a mark, and dash variants.
const LOOKALIKES: Readonly<Record<string, string>> = {
  Ł: 'L',
  ł: 'l',
  Đ: 'D',
  đ: 'd',
  Ħ: 'H',
  ħ: 'h',
  ı: 'i',
  '\u2010': '-',
  '\u2011': '-',
  '\u2012': '-',
  '\u2212': '-',
};

const LINE_WHITESPACE = /[\t\n\r]/u;
// Dropped: other control characters, invisible format characters (zero width, bidi overrides,
// soft hyphen) and the line/paragraph separators.
const DROPPED = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

// Makes `input` safe to draw with Helvetica. Never throws and never truncates. In order:
//   1. The text is normalised to NFC, so "n" + combining tilde becomes the single letter "ñ".
//   2. Tab, line feed and carriage return become a normal space (a name must not glue two
//      words together). Every other control character, every invisible format character
//      (zero width, left-to-right/right-to-left marks and overrides, soft hyphen) and the line
//      and paragraph separators are dropped.
//   3. Characters that Windows-1252 supports stay exactly as they are (ñ á ü € ª º « » ...).
//   4. Other spaces (em space, ideographic space...) become a normal space.
//   5. Any other character is replaced by the closest Windows-1252 equivalent when there is
//      one: a table for ł đ ħ ı and dash variants, otherwise its NFKD decomposition without
//      the combining marks (ș -> s, ő -> o, ﬁ -> fi). A character with no equivalent (CJK,
//      emoji) becomes "?", one per code point; a lone combining mark is dropped.
// `replaced` is true when the result differs from the NFC-normalised input, that is, when
// anything was dropped or replaced (normalisation alone is lossless and does not count).
export function sanitizeForPdf(input: string): {
  text: string;
  replaced: boolean;
} {
  const normalized = input.normalize('NFC');
  let text = '';
  for (const char of normalized) {
    if (LINE_WHITESPACE.test(char)) {
      text += ' ';
    } else if (DROPPED.test(char)) {
      continue;
    } else if (WIN_ANSI.has(char)) {
      text += char;
    } else if (/\p{Zs}/u.test(char)) {
      text += ' ';
    } else {
      const mapped =
        LOOKALIKES[char] ?? char.normalize('NFKD').replace(/\p{M}/gu, '');
      if (mapped === '') continue;
      text += Array.from(mapped).every((c) => WIN_ANSI.has(c)) ? mapped : '?';
    }
  }
  return { text, replaced: text !== normalized };
}
