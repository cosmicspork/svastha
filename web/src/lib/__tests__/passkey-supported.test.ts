import { afterEach, describe, expect, it, vi } from 'vitest'

async function load() {
  vi.resetModules()
  return import('../passkey')
}

// A WebView that exposes the whole WebAuthn API, as WKWebView does.
function stubWebAuthn() {
  vi.stubGlobal('window', { PublicKeyCredential: function PublicKeyCredential() {} })
  vi.stubGlobal('navigator', { credentials: { create: async () => null, get: async () => null } })
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('passkeysSupported', () => {
  it('is true in a browser that exposes WebAuthn', async () => {
    stubWebAuthn()
    expect((await load()).passkeysSupported()).toBe(true)
  })

  it('is false in the native shell even when its WebView exposes WebAuthn', async () => {
    stubWebAuthn()
    for (const platform of ['ios', 'android']) {
      vi.stubEnv('TAURI_ENV_PLATFORM', platform)
      expect((await load()).passkeysSupported()).toBe(false)
    }
  })
})
