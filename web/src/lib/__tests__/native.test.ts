import { afterEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

async function load() {
  vi.resetModules()
  return import('../native')
}

afterEach(() => {
  vi.unstubAllEnvs()
  invoke.mockReset()
})

describe('native', () => {
  it('reports no native capabilities in the browser build, without calling the shell', async () => {
    const native = await load()
    expect(native.nativeShell).toBe(false)
    expect(await native.nativeCapabilities()).toEqual({ bluetooth: false })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('asks the shell in the native build', async () => {
    vi.stubEnv('TAURI_ENV_PLATFORM', 'android')
    invoke.mockResolvedValue({ bluetooth: true })
    const native = await load()
    expect(native.nativeShell).toBe(true)
    expect(await native.nativeCapabilities()).toEqual({ bluetooth: true })
    expect(invoke).toHaveBeenCalledWith('capabilities')
  })

  it('reads a capability an older shell does not report as false', async () => {
    vi.stubEnv('TAURI_ENV_PLATFORM', 'ios')
    invoke.mockResolvedValue({})
    const native = await load()
    expect(await native.nativeCapabilities()).toEqual({ bluetooth: false })
  })

  it('reads every capability as false when the shell does not answer', async () => {
    vi.stubEnv('TAURI_ENV_PLATFORM', 'android')
    invoke.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'invoke')"))
    const native = await load()
    expect(await native.nativeCapabilities()).toEqual({ bluetooth: false })
  })
})
