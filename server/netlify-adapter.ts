import {
  withLambda,
  type HandlerResponse,
  type LambdaHandler,
} from '@netlify/aws-lambda-compat';
import type { Express } from 'express';
import serverless from 'serverless-http';

// The only field of Netlify's Context that this chain reads (aws-lambda-compat copies `requestId`).
// A local type: Netlify's own types package stays out of our code, and the tests can pass a small fake.
export interface NetlifyContext {
  requestId: string;
}

// Netlify reports the caller's IP in this header (its `context.ip` is built from it).
// X-Forwarded-For is never used: the client chooses what it says.
const CLIENT_IP_HEADER = 'x-nf-client-connection-ip';

export function createNetlifyHandler(app: Express) {
  const handle = serverless(app, {
    // Without this, a PDF body is read as UTF-8 text and its bytes are damaged. JSON stays text.
    // Any other non-text type that the API starts to send must be added here too.
    binary: ['application/pdf'],
  });

  // serverless-http reads the caller's IP (req.ip) from `requestContext.identity.sourceIp`, a field that
  // AWS API Gateway fills and aws-lambda-compat does not. Without it, req.ip is undefined.
  const withRequestContext: LambdaHandler = async (event, context) => {
    // No header (not expected behind Netlify's edge): all callers share the key "unknown", so a limiter on req.ip fails closed.
    const sourceIp = event.headers[CLIENT_IP_HEADER] ?? 'unknown';
    const result = await handle(
      { ...event, requestContext: { identity: { sourceIp } } },
      context,
    );
    return result as HandlerResponse;
  };

  return withLambda(withRequestContext) as (
    request: Request,
    context: NetlifyContext,
  ) => Promise<Response>;
}
