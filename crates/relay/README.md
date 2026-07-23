# svastha-relay

The [Svastha](https://github.com/cosmicspork/svastha) relay: a zero-knowledge
store-and-forward server for encrypted blobs. It holds no keys and never
decrypts — it stores opaque ciphertext scoped to an owner public key and
authenticates every request with a per-request Ed25519 signature (verified via
[`svastha-core`](https://crates.io/crates/svastha-core)). Ships as a single
static binary for trivial self-hosting.

Run with `cargo run -p svastha-relay`; configure via `SVASTHA_RELAY_ADDR`,
`SVASTHA_RELAY_MAX_SKEW_SECS`, and `SVASTHA_RELAY_DATA_DIR`.

## Push channel

`GET /v0/events` is a long-lived authenticated Server-Sent Events stream of
payload-free "go pull" pokes (the pull endpoints stay the source of truth; the
stream is a lossy optimization). It emits a heartbeat comment roughly every 30
seconds so idle connections survive intermediaries that close a quiet stream.
If you terminate TLS or reverse-proxy in front of the relay, set the proxy's
**read/idle timeout above the heartbeat interval** (a minute or more), or the
stream will be severed mid-life; disable response buffering for the endpoint so
pokes flush immediately.

> Pre-1.0 and unstable.

Licensed under AGPL-3.0-only.
