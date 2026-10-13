import * as crypto from 'node:crypto';
import express from 'express';
import { sendError } from '../middleware/errors.ts';
import { renderSmokePdf } from '../pdf/smoke.ts';

export const smokeRouter = express.Router();

// TEMPORARY: it lets the day-3 deployment check (plan section 10) prove that PDFKit works on the Netlify Function.
// Delete this file, server/pdf/smoke.ts and smoke.test.ts when the real letter endpoint exists (plan task T23).
// Public on purpose: it takes no input and touches no data.
//
// TEMPORARY too: /api/smoke/probe, /api/smoke/cookie and /api/smoke/echo-bytes. They let the same gate prove,
// on the real Netlify Function, what no code exercises yet: req.ip, Set-Cookie headers, bytes inside JSON and
// argon2id in Netlify's Node. Delete them together with the PDF endpoint right after the T08 gate (docs/PLAN.md, Pendientes).
smokeRouter.get('/api/smoke/pdf', async (_req, res) => {
  const pdf = await renderSmokePdf(); // if it rejects, Express 5 sends the error to the error handler
  res.set({
    'Content-Type': 'application/pdf',
    // "attachment" because the real letter will be a download, and it keeps the browser's PDF viewer out of the picture
    'Content-Disposition': 'attachment; filename="smoke.pdf"',
  });
  res.send(pdf);
});

// TEMPORARY (deleted with the PDF smoke endpoint after the T08 gate). Reports what the Function runs on.
// A fixed dummy message: a real password is never hashed or logged here.
smokeRouter.get('/api/smoke/probe', async (req, res) => {
  // Partial<>: the types say crypto.argon2 always exists, but this probe exists to check it in Netlify's runtime.
  const { argon2 } = crypto as Partial<typeof crypto>;
  const hashOnce =
    argon2 === undefined
      ? undefined
      : () =>
          new Promise<number>((resolve, reject) => {
            const start = process.hrtime.bigint();
            // OWASP minimum for argon2id: 19 MiB, 2 passes, 1 lane.
            argon2(
              'argon2id',
              {
                message: 'smoke-probe-not-a-password',
                nonce: crypto.randomBytes(16),
                parallelism: 1,
                tagLength: 32,
                memory: 19456,
                passes: 2,
              },
              (error) => {
                if (error) {
                  reject(error);
                } else {
                  resolve(
                    Number((process.hrtime.bigint() - start) / 1_000_000n),
                  );
                }
              },
            );
          });
  // One after the other in the same request: the second one shows the warm cost.
  const firstMs = hashOnce ? await hashOnce() : null;
  const secondMs = hashOnce ? await hashOnce() : null;
  res.json({
    data: {
      node: process.version,
      ip: req.ip ?? null,
      argon2: {
        available: hashOnce !== undefined,
        first_ms: firstMs,
        second_ms: secondMs,
      },
    },
  });
});

// TEMPORARY (deleted with the PDF smoke endpoint after the T08 gate). Sets exactly n cookies, to count Set-Cookie headers.
smokeRouter.get('/api/smoke/cookie', (req, res) => {
  const n = req.query['n'];
  if (n !== '1' && n !== '2') {
    sendError(res, 400, 'INVALID_QUERY', 'n must be 1 or 2');
    return;
  }
  const options = {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60_000,
  } as const;
  res.cookie('__Host-probe1', '1', options);
  if (n === '2') {
    res.cookie('__Host-probe2', '2', options);
  }
  res.json({ data: { set: Number(n) } });
});

// Whole groups of 4 characters, then an optional last group of 2 + "==" or 3 + "=".
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// TEMPORARY (deleted with the PDF smoke endpoint after the T08 gate). Proves that bytes sent as base64 inside JSON
// (a windows-1252 CSV) survive the Netlify adapter: it answers the size and the SHA-256 of the decoded bytes.
smokeRouter.post('/api/smoke/echo-bytes', (req, res) => {
  const body: unknown = req.body;
  const csv =
    typeof body === 'object' && body !== null && 'csv_base64' in body
      ? body.csv_base64
      : undefined;
  if (typeof csv !== 'string' || !BASE64.test(csv)) {
    sendError(res, 400, 'INVALID_BODY', 'csv_base64 must be a base64 string');
    return;
  }
  const bytes = Buffer.from(csv, 'base64');
  res.json({
    data: {
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    },
  });
});
