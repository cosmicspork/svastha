# Svastha web

The Svelte 5 PWA. Local-first, consumes the Rust `core` over WASM.

```bash
bun install
bun run dev
```

See the repository root `README.md` and `docs/ARCHITECTURE.md`.

## Getting started (using the app)

- **Install.** Open the PWA in your browser and use "Add to Home Screen" (or
  whatever install prompt your browser offers) to add it like a native app.
- **Onboard.** The first run generates a 24-word seed phrase. Write it down and
  keep it somewhere safe — it is the only way to recover your records if this
  device is lost.
- **Connect a relay.** Under Settings, enter your relay's URL to enable backup
  and multi-device sync. See the root `README.md` for a `docker run` one-liner
  to self-host one.
- **Share.** On the Share screen, exchange codes with a trusted person to grant
  them read-only access to your whole vault.
