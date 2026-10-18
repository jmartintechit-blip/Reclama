// A scripted fetch for the tests: each "METHOD /path" answers with a canned reply, so no test
// reaches a network. A route with an array of replies answers them in order and repeats the
// last one. A request nobody scripted fails like a dead network, and shows up in `calls`.
import { afterEach, vi } from 'vitest';

export type Reply = () => Response | Promise<Response>;

export const json =
  (
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): Reply =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });

export const empty =
  (status: number, headers: Record<string, string> = {}): Reply =>
  () =>
    new Response(null, { status, headers });

export const html =
  (status: number, body = '<html><body>Bad gateway</body></html>'): Reply =>
  () =>
    new Response(body, { status, headers: { 'Content-Type': 'text/html' } });

// A reply that waits until `release()` is called: for tests about what happens while a request
// is in flight.
export function deferred(reply: Reply): { reply: Reply; release: () => void } {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reply: () => gate.then(reply), release };
}

export const networkError: Reply = () => {
  throw new TypeError('Failed to fetch');
};

export const apiError = (
  status: number,
  code: string,
  details?: { path: string; message: string }[],
  headers?: Record<string, string>,
): Reply =>
  json(
    status,
    { error: { code, message: 'x', request_id: 'req-1', details } },
    headers,
  );

export const UNAUTHENTICATED = apiError(401, 'UNAUTHENTICATED');

export const EMPTY_PROFILE = {
  business_name: null,
  tax_id: null,
  address: null,
  iban: null,
  default_compensation: 'PER_CLAIM',
};

export const me = (
  user: { is_demo?: boolean; email?: string | null } = {},
  profile: Record<string, unknown> = EMPTY_PROFILE,
): Reply =>
  json(200, {
    data: {
      user: {
        id: '8d1c5e0a-0000-4000-8000-000000000001',
        email: user.is_demo ? null : (user.email ?? 'ana@example.test'),
        is_demo: user.is_demo ?? false,
      },
      profile,
    },
  });

export function mockApi(table: Record<string, Reply | Reply[]>) {
  const calls: { key: string; body: unknown }[] = [];
  const used = new Map<string, number>();
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${input}`;
    calls.push({
      key,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const entry = table[key];
    if (!entry) return Promise.reject(new TypeError(`Unscripted ${key}`));
    const replies = Array.isArray(entry) ? entry : [entry];
    const index = Math.min(used.get(key) ?? 0, replies.length - 1);
    used.set(key, (used.get(key) ?? 0) + 1);
    try {
      return Promise.resolve((replies[index] as Reply)());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('x'));
    }
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    calls,
    count: (key: string) => calls.filter((call) => call.key === key).length,
    lastBody: (key: string) => calls.findLast((call) => call.key === key)?.body,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});
