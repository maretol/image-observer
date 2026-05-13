import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    css: true,
    environmentMatchGlobs: [['**/*.dom.test.tsx', 'jsdom']],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.{idea,git,cache,output,temp}/**', 'e2e/**'],
    setupFiles: './src/test/setup.ts',
  },
});
