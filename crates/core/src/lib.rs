//! Svastha core: the trust contract shared across every component.
//!
//! This crate is the single source of truth for the encryption envelope and the
//! event schema. It compiles to native (for the relay and the node) and to WASM
//! (for the Svelte web app), so the security-critical code exists in exactly one
//! place. The relay never decrypts; it only verifies signatures.
//!
//! See `docs/ARCHITECTURE.md` for the design and `spec/` for the versioned wire
//! contract and its test vectors.

/// The negotiated on-the-wire contract version (envelope, event schema, relay
/// protocol), reported at `GET /v0/info`. Clients and relays negotiate on it so
/// independently deployed and self-hosted pieces can coexist. It advances
/// **additively within a major**: this value moving does not, by itself, rotate
/// any key or invalidate any stored blob — that is what [`CONTRACT_MAJOR`] is
/// for. The node/protocol wave opened the contract with the typed mailbox
/// envelope (see [`mailbox`]) and the optional event provenance field, both
/// additive, bumping this from `0` to `1`.
pub const CONTRACT_VERSION: u32 = 1;

/// The cryptographic era embedded in every HKDF / domain-separation label — key
/// derivation, key wrapping, and the event/curation/relay-auth/mailbox signing
/// prefixes (see [`version_label`]). It bumps **only** on a key-rotating break
/// that re-derives identities and re-wraps every vault key; an additive wire
/// change (a new envelope kind, a new optional field) leaves it fixed. Holding
/// it fixed across a [`CONTRACT_VERSION`] bump is exactly what keeps every
/// existing identity, wrapped vault key, and signature valid — the concrete
/// meaning of "backward compatible within a major" in `docs/ARCHITECTURE.md`.
/// It is deliberately distinct from [`CONTRACT_VERSION`] so the wire version can
/// climb as capabilities are negotiated without ever orphaning a vault.
pub(crate) const CONTRACT_MAJOR: u32 = 0;

/// HKDF `info` / domain label for a contract operation, tagged with
/// [`CONTRACT_MAJOR`] so a *major* (key-rotating) change deliberately changes
/// every derived value while an additive [`CONTRACT_VERSION`] bump does not. Key
/// derivation, envelope key wrapping, and every signing preimage share it so the
/// label scheme lives in one place.
pub(crate) fn version_label(operation: &str) -> String {
    format!("svastha/v{CONTRACT_MAJOR}/{operation}")
}

pub mod curation;
pub mod envelope;
pub mod event;
pub mod keys;
pub mod mailbox;
pub mod relay;
