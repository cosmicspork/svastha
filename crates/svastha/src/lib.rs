//! Svastha: self-custodial, end-to-end-encrypted, local-first personal medical
//! records.
//!
//! This is the umbrella crate. It re-exports [`svastha_core`], the trust
//! contract (encryption envelope, event schema, relay protocol) that is the
//! single source of truth shared across the relay, the node, and the WASM build
//! consumed by the web app. Depend on this crate to get the public API under the
//! bare `svastha` name; the surface is identical to `svastha-core`.
//!
//! See `docs/ARCHITECTURE.md` for the design and `spec/` for the versioned wire
//! contract and its test vectors.

pub use svastha_core::*;
