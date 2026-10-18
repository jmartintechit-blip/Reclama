import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import { getRequestId } from './request-id.ts';

// The error shape of the API (plan section 5). `details` is only sent with validation errors.
export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  res.status(status).json({
    error: { code, message, request_id: getRequestId(res), details },
  });
}

// The one answer for "no such thing": a missing row, a malformed id and another user's row all
// look the same, so the response never tells whether something exists.
export function sendNotFound(res: Response): void {
  sendError(res, 404, 'NOT_FOUND', 'Not found');
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  sendError(res, 404, 'NOT_FOUND', 'Not found');
};

// express.json() tags the errors it raises with a `type`, which is how we recognise them.
function errorType(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'type' in err
    ? err.type
    : undefined;
}

export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  _req,
  res,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express only treats a function as an error handler if it declares 4 parameters
  _next,
) => {
  const type = errorType(err);
  if (type === 'entity.parse.failed') {
    sendError(res, 400, 'INVALID_JSON', 'Request body is not valid JSON');
    return;
  }
  if (type === 'entity.too.large') {
    sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    return;
  }

  // Unexpected error: log only the request id and the error name. The message, the stack and
  // the request body can contain personal data, so they go neither to the log nor to the client.
  console.error(
    JSON.stringify({
      level: 'error',
      request_id: getRequestId(res),
      error_name: err instanceof Error ? err.name : 'NonError',
    }),
  );
  sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
};
