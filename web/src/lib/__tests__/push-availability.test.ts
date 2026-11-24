import { afterEach, describe, expect, it, vi } from 'vitest'

async function availability() {
  vi.resetModules()
  return (await import('../push')).pushAvailability()
}

function stubPushApis(registration: unknown) {
  vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => registration } })
  vi.stubGlobal('PushManager', function PushManager() {})
  vi.stubGlobal('Notification', function Notification() {})
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('pushAvailability', () => {
  it('is unsupported without the Push APIs', async () => {
    vi.stubGlobal('navigator', {})
    expect(await availability()).toBe('unsupported')
  })

  it('is not-ready until a service worker is registered', async () => {
    stubPushApis(undefined)
    expect(await availability()).toBe('not-ready')
  })

  it('is ready once a service worker is registered', async () => {
    stubPushApis({})
    expect(await availability()).toBe('ready')
  })

  // The shell never registers a worker, so every browser answer would be
  // advice that cannot work: "reload" where the APIs exist (Android), "add to
  // Home Screen" where they do not (iOS).
  it('is native in the shell whether or not its WebView exposes the Push APIs', async () => {
    vi.stubEnv('TAURI_ENV_PLATFORM', 'android')
    stubPushApis(undefined)
    expect(await availability()).toBe('native')
    stubPushApis({})
    expect(await availability()).toBe('native')

    vi.stubEnv('TAURI_ENV_PLATFORM', 'ios')
    vi.stubGlobal('navigator', {})
    expect(await availability()).toBe('native')
  })
})
