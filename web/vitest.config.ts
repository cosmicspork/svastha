import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts: unit tests are plain TS (router matching, the
// KDF, hex, IndexedDB migrations) with no Svelte components and no wasm, so
// they don't need the svelte or PWA plugins — and must not accidentally load
// them, since the wasm module needs a browser.
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/lib/__tests__/setup.ts'],
    include: ['src/**/*.test.ts'],
  },
})
