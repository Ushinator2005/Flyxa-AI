/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Vercel serves /landing/ as public/landing/index.html (directory index);
// Vite's dev/preview servers don't, which turns the clean-URL redirect into
// an infinite loop against the SPA's /landing route. Mirror prod behavior.
function landingDirectoryIndex(): Plugin {
  const rewrite = (req: { url?: string }) => {
    if (req.url === '/landing' || req.url === '/landing/') req.url = '/landing/index.html';
  };
  return {
    name: 'landing-directory-index',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => { rewrite(req); next(); });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => { rewrite(req); next(); });
    },
  };
}

export default defineConfig({
  plugins: [react(), landingDirectoryIndex()],
  test: {
    // Playwright owns e2e/ (run via `npm run test:e2e`)
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
  server: {
    port: 5173,
    host: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
          supabase: ['@supabase/supabase-js'],
          icons: ['lucide-react'],
        },
      },
    },
  },
});
