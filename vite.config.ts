import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// SINGLE=1 builds one self-contained HTML file (used for the shareable web link).
export default defineConfig({
  base: './',
  plugins: process.env.SINGLE ? [viteSingleFile()] : [],
  build: { assetsInlineLimit: process.env.SINGLE ? 100_000_000 : 4096 },
  server: { strictPort: true, port: 5173 },
  clearScreen: false,
});
