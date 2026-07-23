//! Auth replay hardening: a short-lived memory of recently-seen request
//! signatures, so a captured request cannot be replayed within the auth
//! freshness window.
//!
//! The signed auth preimage binds method, path, body hash, and timestamp
//! (`spec/README.md`, "Auth handshake"), so a signature is unique to one
//! concrete request and Ed25519 (RFC 8032) is deterministic — a byte-for-byte
//! replay therefore carries the *identical* signature. The timestamp already
//! bounds how long a signature is accepted (the freshness window); remembering
//! seen signatures until they age out of that window, and rejecting a repeat,
//! closes the replay gap the window alone leaves open.
//!
//! The signature itself is the nonce: no separate nonce field is added to the
//! wire format, so this is a purely server-side hardening — the contract's
//! signed bytes are unchanged.
//!
//! TRADE-OFF — in-memory only, no filesystem variant. A relay restart clears
//! the window, briefly reopening replay for any signature whose timestamp has
//! not yet aged out. That is deliberate: it keeps the relay a keyless single
//! binary with no durable server-side auth state, and the residual exposure is
//! narrow — an attacker must capture a live, valid request and replay it inside
//! the small freshness window *across the exact moment of a restart*. Persisting
//! nonces would buy little against that and cost the relay its statelessness.

use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::sync::Mutex;

/// Remembers request signatures until they age out of the auth freshness
/// window, so a replay within that window is detected and rejected.
#[derive(Default)]
pub struct NonceStore {
    // signature bytes -> unix-seconds after which the request's own timestamp
    // can no longer pass the freshness check, so the entry is safe to forget.
    seen: Mutex<HashMap<[u8; 64], u64>>,
}

impl NonceStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a freshly-verified request signature. Returns `true` if it is new
    /// (accept the request) and `false` if it has been seen before within the
    /// window (a replay — reject it).
    ///
    /// `expires_at` is the unix-seconds instant past which the request's
    /// timestamp fails the freshness window, so the signature need not be
    /// remembered beyond it. `now` drives an opportunistic prune of aged-out
    /// entries, bounding the map to at most one freshness window of traffic.
    pub fn check_and_remember(&self, signature: &[u8; 64], expires_at: u64, now: u64) -> bool {
        let mut seen = self.seen.lock().unwrap();
        // Opportunistic prune: anything already past its freshness horizon is
        // rejected by the timestamp check anyway, so it need not be retained.
        seen.retain(|_, exp| *exp > now);
        match seen.entry(*signature) {
            Entry::Occupied(_) => false,
            Entry::Vacant(slot) => {
                slot.insert(expires_at);
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sig(b: u8) -> [u8; 64] {
        [b; 64]
    }

    #[test]
    fn first_use_accepts_replay_rejects() {
        let store = NonceStore::new();
        let now = 1_000;
        let expires = now + 300;
        assert!(store.check_and_remember(&sig(1), expires, now));
        // Same signature again inside the window: a replay.
        assert!(!store.check_and_remember(&sig(1), expires, now));
        // A different signature is unaffected.
        assert!(store.check_and_remember(&sig(2), expires, now));
    }

    #[test]
    fn aged_out_signature_is_forgotten_and_reusable() {
        let store = NonceStore::new();
        let expires = 1_300;
        assert!(store.check_and_remember(&sig(1), expires, 1_000));
        // Well past the freshness horizon: the entry is pruned, so the same
        // signature is "new" again — harmless, since the timestamp check in the
        // auth middleware rejects it before it ever reaches here.
        assert!(store.check_and_remember(&sig(1), 2_000, 1_400));
    }
}
