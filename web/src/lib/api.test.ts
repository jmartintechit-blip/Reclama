import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, onSessionExpired, type FailureKind } from './api.ts';
import {
  apiError,
  empty,
  html,
  json,
  mockApi,
  networkError,
} from '../test/mock-api.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('api: success', () => {
  it('returns the data of a 200 and sends a same-origin GET without a body', async () => {
    const { fetchMock } = mockApi({
      'GET /api/me': json(200, { data: { user: { id: 'u1' } } }),
    });
    const result = await api<{ user: { id: string } }>('GET', '/api/me');
    expect(result).toEqual({ ok: true, data: { user: { id: 'u1' } } });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.credentials).toBe('same-origin');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(init?.headers).not.toHaveProperty('Content-Type');
  });

  it('sends a JSON body with a JSON content type', async () => {
    const { fetchMock, lastBody } = mockApi({
      'POST /api/auth/login': json(200, { data: { user: { id: 'u1' } } }),
    });
    await api('POST', '/api/auth/login', { email: 'a@b.test', password: 'x' });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'Content-Type': 'application/json',
    });
    expect(lastBody('POST /api/auth/login')).toEqual({
      email: 'a@b.test',
      password: 'x',
    });
  });

  it('accepts a 204 with no body', async () => {
    mockApi({ 'POST /api/auth/logout': empty(204) });
    expect(await api('POST', '/api/auth/logout')).toEqual({
      ok: true,
      data: undefined,
    });
  });

  it('refuses a 200 that is not the API envelope (the app HTML served for a missing function)', async () => {
    mockApi({ 'GET /api/me': html(200, '<!doctype html><title>app</title>') });
    expect(await api('GET', '/api/me')).toMatchObject({
      ok: false,
      kind: 'server',
      status: 200,
    });
  });
});

describe('api: every failure kind', () => {
  const cases: [status: number, kind: FailureKind][] = [
    [400, 'validation'],
    [422, 'validation'],
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [429, 'rate_limited'],
    [502, 'unavailable'],
    [503, 'unavailable'],
    [504, 'unavailable'],
    [500, 'server'],
    [413, 'server'],
    [415, 'server'],
  ];
  it.each(cases)(
    'maps %i to %s and keeps the error code',
    async (status, kind) => {
      mockApi({ 'GET /api/x': apiError(status, 'SOME_CODE') });
      expect(await api('GET', '/api/x')).toEqual({
        ok: false,
        kind,
        status,
        code: 'SOME_CODE',
        details: undefined,
        retryAfter: undefined,
      });
    },
  );

  it('keeps the validation details and drops malformed ones', async () => {
    mockApi({
      'POST /api/x': json(400, {
        error: {
          code: 'VALIDATION_ERROR',
          details: [
            { path: 'email', message: 'Must be a valid email address' },
            { path: 7, message: 'bad' },
            'nonsense',
          ],
        },
      }),
    });
    const result = await api('POST', '/api/x', {});
    expect(result).toMatchObject({
      kind: 'validation',
      details: [{ path: 'email', message: 'Must be a valid email address' }],
    });
  });

  it('keeps the figures of a business error (details sent as an object) in `extra`', async () => {
    mockApi({
      'POST /api/x': json(422, {
        error: {
          code: 'PAYMENT_EXCEEDS_BALANCE',
          details: { remaining_cents: 134_250 },
        },
      }),
    });
    const result = await api('POST', '/api/x', {});
    expect(result).toMatchObject({
      kind: 'validation',
      code: 'PAYMENT_EXCEEDS_BALANCE',
      extra: { remaining_cents: 134_250 },
    });
    expect(result).not.toHaveProperty('details', expect.anything());
  });

  it('reports a network failure as kind network with status 0', async () => {
    mockApi({ 'GET /api/x': networkError });
    expect(await api('GET', '/api/x')).toMatchObject({
      ok: false,
      kind: 'network',
      status: 0,
    });
  });

  it('reports a body that dies while it is read as a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          text: () => Promise.reject(new TypeError('terminated')),
        }),
      ),
    );
    expect(await api('GET', '/api/x')).toMatchObject({ kind: 'network' });
  });

  it('copes with a 429 that has an empty body and no JSON (the CDN edge)', async () => {
    mockApi({ 'POST /api/x': empty(429) });
    expect(await api('POST', '/api/x', {})).toMatchObject({
      ok: false,
      kind: 'rate_limited',
      status: 429,
      code: undefined,
      retryAfter: undefined,
    });
  });

  it('copes with an HTML 502 from the gateway', async () => {
    mockApi({ 'GET /api/x': html(502) });
    expect(await api('GET', '/api/x')).toMatchObject({
      ok: false,
      kind: 'unavailable',
      status: 502,
      code: undefined,
    });
  });

  it('copes with an error body that is JSON but not the envelope', async () => {
    mockApi({ 'GET /api/x': json(500, ['nope']) });
    expect(await api('GET', '/api/x')).toMatchObject({
      kind: 'server',
      code: undefined,
    });
  });
});

describe('api: Retry-After', () => {
  it('reads a number of seconds', async () => {
    mockApi({
      'POST /api/x': apiError(429, 'RATE_LIMITED', undefined, {
        'Retry-After': '90',
      }),
    });
    expect(await api('POST', '/api/x', {})).toMatchObject({ retryAfter: 90 });
  });

  it('reads an HTTP date relative to now', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T10:00:00Z'));
    mockApi({
      'POST /api/x': empty(429, {
        'Retry-After': 'Mon, 19 Oct 2026 10:02:00 GMT',
      }),
    });
    expect(await api('POST', '/api/x', {})).toMatchObject({ retryAfter: 120 });
  });

  it('ignores a value it cannot read', async () => {
    mockApi({ 'POST /api/x': empty(429, { 'Retry-After': 'soon' }) });
    expect(await api('POST', '/api/x', {})).toMatchObject({
      retryAfter: undefined,
    });
  });
});

describe('api: session expiry notice', () => {
  it('tells subscribers when the session is gone, and only for that code', async () => {
    const listener = vi.fn();
    const off = onSessionExpired(listener);
    mockApi({
      'GET /api/a': apiError(401, 'UNAUTHENTICATED'),
      'POST /api/b': apiError(401, 'INVALID_CREDENTIALS'),
    });
    await api('POST', '/api/b', {});
    expect(listener).not.toHaveBeenCalled();
    await api('GET', '/api/a');
    expect(listener).toHaveBeenCalledTimes(1);

    off();
    await api('GET', '/api/a');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
