import { createApp } from './app.ts';

const rawPort = process.env.PORT ?? '3000';
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(
    `Invalid PORT "${rawPort}": it must be an integer between 1 and 65535.`,
  );
  process.exit(1);
}

// Express 5 passes a startup failure (for example, port already in use) to this callback.
createApp().listen(port, (error) => {
  if (error) {
    console.error(`Could not listen on port ${String(port)}: ${error.message}`);
    process.exit(1);
  }
  console.log(`API listening on http://localhost:${String(port)}`);
});
