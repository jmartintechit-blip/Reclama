import { createHash } from 'node:crypto';
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

// TEMPORARY probes, deleted together with the PDF smoke endpoint after the T08 gate.
// "Muñoz S.L.;1.234,56;31/12/2025\r\n" in windows-1252: the ñ is the single byte 0xf1 (in UTF-8 it would be c3 b1).
const WINDOWS_1252_CSV = Buffer.concat([
  Buffer.from('Mu', 'latin1'),
  Buffer.from([0xf1]),
  Buffer.from('oz S.L.;1.234,56;31/12/2025\r\n', 'latin1'),
]);

describe('temporary probe endpoints', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await listen(createApp()));
  });

  afterAll(async () => {
    await close(server);
  });

  function postEchoBytes(body: string) {
    return fetch(`${baseUrl}/api/smoke/echo-bytes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  }

  it('GET /api/smoke/probe reports the runtime and two argon2id timings', async () => {
    const res = await fetch(`${baseUrl}/api/smoke/probe`);
    const { data } = (await res.json()) as {
      data: {
        node: string;
        ip: unknown;
        argon2: { available: boolean; first_ms: unknown; second_ms: unknown };
      };
    };

    expect(res.status).toBe(200);
    expect(data.node).toMatch(/^v\d+\./);
    expect(['string', 'object']).toContain(typeof data.ip); // a string, or null
    expect(data.argon2.available).toBe(true);
    expect(Number.isInteger(data.argon2.first_ms)).toBe(true);
    expect(Number.isInteger(data.argon2.second_ms)).toBe(true);
  });

  it('GET /api/smoke/cookie?n=1 sets one Set-Cookie header with the hardened attributes', async () => {
    const res = await fetch(`${baseUrl}/api/smoke/cookie?n=1`);

    const cookies = res.headers.getSetCookie();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { set: 1 } });
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^__Host-probe1=1; /);
    for (const attribute of [
      'Path=/',
      'Secure',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=60',
    ]) {
      expect(cookies[0]?.split('; ')).toContain(attribute);
    }
  });

  it('GET /api/smoke/cookie?n=2 sets two Set-Cookie headers', async () => {
    const res = await fetch(`${baseUrl}/api/smoke/cookie?n=2`);

    expect(await res.json()).toEqual({ data: { set: 2 } });
    expect(
      res.headers.getSetCookie().map((cookie) => cookie.split('=')[0]),
    ).toEqual(['__Host-probe1', '__Host-probe2']);
  });

  it.each(['?n=3', '?n=', '?n=1&n=2', ''])(
    'GET /api/smoke/cookie%s answers 400 INVALID_QUERY and sets no cookie',
    async (query) => {
      const res = await fetch(`${baseUrl}/api/smoke/cookie${query}`);

      expect(res.status).toBe(400);
      expect(res.headers.getSetCookie()).toHaveLength(0);
      expect(await res.json()).toEqual({
        error: {
          code: 'INVALID_QUERY',
          message: 'n must be 1 or 2',
          request_id: res.headers.get('x-request-id'),
        },
      });
    },
  );

  it('POST /api/smoke/echo-bytes returns the size and SHA-256 of the decoded windows-1252 bytes', async () => {
    const res = await postEchoBytes(
      JSON.stringify({ csv_base64: WINDOWS_1252_CSV.toString('base64') }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        bytes: WINDOWS_1252_CSV.length,
        sha256: createHash('sha256').update(WINDOWS_1252_CSV).digest('hex'),
      },
    });
  });

  it.each([
    ['an array', '[]'],
    ['an object without the field', '{}'],
    ['a field that is not a string', '{"csv_base64":42}'],
    ['characters outside the alphabet', '{"csv_base64":"TXVub3o!"}'],
    ['a line break inside', '{"csv_base64":"TXVu\\nb3o="}'],
    ['missing padding', '{"csv_base64":"TXVub3o"}'],
    ['too much padding', '{"csv_base64":"TXVub3o=="}'],
    ['padding in the middle', '{"csv_base64":"TQ==TQ=="}'],
  ])(
    'POST /api/smoke/echo-bytes rejects %s with 400 INVALID_BODY',
    async (_name, body) => {
      const res = await postEchoBytes(body);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: {
          code: 'INVALID_BODY',
          message: 'csv_base64 must be a base64 string',
          request_id: res.headers.get('x-request-id'),
        },
      });
    },
  );
});
