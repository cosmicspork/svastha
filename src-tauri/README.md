# Native shell (Tauri 2)

An optional iOS/Android wrapper around the same Svelte app in `web/`. The
browser PWA stays the primary deployment; nothing here is needed to build or
ship it. The shell exists to reach native-only capabilities (Bluetooth LE
health devices first, see #204). Data model, signing, storage, and sync stay in
the web app and `core`, exactly as in the browser.

## Layout

- `src/lib.rs`: the shell. Native capabilities are Tauri commands here.
- `../web/src/lib/native.ts`: the only place the web app talks to the shell.
  UI code asks it what the platform can do and never imports `@tauri-apps/*`.
- `gen/android`: the Android Studio project from `tauri android init`, committed
  because Bluetooth permissions and other manifest changes land in it.
- `gen/apple` does not exist yet: `tauri ios init` needs macOS and Xcode. Run
  `just tauri ios init` on a Mac, then `just tauri icon public/icons/icon.svg`
  to put the app icon into it, and commit the result.
- `package.json` holds one script that forwards to the CLI in `web/`. Gradle
  and Xcode call back into the Tauri CLI from this directory (`bun tauri …`),
  so the script has to resolve here.

This crate is its own Cargo workspace (the root one excludes it): Tauri needs a
WebView stack (webkit2gtk on Linux) that the rest of the Rust CI has no use for.

## Commands

Everything goes through `just tauri …`, which runs the CLI from `web/` with the
paths it needs:

```sh
just tauri android dev        # needs ANDROID_HOME, NDK_HOME, a device or emulator
just tauri android build
just tauri ios dev            # macOS + Xcode
just tauri-check              # fmt, clippy, tests, Android target check (CI runs this)
```

On Linux the host clippy and tests need `libwebkit2gtk-4.1-dev libxdo-dev
libssl-dev`. Without them `just tauri-check` says so and runs only the format
and Android target checks.

## How the native build differs from the PWA

The CLI sets `TAURI_ENV_PLATFORM` when it runs `bun run build`, and
`web/vite.config.ts` reads it:

- No service worker or web manifest. The app updates through the store; a worker
  would keep serving the bundle the update replaced.
- `nativeShell` in `native.ts` is true, which skips SW registration and the
  "install this app" sheet.

Everything else, including the `core` WASM, is the same bundle.

## Storage

The WebView origin is `tauri://localhost` on iOS and `http://tauri.localhost`
on Android, so the app's IndexedDB is separate from any PWA install on the same
phone. Moving between them is the existing seed restore and relay sync; there is
no shared storage. Release Android builds disallow cleartext traffic, so the
relay and inference endpoint must be HTTPS there (debug builds allow HTTP).

## Passkeys

Not expected to work in the shell as it stands, and not yet tried on a device.
`passkey.ts` uses `location.hostname` as the WebAuthn RP ID, which in the shell
is `localhost` (iOS) or `tauri.localhost` (Android). Platform passkeys are
bound to a domain the app proves it owns, and neither of those can be proven:

- iOS: an Associated Domains entitlement `webcredentials:<domain>` plus an
  `apple-app-site-association` file on `https://<domain>/.well-known/` listing
  `<TeamID>.io.github.cosmicspork.svastha`.
- Android: `https://<domain>/.well-known/assetlinks.json` with the
  `delegate_permission/common.get_login_creds` relation for the package name and
  signing certificate fingerprint.

The RP ID has to be that `<domain>`, which the WebView origin is not, so
enrollment likely needs a native passkey call (AuthenticationServices on iOS,
Credential Manager on Android) behind `native.ts` rather than WebView WebAuthn.
The PRF extension that derives the unlock secret also has to be available
through that path. Until then the passphrase is the unlock method in the shell:
`passkeysSupported()` is false there, so the passkey options do not appear.
A passkey enrolled in the PWA cannot unlock the app's vault either way: the
vaults are separate (see Storage).
