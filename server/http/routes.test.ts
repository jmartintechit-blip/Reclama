import type { Server } from 'node:http';
import express, { type RequestHandler } from 'express';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { z } from 'zod';
import { createApp } from '../app.ts';
import type { RateLimiter } from '../db/rate-limits.ts';
import { errorHandler, sendError } from '../middleware/errors.ts';
import { requestId } from '../middleware/request-id.ts';
import { close, listen } from '../test-utils.ts';
import {
  createRouteRegistry,
  getRegisteredRoutes,
  ipKeyPart,
} from './routes.ts';

// A stand-in for the session step: lets a request through only if it sends "x-test-session".
const fakeSession: RequestHandler = (req, res, next) => {
  if (req.headers['x-test-session'] === undefined) {
    sendError(res, 401, 'UNAUTHENTICATED', 'Authentication required');
    return;
  }
  res.locals.session = { tokenHash: Buffer.alloc(32), user: { id: 'u1' } };
  next();
};

const handler = vi.fn();
const allowAll: RateLimiter = () =>
  Promise.resolve({ allowed: true, retryAfterSeconds: 1 });

function buildApp() {
  const app = express();
  app.use(requestId);
  app.use(express.json());
  const defineRoute = createRouteRegistry(app, fakeSession, allowAll);

  defineRoute({
    method: 'GET',
    path: '/open',
    auth: 'public',
    handler: ({ res }) => {
      res.json({ data: 'open' });
    },
  });
  // No `auth`: must be protected.
  defineRoute({
    method: 'GET',
    path: '/closed',
    handler: ({ res }) => {
      handler();
      res.json({ data: 'closed' });
    },
  });
  defineRoute({
    method: 'POST',
    path: '/items',
    auth: 'public',
    schema: {
      body: z.object({
        name: z.string().trim().min(1),
        qty: z.number().int(),
      }),
    },
    handler: ({ res, body }) => {
      handler(body);
      res.status(201).json({ data: body });
    },
  });
  defineRoute({
    method: 'GET',
    path: '/search',
    auth: 'public',
    schema: { query: z.object({ page: z.coerce.number().int().min(1) }) },
    handler: ({ res, query }) => {
      handler(query);
      res.json({ data: query });
    },
  });
  defineRoute({
    method: 'POST',
    path: '/guarded',
    schema: { body: z.object({ name: z.string() }) },
    handler: ({ res }) => {
      handler();
      res.status(204).end();
    },
  });
  app.use(errorHandler);
  return app;
}

describe('defineRoute', () => {
  let server: Server;
  let baseUrl: string;
  const app = buildApp();

  beforeAll(async () => {
    ({ server, baseUrl } = await listen(app));
  });

  afterAll(async () => {
    await close(server);
  });

  function postJson(path: string, body: unknown, headers = {}) {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  it('records every route with its method, path and auth, in order', () => {
    expect(getRegisteredRoutes(app)).toEqual([
      { method: 'GET', path: '/open', auth: 'public' },
      { method: 'GET', path: '/closed', auth: 'session' },
      { method: 'POST', path: '/items', auth: 'public' },
      { method: 'GET', path: '/search', auth: 'public' },
      { method: 'POST', path: '/guarded', auth: 'session' },
    ]);
  });

  it('protects a route declared without auth', async () => {
    handler.mockClear();

    const anonymous = await fetch(`${baseUrl}/closed`);
    const signedIn = await fetch(`${baseUrl}/closed`, {
      headers: { 'x-test-session': '1' },
    });

    expect(anonymous.status).toBe(401);
    expect(handler).toHaveBeenCalledTimes(1); // only the signed-in call got in
    expect(signedIn.status).toBe(200);
  });

  it('lets a public route through without a session', async () => {
    const res = await fetch(`${baseUrl}/open`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: 'open' });
  });

  it('checks the session before the body: no session gives 401 even for an invalid body', async () => {
    handler.mockClear();

    const res = await postJson('/guarded', { wrong: true });

    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('gives the handler the validated and transformed body', async () => {
    handler.mockClear();

    const res = await postJson('/items', {
      name: '  pen  ',
      qty: 3,
      extra: 'dropped',
    });

    expect(res.status).toBe(201);
    expect(handler).toHaveBeenCalledWith({ name: 'pen', qty: 3 });
  });

  it('answers 400 VALIDATION_ERROR with details and never runs the handler', async () => {
    handler.mockClear();
    const secret = 'do-not-echo-this-value';

    const res = await postJson('/items', { name: '', qty: secret });
    const text = await res.text();

    expect(res.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
    expect(text).not.toContain(secret);
    expect(JSON.parse(text)).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        request_id: res.headers.get('x-request-id'),
        details: [
          { path: 'name', message: expect.any(String) as string },
          { path: 'qty', message: expect.any(String) as string },
        ],
      },
    });
  });

  it('answers 400 when the body is missing', async () => {
    const res = await fetch(`${baseUrl}/items`, { method: 'POST' });

    expect(res.status).toBe(400);
    const { error } = (await res.json()) as {
      error: { code: string; details: { path: string }[] };
    };
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toEqual([
      { path: '', message: expect.any(String) as string },
    ]);
  });

  it('validates and transforms the query when a query schema is declared', async () => {
    handler.mockClear();

    const ok = await fetch(`${baseUrl}/search?page=2`);
    const bad = await fetch(`${baseUrl}/search?page=0`);
    const missing = await fetch(`${baseUrl}/search`);

    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ data: { page: 2 } });
    expect(bad.status).toBe(400);
    expect(missing.status).toBe(400);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keeps a separate registry for every app', () => {
    const other = express();
    createRouteRegistry(other, fakeSession, allowAll);

    expect(getRegisteredRoutes(other)).toEqual([]);
    expect(getRegisteredRoutes(createApp())).not.toEqual(
      getRegisteredRoutes(app),
    );
  });

  it('refuses to list the routes of an app without a registry', () => {
    expect(() => getRegisteredRoutes(express())).toThrow();
  });
});

describe('defineRoute with a rateLimit', () => {
  const limiter = vi.fn<RateLimiter>();
  const limited = vi.fn();
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(requestId);
    app.use(express.json());
    const defineRoute = createRouteRegistry(app, fakeSession, limiter);
    defineRoute({
      method: 'POST',
      path: '/limited',
      auth: 'public',
      schema: { body: z.object({ email: z.string().trim().toLowerCase() }) },
      rateLimit: {
        name: 'demo',
        limit: 2,
        windowSeconds: 60,
        key: (body, ip) => `${ip}|${body.email}`,
      },
      handler: ({ res }) => {
        limited();
        res.status(204).end();
      },
    });
    app.use(errorHandler);
    ({ server, baseUrl } = await listen(app));
  });

  afterAll(async () => {
    await close(server);
  });

  beforeEach(() => {
    limiter.mockReset();
    limited.mockClear();
  });

  const call = (body: unknown) =>
    fetch(`${baseUrl}/limited`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('asks the limiter with the route name, the validated body and the IP, then runs the handler', async () => {
    limiter.mockResolvedValue({ allowed: true, retryAfterSeconds: 7 });

    const res = await call({ email: '  Ana@Example.COM ' });

    expect(res.status).toBe(204);
    expect(limited).toHaveBeenCalledTimes(1);
    expect(limiter).toHaveBeenCalledWith({
      key: expect.stringMatching(/^demo:.+\|ana@example\.com$/) as string,
      limit: 2,
      windowSeconds: 60,
    });
  });

  it('answers 429 RATE_LIMITED with an integer Retry-After and never runs the handler', async () => {
    limiter.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });

    const res = await call({ email: 'a@example.com' });

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
    expect(await res.json()).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests, try again later',
        request_id: res.headers.get('x-request-id'),
      },
    });
    expect(limited).not.toHaveBeenCalled();
  });

  it('validates first: an invalid body is a 400 that does not touch the limiter', async () => {
    const res = await call({ email: 5 });

    expect(res.status).toBe(400);
    expect(limiter).not.toHaveBeenCalled();
    expect(limited).not.toHaveBeenCalled();
  });

  it('fails closed: a limiter error is a 500 and the handler never runs', async () => {
    limiter.mockRejectedValue(new Error('database down'));
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const res = await call({ email: 'a@example.com' });

    expect(res.status).toBe(500);
    expect(limited).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('ipKeyPart', () => {
  it('leaves an IPv4 address and anything that is not an IPv6 address as it is', () => {
    expect(ipKeyPart('10.0.0.2')).toBe('10.0.0.2');
    expect(ipKeyPart('203.0.113.250')).toBe('203.0.113.250');
    expect(ipKeyPart('unknown')).toBe('unknown');
  });

  it('gives the same key to every address of one /64 and another key to another /64', () => {
    const key = ipKeyPart('2001:db8:1:2::1');

    expect(ipKeyPart('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(key);
    expect(ipKeyPart('2001:0DB8:0001:0002:0:0:0:ffff')).toBe(key);
    expect(ipKeyPart('2001:db8:1:3::1')).not.toBe(key);
    expect(ipKeyPart('2001:db8:2:2::1')).not.toBe(key);
    expect(key).toBe('2001:0db8:0001:0002::/64');
  });

  it('expands :: correctly, also at the start, at the end and with a zone id', () => {
    expect(ipKeyPart('::1')).toBe('0000:0000:0000:0000::/64');
    expect(ipKeyPart('2001:db8::')).toBe('2001:0db8:0000:0000::/64');
    expect(ipKeyPart('fe80::1%eth0')).toBe(ipKeyPart('fe80::2'));
    expect(ipKeyPart('2001:db8:0:0:5::1')).toBe('2001:0db8:0000:0000::/64');
    expect(ipKeyPart('2001:db8:0:5::1')).toBe('2001:0db8:0000:0005::/64');
  });

  it('treats an IPv4-mapped IPv6 address as that IPv4 address', () => {
    expect(ipKeyPart('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(ipKeyPart('::FFFF:1.2.3.4')).toBe('1.2.3.4');
  });

  it('handles an IPv4 tail in other IPv6 addresses', () => {
    expect(ipKeyPart('64:ff9b::1.2.3.4')).toBe('0064:ff9b:0000:0000::/64');
  });
});
