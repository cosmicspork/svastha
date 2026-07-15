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
- **Add a passkey (optional).** Under Settings → Passkeys, unlock with Face ID /
  Touch ID instead of typing the passphrase. The passphrase always still works,
  and the seed phrase remains the only recovery root.
- **Import your records.** Settings → Import records accepts US EHR exports
  (Epic IHE XDM zips, C-CDA XML, FHIR R4 bundles). Re-importing is safe —
  duplicates collapse automatically.
- **Capture paper records.** The log button's "Paper record" petal photographs
  a handed-over document (a specialist's notes, a printed med list) straight
  into the encrypted record, with a caption and date.
- **Name the codes (optional).** Settings → Code dictionary downloads an
  offline dictionary that puts human names on lab/med/condition codes your
  documents left unnamed. Everything resolves locally; nothing is looked up
  per-code.
- **Share.** On the Share screen, exchange codes with a trusted person to grant
  them ongoing read-only access to your whole vault — or create a doctor share:
  a scoped, expiring link (and QR) that opens without an account.
