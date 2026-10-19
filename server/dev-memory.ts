// A complete local server with no setup: an in-memory Postgres (PGlite) with every migration and
// the verified rates loaded, and a fake mailer. It is what the browser tests and the screenshots
// run against, and it lets the web app be tried locally without a DATABASE_URL. Everything is lost
// when the process stops. Not for production: nothing here talks to Neon or Resend.
import { readFile } from 'node:fs/promises';
import { createApp } from './app.ts';
import { seedRates } from './db/rates-seed.ts';
import { createTestDb } from './db/test-db.ts';
import { parseRates } from './domain/rates.ts';
import { createFakeMailer } from './services/fake-mailer.ts';

const port = Number(process.env.PORT ?? '3000');
const db = await createTestDb();
const rates = parseRates(
  JSON.parse(
    await readFile(
      new URL('../data/legal-interest-rates.json', import.meta.url),
      'utf8',
    ),
  ),
);
await seedRates(db, rates);

createApp({ db, mailer: createFakeMailer() }).listen(
  port,
  '127.0.0.1',
  (error) => {
    if (error) {
      console.error(
        `Could not listen on port ${String(port)}: ${error.message}`,
      );
      process.exit(1);
    }
    console.log(`In-memory API listening on http://127.0.0.1:${String(port)}`);
  },
);
