import type { Server } from 'node:http';
import express, { type RequestHandler } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApp } from '../app.ts';
import { errorHandler, sendError } from '../middleware/errors.ts';
import { requestId } from '../middleware/request-id.ts';
import { close, listen } from '../test-utils.ts';
import { createRouteRegistry, getRegisteredRoutes } from './routes.ts';

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

function buildApp() {
  const app = express();
  app.use(requestId);
  app.use(express.json());
  const defineRoute = createRouteRegistry(app, fakeSession);

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
    createRouteRegistry(other, fakeSession);

    expect(getRegisteredRoutes(other)).toEqual([]);
    expect(getRegisteredRoutes(createApp())).not.toEqual(
      getRegisteredRoutes(app),
    );
  });

  it('refuses to list the routes of an app without a registry', () => {
    expect(() => getRegisteredRoutes(express())).toThrow();
  });
});
