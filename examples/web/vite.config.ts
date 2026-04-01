import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react-swc';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const exampleRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.resolve(exampleRoot, '..', '..');

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(exampleRoot, 'src'),
    },
  },
  server: {
    fs: {
      allow: [repoRoot],
    },
  },
});
