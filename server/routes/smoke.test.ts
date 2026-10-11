import type { Server } from 'node:http';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.ts';
import { renderSmokePdf } from '../pdf/smoke.ts';
import { close, listen } from '../test-utils.ts';

// "€ áéíóúñ ÁÉÍÓÚÑ ü ¿¡" as the WinAnsi (Windows-1252) bytes PDFKit must write for a standard font.
// Typed by hand, not made with an encoder, so the test does not trust the code it checks.
const ACCENT_LINE_WINANSI_HEX = [
  '80', // €
  '20', // space
  'e1e9edf3faf1', // áéíóúñ
  '20',
  'c1c9cdd3dad1', // ÁÉÍÓÚÑ
  '20',
  'fc', // ü
  '20',
  'bfa1', // ¿¡
].join('');

async function getSmokePdf(baseUrl: string) {
  const res = await fetch(`${baseUrl}/api/smoke/pdf`);
  // arrayBuffer(), never text(): text() decodes the body as UTF-8 and would damage the binary bytes.
  const bytes = Buffer.from(await res.arrayBuffer());
  return { res, bytes };
}

// No PDF parser: the page text is in Flate-compressed streams, so find them and inflate them.
// "latin1" turns each byte into one character, so the bytes survive the trip to a string and back.
// Inflating also proves the bytes arrived untouched: zlib throws if any byte of a stream is damaged.
function inflateStreams(pdf: Buffer): string {
  return [...pdf.toString('latin1').matchAll(/stream\n([\s\S]*?)\nendstream/g)]
    .map(([, body = '']) =>
      inflateSync(Buffer.from(body, 'latin1')).toString('latin1'),
    )
    .join('\n');
}

describe('GET /api/smoke/pdf', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await listen(createApp()));
  });

  afterAll(async () => {
    await close(server);
  });

  it('answers 200 with the PDF as a download', async () => {
    const { res } = await getSmokePdf(baseUrl);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="smoke.pdf"',
    );
  });

  it('sends the bytes intact', async () => {
    const { res, bytes } = await getSmokePdf(baseUrl);

    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.subarray(-6).toString('latin1')).toMatch(/%%EOF\n?$/);
    expect(res.headers.get('content-length')).toBe(String(bytes.length));
  });

  it('writes the accent line as WinAnsi bytes', async () => {
    const { bytes } = await getSmokePdf(baseUrl);

    // PDFKit writes standard-font text as hex strings. A kerning adjustment can split one line
    // into several strings, so join them all before looking for the line.
    const textHex = [...inflateStreams(bytes).matchAll(/<([0-9a-f]+)>/gi)]
      .map(([, hex = '']) => hex)
      .join('')
      .toLowerCase();

    expect(textHex).toContain(ACCENT_LINE_WINANSI_HEX);
  });

  it('declares the standard Helvetica font with WinAnsiEncoding', async () => {
    const { bytes } = await getSmokePdf(baseUrl);

    // The font dictionary is plain text (only the page streams are compressed).
    const fontDictionary =
      /<<[^<>]*\/BaseFont \/Helvetica[^<>]*>>/.exec(
        bytes.toString('latin1'),
      )?.[0] ?? '';

    expect(fontDictionary).toContain('/Encoding /WinAnsiEncoding');
  });
});

describe('renderSmokePdf', () => {
  it('gives the same bytes at any time, so a deployed copy can be compared by hash', async () => {
    // Only Date is faked: the two renders happen "months apart" while streams and promises run normally.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const first = await renderSmokePdf();
      vi.setSystemTime(new Date('2026-06-01T12:34:56Z'));
      const second = await renderSmokePdf();

      expect(second.equals(first)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
