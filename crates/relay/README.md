# svastha-relay

The [Svastha](https://github.com/cosmicspork/svastha) relay: a zero-knowledge
store-and-forward server for encrypted blobs. It holds no keys and never
decrypts — it stores opaque ciphertext scoped to an owner public key and
authenticates every request with a per-request Ed25519 signature (verified via
[`svastha-core`](https://crates.io/crates/svastha-core)). Ships as a single
static binary for trivial self-hosting.

Run with `cargo run -p svastha-relay`; configure via `SVASTHA_RELAY_ADDR`,
`SVASTHA_RELAY_MAX_SKEW_SECS`, and `SVASTHA_RELAY_DATA_DIR`.

> Pre-1.0 and unstable.

Licensed under AGPL-3.0-only.
