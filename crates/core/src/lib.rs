//! Svastha core: the trust contract shared across every component.
//!
//! This crate is the single source of truth for the encryption envelope and the
//! event schema. It compiles to native (for the relay and the node) and to WASM
//! (for the Svelte web app), so the security-critical code exists in exactly one
//! place. The relay never decrypts; it only verifies signatures.
//!
//! See `docs/ARCHITECTURE.md` for the design and `spec/` for the versioned wire
//! contract and its test vectors.

/// Version of the on-the-wire trust contract (envelope, event schema, relay
/// protocol). Bump on any breaking change. Clients and relays negotiate on it so
/// that independently deployed and self-hosted pieces can coexist.
pub const CONTRACT_VERSION: u32 = 0;

/// HKDF `info` label for a contract operation, tagged with [`CONTRACT_VERSION`]
/// so a version bump deliberately changes every derived value. Key derivation
/// and envelope key wrapping share it so the label scheme lives in one place.
pub(crate) fn version_label(operation: &str) -> String {
    format!("svastha/v{CONTRACT_VERSION}/{operation}")
}

pub mod envelope;
pub mod event;
pub mod keys;
pub mod relay;
