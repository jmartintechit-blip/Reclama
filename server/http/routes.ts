// The route registry (plan section 5). Every endpoint is declared with defineRoute, which
// (1) installs it on the Express app and (2) records it in a list that tests can read, so a test
// can prove "every route without a cookie answers 401, except the public ones".
import type { Express, Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';
import type { RateLimiter } from '../db/rate-limits.ts';
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

// Fixed-window limit per key (plan section 5). `key` receives the VALIDATED body and the
// caller's IP; build it from the IP and, for personal data such as an email, from a hash
// (hashKeyPart). `name` prefixes the stored key, so two routes never share a counter by accident.
export interface RateLimitSpec<TBody> {
  name: string;
  limit: number;
  windowSeconds: number;
  key: (body: TBody, ip: string) => string;
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
  // Runs after validation (so an email is already normalised) and before the handler.
  rateLimit?: RateLimitSpec<z.output<TBody>>;
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
      if (spec.rateLimit) {
        const { name, limit, windowSeconds, key } = spec.rateLimit;
        // No IP (not expected): every such caller shares one key, so the limiter fails closed.
        const ip = req.ip ?? 'unknown';
        const result = await rateLimiter({
          key: `${name}:${key(body as z.output<TBody>, ip)}`,
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
      const session = auth === 'session' ? getSession(res) : undefined;
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
