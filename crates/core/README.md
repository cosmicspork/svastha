# svastha-core

The Svastha trust contract: the encryption envelope, the typed/signed event
schema, identity key derivation, and the relay auth handshake. This is the single
source of truth for the security-critical wire format — it compiles to native
(relay, node) and to WASM (the web app), so every component runs the exact same
bytes. The relay never decrypts.

Part of [Svastha](https://github.com/cosmicspork/svastha): self-custodial,
end-to-end-encrypted, local-first personal medical records. See the repo's
`docs/ARCHITECTURE.md` and `spec/` for the design and the language-neutral test
vectors.

> Pre-1.0 and unstable: `CONTRACT_VERSION` is `0` and the wire format may change
> between releases.

Licensed under AGPL-3.0-only.
