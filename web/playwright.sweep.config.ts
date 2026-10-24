import { defineConfig, devices } from '@playwright/test'

// The screen sweep (`just sweep`, e2e/sweep.spec.ts). Its own relay and Vite
// ports, never reused: another checkout may be serving 5173 or 8787, and a
// relay or build from other code is the wrong thing to shoot (a relay on
// another contract version is refused at connect outright).
const WEB_PORT = Number(process.env.SWEEP_PORT ?? 5299)
const RELAY_PORT = Number(process.env.SWEEP_RELAY_PORT ?? 8797)
process.env.SVASTHA_E2E_RELAY = `http://127.0.0.1:${RELAY_PORT}`

export default defineConfig({
  testDir: './e2e',
  testMatch: 'sweep.spec.ts',
  reporter: 'line',
  // Bounded waits, so a shot that cannot reach its state fails (and retries)
  // instead of hanging until the hour-long test timeout.
  use: { baseURL: `http://localhost:${WEB_PORT}`, actionTimeout: 15_000, navigationTimeout: 30_000 },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: '../target/debug/svastha-relay',
      env: { SVASTHA_RELAY_ADDR: `127.0.0.1:${RELAY_PORT}` },
      url: `http://127.0.0.1:${RELAY_PORT}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `bun run wasm && vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
