// The one door from the web app to the Tauri shell (src-tauri/). UI code asks
// this module what the platform can do and never imports @tauri-apps/* itself,
// so the browser build stays free of native code paths and a capability that
// is missing degrades the same way everywhere: it reads as false.
//
// Fixed at build time rather than sniffed from the WebView: the native bundle
// is a separate build (vite.config.ts), so the answer is a constant the
// bundler can fold away in the browser build.
export const nativeShell: boolean = !!import.meta.env.TAURI_ENV_PLATFORM

/** Mirrors `Capabilities` in src-tauri/src/lib.rs. */
export interface NativeCapabilities {
  bluetooth: boolean
}

const NONE: NativeCapabilities = { bluetooth: false }

/** What the shell can do natively; all false in the browser. */
export async function nativeCapabilities(): Promise<NativeCapabilities> {
  if (!nativeShell) return NONE
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return { ...NONE, ...(await invoke<Partial<NativeCapabilities>>('capabilities')) }
  } catch {
    // No shell answered: a shell older than the command, or the native dev
    // server opened in an ordinary browser, where there is no IPC at all.
    return NONE
  }
}
