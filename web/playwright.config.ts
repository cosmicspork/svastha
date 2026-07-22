import { defineConfig, devices } from '@playwright/test'

// PWA <-> relay smoke, run locally via `just e2e` and in CI (the `e2e` job in
// .github/workflows/ci.yml). Locally, `just e2e` builds the relay binary
// first; Playwright then starts the relay and the Vite dev server (which
// builds the wasm), and drives a real browser against them.
//
// Requires `cargo` and `wasm-pack` on PATH (same as the web build).

const RELAY_PORT = 8787
const WEB_PORT = 5173

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  reporter: 'line',
  use: { baseURL: `http://localhost:${WEB_PORT}` },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // The prebuilt relay binary, in-memory store, ephemeral.
      command: '../target/debug/svastha-relay',
      env: { SVASTHA_RELAY_ADDR: `127.0.0.1:${RELAY_PORT}` },
      url: `http://127.0.0.1:${RELAY_PORT}/health`,
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      // Vite dev (serves source modules so the test can import the client).
      command: `bun run wasm && vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
})
