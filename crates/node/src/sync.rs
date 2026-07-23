//! Enrolment and sync: how the node turns a grant plus a `key_handoff` into a
//! decrypted, verified, curation-aware index of an owner's vault.
//!
//! **Enrolment** ([`consume_mailbox`]) drains the node's mailbox. A `key_handoff`
//! from an owner — verified-or-dropped, then bound to the relay's `svastha-from`
//! attestation — carries the vault keyring wrapped to the node; consuming it
//! enrols (or, on rotation re-delivery, merges) that owner. The bare wrapped-key
//! deposit is grandfathered too. Handoffs are **not deleted**: the mailbox is the
//! node's durable enrolment record, re-read on every restart to rebuild the
//! disposable state (other message kinds are left untouched for the later PRs that
//! consume them).
//!
//! **Sync** ([`sync_owner`]) pulls a vault through the relay's shared-blob
//! endpoints (the node is a prefix-scoped grantee — it just pulls what the listing
//! returns), opens each blob with the keyring (trial-decrypt handles epochs), and
//! **verifies-or-drops everything** before it reaches the index: event and
//! curation signatures, and every content hash against its blob id.

use std::sync::Mutex;

use anyhow::Result;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use svastha_core::curation::SignedCurationRecord;
use svastha_core::event::SignedEvent;
use svastha_core::keyring::Keyring;
use svastha_core::keys::Identity;
use svastha_core::mailbox::{
    parse_mailbox_item, KeyHandoffBody, MailboxItem, MailboxMessage, MessageKind,
};

use crate::cache::Cache;
use crate::client::RelayClient;
use crate::index::{AttachmentMeta, CurationOutcome, DocMeta};
use crate::state::NodeState;

/// A resolved enrolment: `(owner_hex, owner_ed_key, keyring_wrapped_to_node)`.
type Enrollment = (String, [u8; 32], Keyring);

/// What one mailbox drain enrolled.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct EnrollReport {
    /// Owners enrolled for the first time.
    pub newly_enrolled: usize,
    /// Re-delivered keyrings merged into an existing owner (rotation).
    pub keyrings_merged: usize,
    /// Items dropped by verify-or-drop (bad envelope, sender mismatch, not sealed
    /// to us, or malformed).
    pub dropped: usize,
    /// Verified items in a kind the substrate does not yet handle (left in place).
    pub ignored: usize,
}

/// What one vault sync pulled. Counts and the granted flag only — never content.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SyncReport {
    /// False when the relay answered `404` for the listing — no live grant
    /// (revoked or expired); the node holds the keyring but can pull nothing new.
    pub granted: bool,
    pub events: usize,
    pub curation_applied: usize,
    pub curation_ignored: usize,
    pub attachments: usize,
    pub docs: usize,
    /// Blobs that failed verify-or-drop (open failed, bad signature, or a content
    /// hash that did not match its blob id).
    pub dropped: usize,
    /// Listed ids in no namespace the node consumes (e.g. an unscoped grant that
    /// also lists `vault.key`); tolerated and skipped.
    pub skipped: usize,
}

/// An `att-`/`doc-` blob body: bytes carried base64 in JSON (see
/// `docs/ARCHITECTURE.md`, "Sync and backup").
#[derive(Deserialize)]
struct AttachmentBlob {
    mime: String,
    bytes: String,
}

#[derive(Deserialize)]
struct DocBlob {
    name: String,
    bytes: String,
}

/// The decrypted, verified-or-dropped results of one vault pull, accumulated
/// outside the state lock and applied to the index under it.
#[derive(Default)]
struct Batch {
    events: Vec<SignedEvent>,
    curation: Vec<SignedCurationRecord>,
    attachments: Vec<(String, AttachmentMeta)>,
    docs: Vec<(String, DocMeta)>,
    dropped: usize,
    skipped: usize,
}

/// Drain the node's mailbox, enrolling every owner whose `key_handoff` verifies.
pub fn consume_mailbox(client: &RelayClient, state: &Mutex<NodeState>) -> Result<EnrollReport> {
    let mut report = EnrollReport::default();
    for entry in client.list_mailbox()? {
        let Some((bytes, from_relay)) = client.get_mailbox(&entry.id)? else {
            continue; // deleted between listing and fetch
        };
        let Ok(item) = parse_mailbox_item(&bytes) else {
            report.dropped += 1;
            continue;
        };
        let enrolled = match item {
            MailboxItem::Message(msg) => {
                // Verify-or-drop before decrypting, then bind the envelope's
                // claimed sender to the relay's attestation of who deposited it.
                if !msg.verify() || msg.from_hex() != from_relay {
                    report.dropped += 1;
                    continue;
                }
                match msg.kind {
                    MessageKind::KeyHandoff => handle_key_handoff(client.identity(), &msg),
                    // Proposals, admin, chat: not handled by the substrate. Left in
                    // the mailbox for the later PR that consumes them.
                    _ => {
                        report.ignored += 1;
                        continue;
                    }
                }
            }
            MailboxItem::Legacy(dep) => handle_key_material(
                client.identity(),
                &dep.wrapped_hex,
                &dep.from_ed,
                &from_relay,
            ),
        };
        match enrolled {
            Some((owner_hex, owner_key, keyring)) => {
                let mut guard = state.lock().expect("node state mutex");
                if guard.enroll_or_merge(owner_hex, owner_key, keyring) {
                    report.newly_enrolled += 1;
                } else {
                    report.keyrings_merged += 1;
                }
            }
            None => report.dropped += 1,
        }
    }
    Ok(report)
}

/// Open a verified `key_handoff` envelope and resolve it to an enrolment. The
/// owner is the envelope sender (`from`); the sealed body's self-claimed `from_ed`
/// is bound to it as a second check.
fn handle_key_handoff(node: &Identity, msg: &MailboxMessage) -> Option<Enrollment> {
    let body = msg.open(node).ok()?;
    let body: KeyHandoffBody = serde_json::from_slice(&body).ok()?;
    handle_key_material(node, &body.wrapped_hex, &body.from_ed, &msg.from_hex())
}

/// Turn a wrapped keyring (or grandfathered bare wrapped key) into an enrolment.
/// Binds the payload's self-claimed owner to the attested owner, decodes the
/// keyring, and proves it is sealed to this node by unwrapping the newest epoch.
fn handle_key_material(
    node: &Identity,
    wrapped_hex: &str,
    claimed_owner_hex: &str,
    attested_owner_hex: &str,
) -> Option<Enrollment> {
    if claimed_owner_hex != attested_owner_hex {
        return None;
    }
    let owner_key = hex32(attested_owner_hex)?;
    let bytes = hex::decode(wrapped_hex).ok()?;
    // `from_bytes` reads either the `svkr` keyring container or a legacy bare
    // wrapped key (as a one-epoch genesis keyring) — grandfathering within the
    // major.
    let keyring = Keyring::from_bytes(&bytes).ok()?;
    // Prove the ring is wrapped to us before enrolling on it.
    keyring.newest_key(node).ok()?;
    Some((attested_owner_hex.to_string(), owner_key, keyring))
}

/// Sync one enrolled owner's vault into its index. A `404` listing means the grant
/// is gone (revocation/expiry) — the node keeps the keyring but pulls nothing.
pub fn sync_owner(
    client: &RelayClient,
    cache: &Cache,
    state: &Mutex<NodeState>,
    owner_hex: &str,
) -> Result<SyncReport> {
    // Snapshot the keyring so the network + decrypt work happens off the lock.
    let keyring = {
        let guard = state.lock().expect("node state mutex");
        match guard.owner(owner_hex) {
            Some(os) => os.keyring.clone(),
            None => return Ok(SyncReport::default()),
        }
    };

    let ids = match client.list_shared_blobs(owner_hex)? {
        Some(ids) => ids,
        None => {
            return Ok(SyncReport {
                granted: false,
                ..Default::default()
            })
        }
    };

    let mut batch = Batch::default();
    for id in ids {
        let Some(sealed) = client.get_shared_blob(owner_hex, &id)? else {
            continue; // deleted between listing and fetch
        };
        dispatch(
            client.identity(),
            &keyring,
            cache,
            owner_hex,
            &id,
            &sealed,
            &mut batch,
        )?;
    }

    // Apply the verified batch to the index under the lock. Ingest re-verifies
    // signatures against the owner, the authoritative verify-or-drop gate.
    let mut report = SyncReport {
        granted: true,
        dropped: batch.dropped,
        skipped: batch.skipped,
        ..Default::default()
    };
    let mut guard = state.lock().expect("node state mutex");
    let Some(os) = guard.owner_mut(owner_hex) else {
        return Ok(report);
    };
    for ev in batch.events {
        if os.index.ingest_event(ev) {
            report.events += 1;
        } else {
            report.dropped += 1;
        }
    }
    for rec in batch.curation {
        match os.index.ingest_curation(rec) {
            CurationOutcome::Applied => report.curation_applied += 1,
            CurationOutcome::IgnoredNamespace => report.curation_ignored += 1,
            CurationOutcome::Dropped => report.dropped += 1,
        }
    }
    for (sha, meta) in batch.attachments {
        os.index.put_attachment(sha, meta);
        report.attachments += 1;
    }
    for (sha, meta) in batch.docs {
        os.index.put_doc(sha, meta);
        report.docs += 1;
    }
    Ok(report)
}

/// Sync every enrolled owner. Returns one report per owner.
pub fn sync_all(
    client: &RelayClient,
    cache: &Cache,
    state: &Mutex<NodeState>,
) -> Result<Vec<(String, SyncReport)>> {
    let owners = state.lock().expect("node state mutex").owner_hexes();
    let mut out = Vec::with_capacity(owners.len());
    for owner in owners {
        let report = sync_owner(client, cache, state, &owner)?;
        out.push((owner, report));
    }
    Ok(out)
}

/// Open one blob, verify-or-drop it, and route it into `batch` by namespace. The
/// keyring's trial decryption picks the right epoch; a blob that opens under no
/// epoch (tampered, or an epoch the node was never handed) is dropped.
fn dispatch(
    node: &Identity,
    keyring: &Keyring,
    cache: &Cache,
    owner_hex: &str,
    id: &str,
    sealed: &[u8],
    batch: &mut Batch,
) -> Result<()> {
    let Ok(plain) = keyring.open_blob(node, id.as_bytes(), sealed) else {
        batch.dropped += 1;
        return Ok(());
    };

    if let Some(hex_id) = id.strip_prefix("ev-") {
        let Ok(signed) = serde_json::from_slice::<SignedEvent>(&plain) else {
            batch.dropped += 1;
            return Ok(());
        };
        // The embedded content id must match the id it was stored under; the
        // signature (checked at ingest) must verify against the owner.
        if signed.event.id.to_hex() != hex_id {
            batch.dropped += 1;
            return Ok(());
        }
        batch.events.push(signed);
    } else if let Some(sha) = id.strip_prefix("att-") {
        let Ok(att) = serde_json::from_slice::<AttachmentBlob>(&plain) else {
            batch.dropped += 1;
            return Ok(());
        };
        let Ok(raw) = BASE64.decode(att.bytes.as_bytes()) else {
            batch.dropped += 1;
            return Ok(());
        };
        if hex::encode(Sha256::digest(&raw)) != sha {
            batch.dropped += 1;
            return Ok(());
        }
        cache.write_attachment(owner_hex, sha, &raw)?;
        batch.attachments.push((
            sha.to_string(),
            AttachmentMeta {
                mime: att.mime,
                size: raw.len(),
            },
        ));
    } else if let Some(sha) = id.strip_prefix("doc-") {
        let Ok(doc) = serde_json::from_slice::<DocBlob>(&plain) else {
            batch.dropped += 1;
            return Ok(());
        };
        let Ok(raw) = BASE64.decode(doc.bytes.as_bytes()) else {
            batch.dropped += 1;
            return Ok(());
        };
        if hex::encode(Sha256::digest(&raw)) != sha {
            batch.dropped += 1;
            return Ok(());
        }
        cache.write_doc(owner_hex, sha, &raw)?;
        batch.docs.push((
            sha.to_string(),
            DocMeta {
                name: doc.name,
                size: raw.len(),
            },
        ));
    } else if let Some(hash) = id.strip_prefix("cur-") {
        let Ok(rec) = serde_json::from_slice::<SignedCurationRecord>(&plain) else {
            batch.dropped += 1;
            return Ok(());
        };
        if hex::encode(Sha256::digest(rec.record.key.as_bytes())) != hash {
            batch.dropped += 1;
            return Ok(());
        }
        batch.curation.push(rec);
    } else {
        // vault.key under a legacy unscoped grant, or any future namespace:
        // tolerated-unknown — skip rather than drop.
        batch.skipped += 1;
    }
    Ok(())
}

fn hex32(s: &str) -> Option<[u8; 32]> {
    hex::decode(s).ok()?.try_into().ok()
}
