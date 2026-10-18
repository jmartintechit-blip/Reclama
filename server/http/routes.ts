// The route registry (plan section 5). Every endpoint is declared with defineRoute, which
// (1) installs it on the Express app and (2) records it in a list that tests can read, so a test
// can prove "every route without a cookie answers 401, except the public ones".
import { isIPv6 } from 'node:net';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';
import { hashKeyPart, type RateLimiter } from '../db/rate-limits.ts';
import { sendError } from '../middleware/errors.ts';
import { getSession, type Session } from '../middleware/require-session.ts';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export type RouteAuth = 'public' | 'session';

export interface RegisteredRoute {
  readonly method: HttpMethod;
  readonly path: string;
  readonly auth: RouteAuth;
}

export interface ValidationDetail {
  path: string; // e.g. "email"; "" when the whole body is wrong
  message: string; // describes the rule, never the value that was sent
}

// What a handler receives. `body` and `query` are the OUTPUT of the schemas (already
// validated and transformed); without a schema they are undefined. `session` exists only
// on routes with auth 'session'.
export interface RouteContext<TAuth extends RouteAuth, TBody, TQuery> {
  req: Request;
  res: Response;
  body: TBody;
  query: TQuery;
  session: TAuth extends 'session' ? Session : undefined;
}

// Fixed-window limit per key (plan section 5). `key` receives the VALIDATED body, the
// caller's IP and, on routes with auth 'session', the session; build it from the IP or the user
// id and, for personal data such as an email, from a hash (hashKeyPart). `name` prefixes the
// stored key, so two routes never share a counter by accident.
export interface RateLimitSpec<TBody, TSession = undefined> {
  name: string;
  limit: number;
  windowSeconds: number;
  key: (body: TBody, ip: string, session: TSession) => string;
}

// One rule shared by every route that creates, changes or deletes data: a single counter per
// user (hence one name for all of them), so the routes together stay under the limit. Generous
// for a person using the app, far below what a script could write.
export const WRITE_RATE_LIMIT: RateLimitSpec<unknown, Session> = {
  name: 'write',
  limit: 120,
  windowSeconds: 60 * 60,
  key: (_body, _ip, session) => hashKeyPart(session.user.id),
};

// Generating a PDF costs far more than reading a row, so it has its own counter per user (its own
// name keeps it apart from the write counter).
export const PDF_RATE_LIMIT: RateLimitSpec<unknown, Session> = {
  name: 'letter-pdf',
  limit: 60,
  windowSeconds: 60 * 60,
  key: (_body, _ip, session) => hashKeyPart(session.user.id),
};

// The caller's address as it is used in rate-limit keys. A person (or a botnet host) with an
// IPv6 network owns at least a whole /64, so counting each address separately would give an
// attacker billions of free counters: an IPv6 address is reduced to its /64 prefix. An IPv4
// address, and an IPv4-mapped IPv6 address (::ffff:1.2.3.4), count as the IPv4 address. Anything
// else (such as "unknown") is returned as it is.
export function ipKeyPart(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1] !== undefined) return mapped[1];

  const address = ip.split('%')[0] ?? ''; // a zone id ("%eth0") is not part of the address
  if (!isIPv6(address)) return ip;

  // Turn a dotted IPv4 tail ("::1.2.3.4") into two hex groups so that every group is hex.
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  const text = dotted
    ? `${dotted[1] ?? ''}${(Number(dotted[2]) * 256 + Number(dotted[3])).toString(16)}:${(
        Number(dotted[4]) * 256 +
        Number(dotted[5])
      ).toString(16)}`
    : address;

  const [head = '', tail] = text.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const zeros = Array<string>(
    tail === undefined ? 0 : 8 - headGroups.length - tailGroups.length,
  ).fill('0');
  const prefix = [...headGroups, ...zeros, ...tailGroups]
    .slice(0, 4)
    .map((group) => group.toLowerCase().padStart(4, '0'));
  return `${prefix.join(':')}::/64`;
}

export interface RouteSpec<
  TAuth extends RouteAuth,
  TBody extends z.ZodType,
  TQuery extends z.ZodType,
> {
  method: HttpMethod;
  path: string;
  // Secure by default: leaving it out means 'session'. A public route must say so.
  auth?: TAuth;
  schema?: { body?: TBody; query?: TQuery };
  // Runs after validation (so an email is already normalised) and before the handler. With
  // several rules they are checked in the order given, and the first one that refuses answers
  // 429: the rules after it do not count that request.
  rateLimit?:
    | RateLimitSpec<
        z.output<TBody>,
        TAuth extends 'session' ? Session : undefined
      >
    | RateLimitSpec<
        z.output<TBody>,
        TAuth extends 'session' ? Session : undefined
      >[];
  handler: (
    ctx: RouteContext<TAuth, z.output<TBody>, z.output<TQuery>>,
  ) => void | Promise<void>;
}

export type DefineRoute = <
  TAuth extends RouteAuth = 'session',
  TBody extends z.ZodType = z.ZodUndefined,
  TQuery extends z.ZodType = z.ZodUndefined,
>(
  spec: RouteSpec<TAuth, TBody, TQuery>,
) => void;

// One list per app instance, so tests that build several apps never see each other's routes.
const registries = new WeakMap<Express, RegisteredRoute[]>();

// A snapshot of the routes declared on `app` (declaration order).
export function getRegisteredRoutes(app: Express): readonly RegisteredRoute[] {
  const routes = registries.get(app);
  // Failing loudly: an empty list would let a "every route is protected" test pass for nothing.
  if (!routes) throw new Error('This app has no route registry');
  return [...routes];
}

const install: Record<
  HttpMethod,
  (app: Express, path: string, ...handlers: RequestHandler[]) => void
> = {
  GET: (app, path, ...handlers) => app.get(path, ...handlers),
  POST: (app, path, ...handlers) => app.post(path, ...handlers),
  PATCH: (app, path, ...handlers) => app.patch(path, ...handlers),
  DELETE: (app, path, ...handlers) => app.delete(path, ...handlers),
};

type Checked = { data: unknown } | { details: ValidationDetail[] };

function check(schema: z.ZodType, input: unknown): Checked {
  const result = schema.safeParse(input);
  if (result.success) return { data: result.data };
  return {
    details: result.error.issues.map((issue) => ({
      path: issue.path.map((segment) => String(segment)).join('.'),
      message: issue.message,
    })),
  };
}

function sendValidationError(res: Response, details: ValidationDetail[]): void {
  sendError(res, 400, 'VALIDATION_ERROR', 'Request validation failed', details);
}

// `requireSession` is the session step of the request flow; it runs before validation, so a
// caller without a session learns nothing about the shape of the request. `rateLimiter` is
// required, not optional: a route that declares a limit must never run unlimited by omission.
export function createRouteRegistry(
  app: Express,
  requireSession: RequestHandler,
  rateLimiter: RateLimiter,
): DefineRoute {
  const routes: RegisteredRoute[] = [];
  registries.set(app, routes);

  function defineRoute<
    TAuth extends RouteAuth = 'session',
    TBody extends z.ZodType = z.ZodUndefined,
    TQuery extends z.ZodType = z.ZodUndefined,
  >(spec: RouteSpec<TAuth, TBody, TQuery>): void {
    const auth: RouteAuth = spec.auth ?? 'session';
    routes.push({ method: spec.method, path: spec.path, auth });

    const run: RequestHandler = async (req, res) => {
      let body: unknown;
      if (spec.schema?.body) {
        const checked = check(spec.schema.body, req.body);
        if ('details' in checked) {
          sendValidationError(res, checked.details);
          return;
        }
        body = checked.data;
      }
      let query: unknown;
      if (spec.schema?.query) {
        const checked = check(spec.schema.query, req.query);
        if ('details' in checked) {
          sendValidationError(res, checked.details);
          return;
        }
        query = checked.data;
      }
      const session = auth === 'session' ? getSession(res) : undefined;
      const rules = Array.isArray(spec.rateLimit)
        ? spec.rateLimit
        : spec.rateLimit
          ? [spec.rateLimit]
          : [];
      // No IP (not expected): every such caller shares one key, so the limiter fails closed.
      const ip = ipKeyPart(req.ip ?? 'unknown');
      for (const { name, limit, windowSeconds, key } of rules) {
        const result = await rateLimiter({
          key: `${name}:${key(
            body as z.output<TBody>,
            ip,
            session as TAuth extends 'session' ? Session : undefined,
          )}`,
          limit,
          windowSeconds,
        });
        if (!result.allowed) {
          res.set('Retry-After', String(result.retryAfterSeconds));
          sendError(
            res,
            429,
            'RATE_LIMITED',
            'Too many requests, try again later',
          );
          return;
        }
      }
      await spec.handler({ req, res, body, query, session } as RouteContext<
        TAuth,
        z.output<TBody>,
        z.output<TQuery>
      >);
    };

    install[spec.method](
      app,
      spec.path,
      ...(auth === 'session' ? [requireSession, run] : [run]),
    );
  }

  return defineRoute;
}
