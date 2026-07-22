import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts: unit tests are plain TS (router matching, the
// KDF, hex, IndexedDB migrations) with no Svelte components and no wasm, so
// they don't need the svelte or PWA plugins — and must not accidentally load
// them, since the wasm module needs a browser.
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/lib/__tests__/setup.ts'],
    // scripts/** covers the code-dictionary build's own tests (loinc-api.ts
    // needs Node types unavailable to src/**, see tsconfig.scripts.json).
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
})
