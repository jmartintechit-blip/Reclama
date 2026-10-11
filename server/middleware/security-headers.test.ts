import type { Server } from 'node:http';
import express from 'express';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import { createApp } from '../app.ts';
import { close, listen } from '../test-utils.ts';
import { errorHandler } from './errors.ts';
import { requestId } from './request-id.ts';
import { securityHeaders } from './security-headers.ts';

// The three headers of plan section 7.
async function expectSecurityHeaders(res: Response) {
  await res.arrayBuffer(); // read the body to the end, so the connection is released
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
}

const jsonPost = (body: string): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body,
});

const cases: {
  name: string;
  status: number;
  path: string;
  init?: RequestInit;
}[] = [
  { name: '200 JSON', status: 200, path: '/api/health' },
  { name: '404', status: 404, path: '/api/does-not-exist' },
  {
    name: '400 (bad JSON)',
    status: 400,
    path: '/api/health',
    init: jsonPost('{"broken":'),
  },
  {
    name: '413 (body over the limit)',
    status: 413,
    path: '/api/health',
    init: jsonPost(JSON.stringify({ padding: 'a'.repeat(20_000) })),
  },
  { name: '200 PDF', status: 200, path: '/api/smoke/pdf' },
];

describe('createApp security headers', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await listen(createApp()));
  });

  afterAll(async () => {
    await close(server);
  });

  it.each(cases)(
    'sends them, and no ETag, on a $name answer',
    async ({ status, path, init }) => {
      const res = await fetch(`${baseUrl}${path}`, init);

      expect(res.status).toBe(status);
      await expectSecurityHeaders(res);
      expect(res.headers.has('etag')).toBe(false);
    },
  );
});

describe('securityHeaders on a 500 answer', () => {
  let server: Server;
  let baseUrl: string;
  let consoleError: MockInstance<typeof console.error>;

  beforeAll(async () => {
    // Not createApp(): a bare app with the real handlers, so the app has no test-only routes.
    // createApp() itself cannot be made to fail with a normal request.
    const app = express();
    app.use(securityHeaders);
    app.use(requestId);
    app.get('/boom', () => {
      throw new Error('unexpected failure');
    });
    app.use(errorHandler);
    ({ server, baseUrl } = await listen(app));
  });

  afterAll(async () => {
    await close(server);
  });

  beforeEach(() => {
    consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('sends them', async () => {
    const res = await fetch(`${baseUrl}/boom`);

    expect(res.status).toBe(500);
    await expectSecurityHeaders(res);
  });
});
