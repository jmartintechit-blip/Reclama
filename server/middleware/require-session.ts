import type { RequestHandler, Response } from 'express';
import { hashToken, readSessionToken } from '../auth/session.ts';
import type { Db } from '../db/client.ts';
import { findSessionUser, type SessionUser } from '../db/sessions.ts';
import type { Clock } from '../domain/dates.ts';
import { sendError } from './errors.ts';

export interface Session {
  tokenHash: Buffer; // identifies this one session (logout deletes exactly this row)
  user: SessionUser;
}

// The session step of the request flow (plan section 1). Every failure (no cookie, garbage,
// unknown token, expired session) gets the same answer: the client never learns why.
export function createRequireSession(db: Db, clock: Clock): RequestHandler {
  return async (req, res, next) => {
    const token = readSessionToken(req.headers.cookie);
    if (token !== null) {
      const tokenHash = hashToken(token);
      const user = await findSessionUser(db, tokenHash, clock.now());
      if (user) {
        res.locals.session = { tokenHash, user } satisfies Session;
        next();
        return;
      }
    }
    sendError(res, 401, 'UNAUTHENTICATED', 'Authentication required');
  };
}

// Express types `res.locals` loosely (`any`); the middleware above always stores a Session there.
export function getSession(res: Response): Session {
  return res.locals.session as Session;
}
