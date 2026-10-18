import type { Db } from '../db/client.ts';
import { listVerifiedRates } from '../db/rates.ts';
import type { DefineRoute } from '../http/routes.ts';

// Public on purpose: the legal rates and their BOE sources are not personal data, and the
// "method" page shows them to visitors who have no account yet.
export function registerRateRoutes(
  defineRoute: DefineRoute,
  { db }: { db: Db },
) {
  defineRoute({
    method: 'GET',
    path: '/api/rates',
    auth: 'public',
    handler: async ({ res }) => {
      const rates = await listVerifiedRates(db);
      res.json({
        data: {
          rates: rates.map((rate) => ({
            semester_start: rate.semester_start,
            semester_end: rate.semester_end,
            rate_bp: rate.rate_bp,
            ecb_mro_bp: rate.ecb_mro_bp,
            spread_bp: rate.spread_bp,
            boe_ref: rate.boe_ref,
            boe_url:
              rate.boe_ref === null
                ? null
                : `https://www.boe.es/diario_boe/txt.php?id=${rate.boe_ref}`,
            published_on: rate.published_on,
          })),
          // The days for which interest can be calculated; outside them the API answers RATE_WINDOW.
          window: {
            from: rates[0]?.semester_start ?? null,
            to: rates.at(-1)?.semester_end ?? null,
          },
        },
      });
    },
  });
}
