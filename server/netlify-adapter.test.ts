import { createHash } from 'node:crypto';
import express from 'express';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import { createApp } from './app.ts';
import { errorHandler } from './middleware/errors.ts';
import { requestId } from './middleware/request-id.ts';
import {
  createNetlifyHandler,
  type NetlifyContext,
} from './netlify-adapter.ts';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// What Netlify passes next to every Request. The adapter chain only reads requestId.
const context: NetlifyContext = { requestId: 'test-netlify-request-id' };

// The real app, wrapped as the Function wraps it (netlify/functions/api.ts).
const api = createNetlifyHandler(createApp());

// Routes that the real app does not have (a POST, req.ip, cookies, a crash) live in a tiny app of our own,
// wrapped by the same createNetlifyHandler. createApp() gets no test-only routes.
const scratchApp = express();
scratchApp.use(requestId);
scratchApp.use(express.json());
scratchApp.post('/echo', (req, res) => {
  res.json(req.body);
});
// Every byte value 0x00-0xff after a PDF-like prefix: any pass through UTF-8 text would damage it.
const ALL_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.7\n', 'latin1'),
  Buffer.from(Array.from({ length: 256 }, (_unused, byte) => byte)),
]);
scratchApp.get('/binary', (_req, res) => {
  res.type('application/pdf').send(ALL_BYTES);
});
// Answers the SHA-256 of the bytes that base64 in the JSON body decodes to.
scratchApp.post('/sha256', (req, res) => {
  const { csv_base64: csvBase64 } = req.body as { csv_base64: string };
  const bytes = Buffer.from(csvBase64, 'base64');
  res.json({
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
});
scratchApp.get('/ip', (req, res) => {
  res.json({ ip: req.ip });
});
// maxAge makes Express add an Expires date, and that date contains a comma.
scratchApp.get('/one-cookie', (_req, res) => {
  res.cookie('a', '1', { maxAge: 60_000 });
  res.end();
});
scratchApp.get('/two-cookies', (_req, res) => {
  res.cookie('a', '1', { maxAge: 60_000 });
  res.cookie('b', '2', { maxAge: 60_000 });
  res.end();
});
scratchApp.get('/boom', () => {
  throw new Error('the database rejected the row of ana@example.com');
});
scratchApp.use(errorHandler);
const scratch = createNetlifyHandler(scratchApp);

function call(
  handler: typeof api,
  path: string,
  headers?: Record<string, string>,
) {
  return handler(new Request(`http://localhost${path}`, { headers }), context);
}

// The error shape of plan section 5, whose request_id must be the one sent in the X-Request-Id header.
function errorBody(res: Response, code: string, message: string) {
  return {
    error: { code, message, request_id: res.headers.get('x-request-id') },
  };
}

describe('createNetlifyHandler with the real app', () => {
  it('answers GET /api/health with 200, a JSON body and an X-Request-Id', async () => {
    const res = await call(api, '/api/health');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('x-request-id')).toMatch(UUID_V4);
    expect(await res.json()).toEqual({ data: { status: 'ok' } });
  });

  it('delivers the security headers that the app sets from code', async () => {
    const res = await call(api, '/api/health');
    await res.arrayBuffer();

    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'none'",
    );
  });

  it('keeps the 404 error shape', async () => {
    const res = await call(api, '/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(errorBody(res, 'NOT_FOUND', 'Not found'));
  });
});

describe('createNetlifyHandler with a scratch app', () => {
  it('passes a JSON POST body to the route', async () => {
    const payload = { name: 'Muñoz Hermanos S.L.', amount: '1.234,56 €' };

    const res = await scratch(
      new Request('http://localhost/echo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
      context,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
  });

  it('sends a PDF-typed body with byte-identical content', async () => {
    const res = await call(scratch, '/binary');
    // arrayBuffer(), never text(): text() decodes the body as UTF-8 and would damage the binary bytes.
    const bytes = Buffer.from(await res.arrayBuffer());

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(bytes.equals(ALL_BYTES)).toBe(true);
    expect(res.headers.get('content-length')).toBe(String(ALL_BYTES.length));
  });

  // "Muñoz S.L.;1.234,56 €" in windows-1252 (ñ = 0xf1, € = 0x80); in UTF-8 they would be c3 b1 and e2 82 ac.
  it('keeps windows-1252 bytes sent as base64 inside JSON intact', async () => {
    const csv = Buffer.concat([
      Buffer.from('Mu', 'latin1'),
      Buffer.from([0xf1]),
      Buffer.from('oz S.L.;1.234,56 ', 'latin1'),
      Buffer.from([0x80]),
    ]);

    const res = await scratch(
      new Request('http://localhost/sha256', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv_base64: csv.toString('base64') }),
      }),
      context,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      bytes: csv.length,
      sha256: createHash('sha256').update(csv).digest('hex'),
    });
  });

  describe('req.ip', () => {
    it('is the client IP that Netlify provides', async () => {
      const res = await call(scratch, '/ip', {
        'x-nf-client-connection-ip': '203.0.113.7',
      });

      expect(await res.json()).toEqual({ ip: '203.0.113.7' });
    });

    it('does not change with a spoofed X-Forwarded-For', async () => {
      const res = await call(scratch, '/ip', {
        'x-nf-client-connection-ip': '203.0.113.7',
        'x-forwarded-for': '6.6.6.6, 7.7.7.7',
      });

      expect(await res.json()).toEqual({ ip: '203.0.113.7' });
    });

    it('is "unknown" without the Netlify header, whatever X-Forwarded-For says', async () => {
      const res = await call(scratch, '/ip', { 'x-forwarded-for': '6.6.6.6' });

      expect(await res.json()).toEqual({ ip: 'unknown' });
    });
  });

  describe('Set-Cookie', () => {
    it('stays one header for one cookie, with the comma of its Expires date', async () => {
      const res = await call(scratch, '/one-cookie');

      const cookies = res.headers.getSetCookie();
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toMatch(
        /^a=1; .*Expires=[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} /,
      );
    });

    it('stays two separate headers for two cookies', async () => {
      const res = await call(scratch, '/two-cookies');

      const names = res.headers
        .getSetCookie()
        .map((cookie) => cookie.split('=')[0]);
      expect(names).toEqual(['a', 'b']);
    });
  });

  describe('with an unexpected error', () => {
    let consoleError: MockInstance<typeof console.error>;

    beforeEach(() => {
      consoleError = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
    });

    afterEach(() => {
      consoleError.mockRestore();
    });

    it('keeps the 500 error shape', async () => {
      const res = await call(scratch, '/boom');

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual(
        errorBody(res, 'INTERNAL_ERROR', 'Internal server error'),
      );
    });
  });
});
