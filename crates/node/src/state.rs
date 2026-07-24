//! Per-owner enrolment state, held in memory. The node is **multi-tenant from day
//! one**: each `key_handoff` from a distinct owner enrols another vault, tracked
//! independently here (keyed by the owner's Ed25519 hex).
//!
//! Only the node identity keypair is durable (see [`crate::identity`]); this state
//! is rebuilt on every boot — the keyrings from the mailbox, the index from the
//! relay's blobs — so a restart is a resync, not a recovery.

use std::collections::BTreeMap;

use svastha_core::keyring::Keyring;

use crate::index::VaultIndex;

/// One enrolled owner: the keyring that opens their vault (every epoch key wrapped
/// to the node) and the verified plaintext index built from it.
pub struct OwnerState {
    pub owner_hex: String,
    /// The owner's Ed25519 key — the signer every event and curation record in
    /// this vault must verify against.
    pub owner_key: [u8; 32],
    /// The owner's X25519 public key, as declared in their `key_handoff`. The
    /// node seals `proposal` envelopes **to** this key (D2), so it must be
    /// captured at enrolment; it is not derivable from the Ed25519 key.
    pub owner_x25519: [u8; 32],
    pub keyring: Keyring,
    pub index: VaultIndex,
    /// The relay's `ETag` last seen for each `cur-` blob id, so the next sync
    /// can send `If-None-Match` and skip re-fetching/re-verifying unchanged
    /// curation (see `crate::sync::sync_owner` and `spec/README.md`, "Curation
    /// etags"). In-memory and disposable like the rest of this state: a
    /// restart just means the first post-restart sync re-fetches every `cur-`
    /// blob once (no stored etag to compare against), then resumes saving.
    pub cur_etags: BTreeMap<String, String>,
}

/// OCR job-status counters (D2), surfaced so the later C3 admin surface's
/// `job_status` command can read them over the mailbox. Content-free by
/// construction — three integers, never a blob id or any extracted text.
///
/// - `queued` is a **gauge**: sources eligible for OCR but not yet processed at
///   the end of the last run (a persistently-failing page backing off is not
///   counted here — it is in `failed`).
/// - `processed` and `failed` are **cumulative counts** across the node's life.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct JobStatus {
    pub queued: usize,
    pub processed: u64,
    pub failed: u64,
}

/// Every vault the node has enrolled, keyed by owner Ed25519 hex.
#[derive(Default)]
pub struct NodeState {
    owners: BTreeMap<String, OwnerState>,
    jobs: JobStatus,
    /// Unix seconds of the last completed reconcile pass, surfaced by the
    /// `job_status` admin command. A timestamp — content-free.
    last_reconcile: Option<i64>,
}

impl NodeState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Enrol a new owner, or **merge** a re-delivered keyring into an existing one.
    /// Merge is the trust contract's keyring union (see `core::keyring`), so a
    /// rotation's `key_handoff` re-delivery extends the ring — the node keeps
    /// working post-rotation with no ceremony, opening both old and new epochs.
    /// Returns `true` if this enrolled a previously-unknown owner.
    pub fn enroll_or_merge(
        &mut self,
        owner_hex: String,
        owner_key: [u8; 32],
        owner_x25519: [u8; 32],
        keyring: Keyring,
    ) -> bool {
        match self.owners.get_mut(&owner_hex) {
            Some(existing) => {
                existing.keyring = Keyring::merge(&existing.keyring, &keyring);
                false
            }
            None => {
                self.owners.insert(
                    owner_hex.clone(),
                    OwnerState {
                        owner_hex,
                        owner_key,
                        owner_x25519,
                        keyring,
                        index: VaultIndex::new(owner_key),
                        cur_etags: BTreeMap::new(),
                    },
                );
                true
            }
        }
    }

    pub fn owner(&self, owner_hex: &str) -> Option<&OwnerState> {
        self.owners.get(owner_hex)
    }

    pub fn owner_mut(&mut self, owner_hex: &str) -> Option<&mut OwnerState> {
        self.owners.get_mut(owner_hex)
    }

    /// The enrolled owners' hex ids (sync iterates these).
    pub fn owner_hexes(&self) -> Vec<String> {
        self.owners.keys().cloned().collect()
    }

    /// How many vaults are enrolled (the bootstrap health page reports this — a
    /// count, never an id or any content).
    pub fn enrolled_count(&self) -> usize {
        self.owners.len()
    }

    /// The current OCR job-status counters.
    pub fn job_status(&self) -> JobStatus {
        self.jobs
    }

    /// Record the outcome of one OCR run: set the `queued` gauge and add to the
    /// cumulative `processed`/`failed` totals.
    pub fn record_ocr_run(&mut self, queued: usize, processed: u64, failed: u64) {
        self.jobs.queued = queued;
        self.jobs.processed += processed;
        self.jobs.failed += failed;
    }

    /// Stamp the time (Unix seconds) a reconcile pass finished. Reported by the
    /// `job_status` admin command as "last reconcile".
    pub fn record_reconcile(&mut self, now_secs: i64) {
        self.last_reconcile = Some(now_secs);
    }

    /// Unix seconds of the last completed reconcile, if any has run yet.
    pub fn last_reconcile(&self) -> Option<i64> {
        self.last_reconcile
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use svastha_core::envelope::DataKey;
    use svastha_core::keys::Identity;

    #[test]
    fn enroll_then_merge_extends_the_keyring() {
        let owner = Identity::from_seed(b"owner");
        let node = Identity::from_seed(b"node");
        let owner_key = owner.verifying_key().to_bytes();
        let owner_hex = hex::encode(owner_key);

        // Genesis keyring wrapped to the node.
        let data_key = DataKey::generate();
        let owner_x = owner.x25519_public().to_bytes();
        let genesis = Keyring::genesis(&owner.x25519_public(), &data_key)
            .wrap_for_grantee(&owner, &node.x25519_public())
            .unwrap();

        let mut state = NodeState::new();
        assert!(state.enroll_or_merge(owner_hex.clone(), owner_key, owner_x, genesis.clone()));
        assert_eq!(state.enrolled_count(), 1);

        // A rotation, re-delivered to the node.
        let (rotated_owner, _k) =
            Keyring::genesis(&owner.x25519_public(), &data_key).rotate(&owner.x25519_public(), 100);
        let rotated = rotated_owner
            .wrap_for_grantee(&owner, &node.x25519_public())
            .unwrap();
        // Re-delivery merges, not a new enrolment.
        assert!(!state.enroll_or_merge(owner_hex.clone(), owner_key, owner_x, rotated));
        assert_eq!(state.enrolled_count(), 1);
        // Union: genesis + rotation = 2 epochs.
        assert_eq!(state.owner(&owner_hex).unwrap().keyring.entries().len(), 2);
    }
}
