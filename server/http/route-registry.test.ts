import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { close, listen } from '../test-utils.ts';
import { getRegisteredRoutes, type RegisteredRoute } from './routes.ts';

// The only routes that may answer without a session. Adding a public route to the app makes
// the second test fail until a human adds it here on purpose (plan sections 5 and 7).
const PUBLIC_ROUTES = [
  'GET /api/health',
  'GET /api/health/ready',
  'POST /api/auth/login',
  'POST /api/auth/register',
];

const DUMMY_UUID = '00000000-0000-4000-8000-000000000000';
const describeRoute = ({ method, path }: RegisteredRoute) =>
  `${method} ${path}`;

describe('the route registry of the real app', () => {
  const app = createApp(); // no database: a request without a cookie never reaches it
  const routes = getRegisteredRoutes(app);
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await listen(app));
  });

  afterAll(async () => {
    await close(server);
  });

  it('is not empty (an empty list would make the other checks pass for nothing)', () => {
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.some((route) => route.auth === 'session')).toBe(true);
  });

  it('has exactly the expected public routes', () => {
    const actual = routes
      .filter((route) => route.auth === 'public')
      .map(describeRoute)
      .sort();

    expect(actual).toEqual([...PUBLIC_ROUTES].sort());
  });

  it('answers 401 UNAUTHENTICATED to every session route called without a cookie', async () => {
    const protectedRoutes = routes.filter((route) => route.auth === 'session');
    expect(protectedRoutes.length).toBeGreaterThan(0);

    for (const route of protectedRoutes) {
      const hasBody = route.method === 'POST' || route.method === 'PATCH';
      const res = await fetch(
        `${baseUrl}${route.path.replace(/:\w+/g, DUMMY_UUID)}`,
        {
          method: route.method,
          headers: hasBody ? { 'Content-Type': 'application/json' } : {},
          body: hasBody ? JSON.stringify({}) : undefined,
        },
      );

      expect(res.status, describeRoute(route)).toBe(401);
      const { error } = (await res.json()) as { error: { code: string } };
      expect(error.code, describeRoute(route)).toBe('UNAUTHENTICATED');
    }
  });
});
