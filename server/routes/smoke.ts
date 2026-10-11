import express from 'express';
import { renderSmokePdf } from '../pdf/smoke.ts';

export const smokeRouter = express.Router();

// TEMPORARY: it lets the day-3 deployment check (plan section 10) prove that PDFKit works on the Netlify Function.
// Delete this file, server/pdf/smoke.ts and smoke.test.ts when the real letter endpoint exists (plan task T23).
// Public on purpose: it takes no input and touches no data.
smokeRouter.get('/api/smoke/pdf', async (_req, res) => {
  const pdf = await renderSmokePdf(); // if it rejects, Express 5 sends the error to the error handler
  res.set({
    'Content-Type': 'application/pdf',
    // "attachment" because the real letter will be a download, and it keeps the browser's PDF viewer out of the picture
    'Content-Disposition': 'attachment; filename="smoke.pdf"',
  });
  res.send(pdf);
});
