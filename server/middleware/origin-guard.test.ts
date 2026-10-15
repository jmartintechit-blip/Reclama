import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { close, listen } from '../test-utils.ts';

let server: Server;
let host: string; // "127.0.0.1:<port>": what Node sends as Host by default
let port: number;

beforeAll(async () => {
  // No database: every request in this file is refused by the guard or stops at validation.
  const started = await listen(createApp());
  server = started.server;
  const url = new URL(started.baseUrl);
  host = url.host;
  port = Number(url.port);
});

afterAll(async () => {
  await close(server);
});

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

interface Options {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
  chunked?: boolean; // no Content-Length: Node then sends Transfer-Encoding: chunked
}

// node:http, not fetch: the tests must control Host, Origin, Sec-Fetch-Site and the framing exactly.
function send({
  method = 'POST',
  path = '/api/auth/login',
  headers = {},
  body,
  chunked = false,
}: Options = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers, agent: false }, // one connection per request: no reuse races
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (part: Buffer) => parts.push(part));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(parts).toString(),
          });
        });
      },
    );
    req.on('error', reject);
    if (chunked && body !== undefined) {
      req.write(body);
      req.end();
    } else {
      req.end(body);
    }
  });
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
// An empty object is not a valid login: a request that gets past the guard stops at validation (400).
const BODY = '{}';
const PASSED = 400;

function expectRefused(
  answer: Answer,
  status: number,
  code: string,
  message: string,
) {
  expect(answer.status).toBe(status);
  expect(JSON.parse(answer.body)).toEqual({
    error: { code, message, request_id: answer.headers['x-request-id'] },
  });
}

const forbidden = (answer: Answer) => {
  expectRefused(answer, 403, 'FORBIDDEN_ORIGIN', 'Request origin not allowed');
};
const unsupported = (answer: Answer) => {
  expectRefused(
    answer,
    415,
    'UNSUPPORTED_MEDIA_TYPE',
    'Content-Type must be application/json',
  );
};

describe('the origin check on unsafe methods', () => {
  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])(
    'refuses a cross-site Origin on %s with 403 FORBIDDEN_ORIGIN',
    async (method) => {
      forbidden(
        await send({
          method,
          headers: { Origin: 'https://evil.example', ...JSON_HEADERS },
          body: BODY,
        }),
      );
    },
  );

  it.each([
    ['a different host', 'https://evil.example'],
    ['the same host on another port', `http://127.0.0.1:${String(port + 1)}`],
    ['the same host without its port', 'http://127.0.0.1'],
    ['a sub-domain trick', `http://${host}.evil.example`],
    ['credentials in front of the real host', `http://evil.example@${host}`],
    ['a path after the host', `http://${host}/x`],
    ['the opaque origin "null"', 'null'],
    ['an empty value', ''],
    ['another scheme', `ftp://${host}`],
  ])('refuses an Origin with %s', async (_name, origin) => {
    forbidden(
      await send({
        headers: { Origin: origin, ...JSON_HEADERS },
        body: BODY,
      }),
    );
  });

  it('accepts an Origin whose host equals Host, in any letter case', async () => {
    for (const origin of [`http://${host}`, `HTTPS://${host}`]) {
      const answer = await send({
        headers: { Origin: origin, ...JSON_HEADERS },
        body: BODY,
      });
      expect(answer.status).toBe(PASSED);
    }
  });

  it('compares with Host only: X-Forwarded-Host cannot make a foreign Origin pass', async () => {
    forbidden(
      await send({
        headers: {
          Origin: 'https://evil.example',
          'X-Forwarded-Host': 'evil.example',
          ...JSON_HEADERS,
        },
        body: BODY,
      }),
    );
  });

  it('follows the Host header, not the connection', async () => {
    const answer = await send({
      headers: {
        Host: 'api.example.test',
        Origin: 'https://api.example.test',
        ...JSON_HEADERS,
      },
      body: BODY,
    });

    expect(answer.status).toBe(PASSED);
  });

  it.each(['cross-site', 'same-site', 'bogus', ''])(
    'refuses Sec-Fetch-Site "%s"',
    async (value) => {
      forbidden(
        await send({
          headers: { 'Sec-Fetch-Site': value, ...JSON_HEADERS },
          body: BODY,
        }),
      );
    },
  );

  it.each(['same-origin', 'none'])(
    'accepts Sec-Fetch-Site "%s"',
    async (value) => {
      const answer = await send({
        headers: { 'Sec-Fetch-Site': value, ...JSON_HEADERS },
        body: BODY,
      });

      expect(answer.status).toBe(PASSED);
    },
  );

  it('trusts Sec-Fetch-Site over Origin when both are present', async () => {
    forbidden(
      await send({
        headers: {
          'Sec-Fetch-Site': 'cross-site',
          Origin: `http://${host}`,
          ...JSON_HEADERS,
        },
        body: BODY,
      }),
    );
  });

  it('lets a request with neither header through (curl, a server: not a browser)', async () => {
    const answer = await send({ headers: JSON_HEADERS, body: BODY });

    expect(answer.status).toBe(PASSED);
  });

  it('does not touch safe methods', async () => {
    const unsafeHeaders: Record<string, string>[] = [
      { Origin: 'https://evil.example' },
      { 'Sec-Fetch-Site': 'cross-site' },
    ];
    for (const headers of unsafeHeaders) {
      const answer = await send({
        method: 'GET',
        path: '/api/health',
        headers,
      });
      expect(answer.status).toBe(200);
    }
  });

  it('runs before the body is read: a foreign origin with a broken or huge body still gets 403', async () => {
    for (const body of [
      '{"broken',
      JSON.stringify({ x: 'a'.repeat(20_000) }),
    ]) {
      forbidden(
        await send({
          headers: { Origin: 'https://evil.example', ...JSON_HEADERS },
          body,
        }),
      );
    }
  });
});

describe('the content type check on unsafe methods', () => {
  it.each([
    ['text/plain', 'email=a@example.com'],
    ['application/x-www-form-urlencoded', 'email=a@example.com'],
    ['multipart/form-data; boundary=x', '--x--'],
    ['application/jsonx', BODY],
    ['text/plain; application/json', BODY],
    ['application/json; charset=latin1', BODY],
    ['application/json; boundary=x', BODY],
  ])('answers 415 to a body sent as "%s"', async (type, body) => {
    unsupported(await send({ headers: { 'Content-Type': type }, body }));
  });

  it('answers 415 to a body without a Content-Type', async () => {
    unsupported(await send({ body: BODY }));
  });

  it('answers 415 before reading a body that is too large', async () => {
    unsupported(
      await send({
        headers: { 'Content-Type': 'text/plain' },
        body: 'a'.repeat(20_000),
      }),
    );
  });

  it('checks the type of a chunked body too', async () => {
    unsupported(
      await send({
        headers: { 'Content-Type': 'text/plain' },
        body: BODY,
        chunked: true,
      }),
    );
    const json = await send({
      headers: JSON_HEADERS,
      body: BODY,
      chunked: true,
    });
    expect(json.status).toBe(PASSED);
  });

  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'application/json;charset=UTF-8',
    'Application/JSON; charset="utf-8"',
  ])('accepts "%s"', async (type) => {
    const answer = await send({
      headers: { 'Content-Type': type },
      body: BODY,
    });

    expect(answer.status).toBe(PASSED);
  });

  it('lets a body-less POST through, like logout (it then needs a session)', async () => {
    const variants: Record<string, string>[] = [
      {},
      { 'Content-Type': 'text/plain' },
    ];
    for (const headers of variants) {
      const answer = await send({ path: '/api/auth/logout', headers });
      expect(answer.status).toBe(401);
      expect(JSON.parse(answer.body)).toMatchObject({
        error: { code: 'UNAUTHENTICATED' },
      });
    }
  });

  it('does not check the type of a safe method', async () => {
    const answer = await send({
      method: 'GET',
      path: '/api/health',
      headers: { 'Content-Type': 'text/plain' },
      body: 'x',
    });

    expect(answer.status).toBe(200);
  });

  it('checks the origin before the type', async () => {
    forbidden(
      await send({
        headers: {
          Origin: 'https://evil.example',
          'Content-Type': 'text/plain',
        },
        body: 'x',
      }),
    );
  });
});

describe('no CORS', () => {
  const attempts: [string, Options][] = [
    ['a normal GET', { method: 'GET', path: '/api/health' }],
    [
      'a refused cross-site POST',
      { headers: { Origin: 'https://evil.example' } },
    ],
    [
      'a request answered 415',
      { headers: { 'Content-Type': 'text/plain' }, body: 'x' },
    ],
    ['a request answered 400', { headers: JSON_HEADERS, body: BODY }],
    ['an unknown route', { method: 'GET', path: '/api/nope' }],
    [
      'a preflight for the login route',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      },
    ],
    [
      'a preflight for an unknown route',
      {
        method: 'OPTIONS',
        path: '/api/nope',
        headers: {
          Origin: 'https://evil.example',
          'Access-Control-Request-Method': 'DELETE',
        },
      },
    ],
  ];

  it.each(attempts)(
    'sends no Access-Control-* header on %s',
    async (_n, options) => {
      const answer = await send(options);

      expect(
        Object.keys(answer.headers).filter((name) =>
          name.startsWith('access-control-'),
        ),
      ).toEqual([]);
    },
  );
});
