import type { RequestHandler } from 'express';

// Set in code because the [[headers]] of netlify.toml are not applied to Netlify Functions (plan section 7).
export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.set({
    'Cache-Control': 'no-store', // answers can hold personal data: no browser or CDN may keep a copy
    'X-Content-Type-Options': 'nosniff', // the browser must trust our Content-Type and not guess another one
    'Content-Security-Policy': "default-src 'none'", // an API answer never needs to load or run anything
  });
  next();
};
