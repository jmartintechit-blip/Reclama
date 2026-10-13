import type { Server } from 'node:http';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import { createApp } from '../app.ts';
import type { Db } from '../db/client.ts';
import { close, listen } from '../test-utils.ts';

const secret = 'postgres://user:hunter2@db.internal.example:5432/prod'; // stands for what a DB error message can carry

const notReady = (res: Response) => ({
  error: {
    code: 'NOT_READY',
    message: 'Service not ready',
    request_id: res.headers.get('x-request-id'),
  },
});

describe('GET /api/health/ready', () => {
  let server: Server | undefined;
  let baseUrl = '';
  let consoleWarn: MockInstance<typeof console.warn>;

  async function start(db?: Db) {
    ({ server, baseUrl } = await listen(createApp(db ? { db } : undefined)));
  }

  beforeEach(() => {
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    consoleWarn.mockRestore();
    if (server) {
      await close(server);
    }
    server = undefined;
  });

  it('answers 200 when the database returns the last migration, without exposing it', async () => {
    const query = vi
      .fn<Db['query']>()
      .mockResolvedValue({ rows: [{ name: '0001_initial_schema.sql' }] });
    await start({ query });

    const res = await fetch(`${baseUrl}/api/health/ready`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { status: 'ready' } });
    expect(query).toHaveBeenCalledWith(
      'select name from schema_migrations order by name desc limit 1',
    );
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it('answers 503 NOT_READY when no migration is recorded', async () => {
    await start({ query: () => Promise.resolve({ rows: [] }) });

    const res = await fetch(`${baseUrl}/api/health/ready`);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(notReady(res));
    expect(JSON.parse(String(consoleWarn.mock.calls[0]?.[0]))).toEqual({
      level: 'warn',
      request_id: res.headers.get('x-request-id'),
      error_name: 'NotMigrated',
    });
  });

  it('answers 503 NOT_READY with no database, and logs only the level, request id and error name', async () => {
    await start();

    const res = await fetch(`${baseUrl}/api/health/ready`);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(notReady(res));
    expect(JSON.parse(String(consoleWarn.mock.calls[0]?.[0]))).toEqual({
      level: 'warn',
      request_id: res.headers.get('x-request-id'),
      error_name: 'NoDatabase',
    });
  });

  it('answers 503 NOT_READY when the query fails, and leaks the error message nowhere', async () => {
    await start({ query: () => Promise.reject(new Error(secret)) });

    const res = await fetch(`${baseUrl}/api/health/ready`);
    const body = await res.text();

    expect(res.status).toBe(503);
    expect(JSON.parse(body)).toEqual(notReady(res));
    expect(body).not.toContain('hunter2');
    expect(consoleWarn).toHaveBeenCalledOnce();
    const line = String(consoleWarn.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({
      level: 'warn',
      request_id: res.headers.get('x-request-id'),
      error_name: 'Error',
    });
    expect(line).not.toContain('hunter2');
  });

  it('sends the security headers with the 503', async () => {
    await start();

    const res = await fetch(`${baseUrl}/api/health/ready`);
    await res.text();

    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'none'",
    );
  });

  it('keeps GET /api/health at 200 whatever the database does', async () => {
    const query = vi.fn<Db['query']>().mockRejectedValue(new Error(secret));
    for (const db of [undefined, { query }]) {
      await start(db);

      const res = await fetch(`${baseUrl}/api/health`);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { status: 'ok' } });
      await close(server as Server);
      server = undefined;
    }
    expect(query).not.toHaveBeenCalled(); // liveness never touches the database
  });
});
