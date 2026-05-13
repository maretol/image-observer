import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    css: true,
    environmentMatchGlobs: [['src/**/*.dom.test.tsx', 'jsdom']],
    setupFiles: './src/test/setup.ts',
  },
});
