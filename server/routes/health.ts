import express from 'express';

export const healthRouter = express.Router();

// "Alive" check only: it never touches the database, so it answers even when the database is down.
healthRouter.get('/api/health', (_req, res) => {
  res.json({ data: { status: 'ok' } });
});
