import { createApp } from '../../server/app.ts';
import { createDbFromEnv } from '../../server/db/client.ts';
import { createNetlifyHandler } from '../../server/netlify-adapter.ts';

// The only Netlify-specific file: the whole Express app runs inside this one Function.
export default createNetlifyHandler(
  createApp({ db: createDbFromEnv(process.env) }),
);

export const config = {
  path: '/api/*', // the Function answers every /api/... URL, and only those
  // Netlify's edge blocks a caller (HTTP 429) after 100 requests in 60 seconds, counted per IP.
  // aggregateBy ['ip', 'domain'] is the per-IP mode that every plan has; ['domain'] alone is Enterprise-only.
  rateLimit: {
    windowLimit: 100,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
};
