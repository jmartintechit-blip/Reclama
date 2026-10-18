import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    // The CSP allows fonts only from 'self'; a font inlined as a data: URI would be blocked.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    strictPort: true,
    // `npm run dev` serves the API on 3000 (loopback only), so the browser sees one origin.
    // Cookies: the session cookie is `__Host-sid` (Secure, Path=/, no Domain). The proxy passes
    // Set-Cookie through untouched and the origin guard sees matching Host and Origin, so no
    // rewriting is needed. Chrome and Firefox accept a Secure cookie from http://localhost (it
    // counts as a secure context), so login should work at http://localhost:5173. Safari does not
    // accept it over plain http, and a LAN address such as http://192.168.x.x:5173 is not
    // localhost for any browser: use the deployed site or a preview there. Not exercised
    // end to end: the dev API needs a real Postgres (DATABASE_URL).
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
});
