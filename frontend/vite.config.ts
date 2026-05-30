/// <reference types="vitest/config" />
import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    // Default to the lightweight `node` environment so the existing pure-function
    // unit tests (filters / colors / layout / ...) stay fast and DOM-free.
    // Tests that need a DOM — currently only the auto-save queue renderHook
    // tests (#110 B) — opt in per-file with a `// @vitest-environment happy-dom`
    // docblock. This keeps the happy-dom startup cost off every other test.
    environment: 'node',
  },
})
