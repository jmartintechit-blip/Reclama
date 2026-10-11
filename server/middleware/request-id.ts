import { randomUUID } from 'node:crypto';
import type { RequestHandler, Response } from 'express';

// Always generated here, never copied from the client: a client-chosen id could forge or confuse log lines.
export const requestId: RequestHandler = (_req, res, next) => {
  const id = randomUUID();
  res.locals.requestId = id;
  res.set('X-Request-Id', id);
  next();
};

// Express types `res.locals` loosely (`any`); the middleware above always stores a string there.
export function getRequestId(res: Response): string {
  return res.locals.requestId as string;
}
