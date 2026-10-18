import { createApp } from './app.ts';
import { createEmailFromEnv } from './config.ts';
import { createDbFromEnv } from './db/client.ts';

const rawPort = process.env.PORT ?? '3000';
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(
    `Invalid PORT "${rawPort}": it must be an integer between 1 and 65535.`,
  );
  process.exit(1);
}

// Express 5 passes a startup failure (for example, port already in use) to this callback.
// Only the loopback interface: the dev server has no business being reachable from the network.
createApp({
  db: createDbFromEnv(process.env),
  ...createEmailFromEnv(process.env),
}).listen(port, '127.0.0.1', (error) => {
  if (error) {
    console.error(`Could not listen on port ${String(port)}: ${error.message}`);
    process.exit(1);
  }
  console.log(`API listening on http://127.0.0.1:${String(port)}`);
});
