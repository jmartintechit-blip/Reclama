import type { IncomingHttpHeaders } from 'node:http';
import type { Request, RequestHandler } from 'express';
import { sendError } from './errors.ts';

const UNSAFE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

// scheme://host[:port] and nothing else (no path, no user@): the host is compared with `Host`.
const ORIGIN = /^https?:\/\/([^/?#@\s]+)$/i;
// Only UTF-8 is accepted: express.json() answers any other charset with an error we do not map.
const JSON_TYPE = /^application\/json(?:\s*;\s*charset="?utf-8"?)?\s*$/i;

function isSameOrigin(req: Request): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined) return site === 'same-origin' || site === 'none';

  const origin = req.headers.origin;
  // Neither header: not a browser (curl, a server). CSRF is an attack through a browser, and
  // every browser that matters sends one of the two on a cross-site POST.
  if (origin === undefined) return true;

  // Only `Host`: X-Forwarded-Host is chosen by whoever sends the request.
  const host = req.headers.host;
  const match = ORIGIN.exec(origin);
  return (
    host !== undefined &&
    match !== null &&
    match[1]?.toLowerCase() === host.toLowerCase()
  );
}

// Same rule as the body parser's, so the guard and the parser never disagree about "has a body".
function hasBody(headers: IncomingHttpHeaders): boolean {
  const length = headers['content-length'];
  return (
    headers['transfer-encoding'] !== undefined ||
    (length !== undefined && Number(length) > 0)
  );
}

// Anti-CSRF, run BEFORE the body is read. There is no CORS on purpose: no
// Access-Control-* header is sent anywhere, so browsers never let another site read an answer.
export const originGuard: RequestHandler = (req, res, next) => {
  if (UNSAFE_METHODS.has(req.method)) {
    if (!isSameOrigin(req)) {
      sendError(res, 403, 'FORBIDDEN_ORIGIN', 'Request origin not allowed');
      return;
    }
    if (
      hasBody(req.headers) &&
      !JSON_TYPE.test(req.headers['content-type'] ?? '')
    ) {
      sendError(
        res,
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'Content-Type must be application/json',
      );
      return;
    }
  }
  next();
};
