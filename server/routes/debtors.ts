import { z } from 'zod';
import type { Db } from '../db/client.ts';
import {
  countDebtors,
  getDebtorWithStats,
  listDebtorsWithStats,
  updateDebtor,
} from '../db/debtors.ts';
import type { DefineRoute } from '../http/routes.ts';
import { idParam, pageQuery } from '../http/schemas.ts';
import { sendNotFound } from '../middleware/errors.ts';
import { email } from './auth.ts';

// Only the kind and the e-mail can change: the name and tax id are what identify the debtor.
// Keys that are not listed are dropped by Zod, so user_id and the like can never be written.
const patchSchema = z.object({
  kind: z.enum(['BUSINESS', 'PUBLIC_ADMIN', 'CONSUMER', 'UNKNOWN']).optional(),
  email: email.nullable().optional(),
});

const listQuery = z.object(pageQuery);

export function registerDebtorRoutes(
  defineRoute: DefineRoute,
  { db }: { db: Db },
) {
  defineRoute({
    method: 'GET',
    path: '/api/debtors',
    schema: { query: listQuery },
    handler: async ({ res, query, session }) => {
      const userId = session.user.id;
      const total = await countDebtors(db, userId);
      const debtors = await listDebtorsWithStats(db, userId, query);
      res.json({
        data: {
          debtors,
          page: { limit: query.limit, offset: query.offset, total },
        },
      });
    },
  });

  defineRoute({
    method: 'GET',
    path: '/api/debtors/:id',
    handler: async ({ req, res, session }) => {
      const id = idParam(req.params.id);
      const debtor =
        id === null ? null : await getDebtorWithStats(db, session.user.id, id);
      if (debtor === null) {
        sendNotFound(res);
        return;
      }
      res.json({ data: { debtor } });
    },
  });

  defineRoute({
    method: 'PATCH',
    path: '/api/debtors/:id',
    schema: { body: patchSchema },
    handler: async ({ req, res, body, session }) => {
      const userId = session.user.id;
      const id = idParam(req.params.id);
      const updated =
        id === null ? null : await updateDebtor(db, userId, id, body);
      // The same read as GET, so the answer carries the counts too.
      const debtor =
        updated === null
          ? null
          : await getDebtorWithStats(db, userId, updated.id);
      if (debtor === null) {
        sendNotFound(res);
        return;
      }
      res.json({ data: { debtor } });
    },
  });
}
