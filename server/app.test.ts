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
import { createApp } from './app.ts';
import { getRegisteredRoutes } from './http/routes.ts';
import { errorHandler } from './middleware/errors.ts';
import { requestId } from './middleware/request-id.ts';
import { close, listen } from './test-utils.ts';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The error shape of plan section 5, whose request_id must be the one sent in the X-Request-Id header.
function errorBody(res: Response, code: string, message: string) {
  return {
    error: { code, message, request_id: res.headers.get('x-request-id') },
  };
}

describe('createApp', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await listen(createApp()));
  });

  afterAll(async () => {
    await close(server);
  });

  it('answers GET /api/health with 200 and the status body', async () => {
    const res = await fetch(`${baseUrl}/api/health`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { status: 'ok' } });
  });

  it('sends a different X-Request-Id UUID with every response', async () => {
    const first = await fetch(`${baseUrl}/api/health`);
    const second = await fetch(`${baseUrl}/api/health`);
    await Promise.all([first.text(), second.text()]);

    const firstId = first.headers.get('x-request-id');
    const secondId = second.headers.get('x-request-id');
    expect(firstId).toMatch(UUID_V4);
    expect(secondId).toMatch(UUID_V4);
    expect(firstId).not.toBe(secondId);
  });

  it('ignores an X-Request-Id sent by the client', async () => {
    const res = await fetch(`${baseUrl}/api/health`, {
      headers: { 'X-Request-Id': 'chosen-by-the-client' },
    });
    await res.text();

    expect(res.headers.get('x-request-id')).toMatch(UUID_V4);
  });

  it('does not send the x-powered-by header', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    await res.text();

    expect(res.headers.has('x-powered-by')).toBe(false);
  });

  it('answers an unknown route with 404 NOT_FOUND', async () => {
    const res = await fetch(`${baseUrl}/api/does-not-exist`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(errorBody(res, 'NOT_FOUND', 'Not found'));
  });

  // The JSON parser runs before routing, so the next two tests can post to any path.
  it('answers a malformed JSON body with 400 INVALID_JSON', async () => {
    const res = await fetch(`${baseUrl}/api/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"broken":',
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(
      errorBody(res, 'INVALID_JSON', 'Request body is not valid JSON'),
    );
  });

  it('answers a body over the limit with 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await fetch(`${baseUrl}/api/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 'a'.repeat(20_000) }), // the limit in app.ts is 10 kB
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual(
      errorBody(res, 'PAYLOAD_TOO_LARGE', 'Request body is too large'),
    );
  });
});

describe('the route registry of createApp', () => {
  it('lists every route with its auth, and only health, the auth and demo entry points and the rates are public', () => {
    expect(getRegisteredRoutes(createApp())).toEqual([
      { method: 'GET', path: '/api/health', auth: 'public' },
      { method: 'GET', path: '/api/health/ready', auth: 'public' },
      { method: 'POST', path: '/api/auth/register', auth: 'public' },
      { method: 'POST', path: '/api/auth/login', auth: 'public' },
      { method: 'POST', path: '/api/auth/logout', auth: 'session' },
      { method: 'POST', path: '/api/demo/session', auth: 'public' },
      { method: 'GET', path: '/api/me', auth: 'session' },
      { method: 'PATCH', path: '/api/me/profile', auth: 'session' },
      { method: 'DELETE', path: '/api/me', auth: 'session' },
      { method: 'POST', path: '/api/imports', auth: 'session' },
      { method: 'GET', path: '/api/rates', auth: 'public' },
      { method: 'GET', path: '/api/debtors', auth: 'session' },
      { method: 'GET', path: '/api/debtors/:id', auth: 'session' },
      { method: 'PATCH', path: '/api/debtors/:id', auth: 'session' },
      { method: 'GET', path: '/api/invoices', auth: 'session' },
      { method: 'POST', path: '/api/invoices', auth: 'session' },
      { method: 'GET', path: '/api/invoices/:id', auth: 'session' },
      { method: 'PATCH', path: '/api/invoices/:id', auth: 'session' },
      { method: 'DELETE', path: '/api/invoices/:id', auth: 'session' },
      { method: 'POST', path: '/api/invoices/:id/payments', auth: 'session' },
      { method: 'GET', path: '/api/invoices/:id/interest', auth: 'session' },
      { method: 'GET', path: '/api/claims', auth: 'session' },
      { method: 'POST', path: '/api/claims', auth: 'session' },
      { method: 'GET', path: '/api/claims/:id', auth: 'session' },
      { method: 'DELETE', path: '/api/claims/:id', auth: 'session' },
      { method: 'POST', path: '/api/claims/:id/events', auth: 'session' },
      { method: 'GET', path: '/api/claims/:id/letter.pdf', auth: 'session' },
      { method: 'POST', path: '/api/claims/:id/email', auth: 'session' },
    ]);
  });

  it('builds a new registry for every app, so apps never share routes', () => {
    const first = createApp();
    const second = createApp();

    expect(getRegisteredRoutes(first)).toHaveLength(28);
    expect(getRegisteredRoutes(second)).toHaveLength(28);
  });
});

describe('errorHandler with an unexpected error', () => {
  const secret = 'ana@example.com'; // stands for any personal data an error message could carry
  let server: Server;
  let baseUrl: string;
  let consoleError: MockInstance<typeof console.error>;

  beforeAll(async () => {
    // Not createApp(): a bare app with a route that throws, so the app has no test-only hooks.
    const app = express();
    app.use(requestId);
    app.get('/boom', () => {
      throw new Error(`the database rejected the row of ${secret}`);
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

  it('answers 500 INTERNAL_ERROR and leaks nothing', async () => {
    const res = await fetch(`${baseUrl}/boom`);

    expect(res.status).toBe(500);
    // Exact match: no message, no stack, no extra field.
    expect(await res.json()).toEqual(
      errorBody(res, 'INTERNAL_ERROR', 'Internal server error'),
    );
  });

  it('logs one JSON line with only the level, the request id and the error name', async () => {
    const res = await fetch(`${baseUrl}/boom`);
    await res.text();

    expect(consoleError).toHaveBeenCalledOnce();
    const line = String(consoleError.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({
      level: 'error',
      request_id: res.headers.get('x-request-id'),
      error_name: 'Error',
    });
    expect(line).not.toContain(secret);
  });
});
