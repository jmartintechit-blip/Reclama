import express from 'express';
import { errorHandler, notFoundHandler } from './middleware/errors.ts';
import { requestId } from './middleware/request-id.ts';
import { healthRouter } from './routes/health.ts';

export function createApp() {
  const app = express();

  app.disable('x-powered-by'); // do not advertise the framework and its version
  app.use(requestId);
  // Small on purpose: normal JSON bodies in this API are a few fields.
  // The CSV import route will need a bigger limit later (up to 1 MB, plan section 4.8).
  app.use(express.json({ limit: '10kb' }));

  app.use(healthRouter);

  // After all the routes: the not-found handler catches what no route matched,
  // and the error handler must be the last middleware to receive every error.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
