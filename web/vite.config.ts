import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const webRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  root: webRoot,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    host: true,
    // The app imports the shared rules from ../src/engine.
    fs: { allow: [repoRoot] },
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
  preview: { port: 5173, host: true },
});
