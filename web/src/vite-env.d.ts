/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** Workspace release version, baked in by vite.config.ts's `define` from
 * .release-please-manifest.json. */
declare const __APP_VERSION__: string

interface ImportMetaEnv {
  /** Set only in the Tauri shell's build ('android', 'ios', or a desktop OS);
   * see vite.config.ts. Read it through lib/native.ts, not directly. */
  readonly TAURI_ENV_PLATFORM?: string
}
