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
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
});
