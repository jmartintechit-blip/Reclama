import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { close, listen } from '../test-utils.ts';
import { errorHandler } from './errors.ts';
import { requestId } from './request-id.ts';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  // A bare app: the body reader's errors are raised by hand, as express.json() would raise them.
  const app = express();
  app.use(requestId);
  for (const type of [
    'request.size.invalid',
    'request.aborted',
    'encoding.unsupported',
    'charset.unsupported',
  ]) {
    app.get(`/${type}`, (_req, _res, next) => {
      next(Object.assign(new Error('internal detail'), { type, status: 400 }));
    });
  }
  app.use(errorHandler);
  ({ server, baseUrl } = await listen(app));
});

afterAll(async () => {
  await close(server);
});

describe('errorHandler with the errors of the body reader', () => {
  it.each([
    'request.size.invalid',
    'request.aborted',
    'encoding.unsupported',
    'charset.unsupported',
  ])(
    'answers %s with 400 INVALID_BODY and no internal detail',
    async (type) => {
      const res = await fetch(`${baseUrl}/${type}`);
      const text = await res.text();

      expect(res.status).toBe(400);
      expect((JSON.parse(text) as { error: unknown }).error).toMatchObject({
        code: 'INVALID_BODY',
        message: 'Request body could not be read',
      });
      expect(text).not.toContain('internal detail');
    },
  );
});
