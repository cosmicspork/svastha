//! The OCR → proposals pipeline (design §7). For each enrolled owner it walks the
//! captured **image** pages the substrate indexed, runs each through vision
//! inference, turns the extracted findings into unsigned draft events, and
//! deposits them as `proposal` envelopes into the owner's mailbox for review in
//! the PWA. It never signs anything as the owner — it proposes; the owner signs.
//!
//! **Serial by design.** Pages are processed one at a time, per owner. Inference
//! endpoints are rate-limited, and a medical record is not a throughput problem —
//! keeping it serial keeps it simple and polite, and a failure backs off (below)
//! rather than fanning out retries.
//!
//! **Idempotence** lives in the [`crate::journal`] (the durable, content-free
//! record of what has been proposed/resolved/failed) — see that module for the
//! rules. This module only *drives* it: it skips ineligible sources, marks
//! outcomes, and folds incoming `proposal_result`s back into it.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use svastha_core::event::{Event, Provenance};
use svastha_core::mailbox::{
    parse_mailbox_item, DraftProposal, MailboxItem, MailboxMessage, MessageKind, ProposalBody,
    ProposalResultBody,
};
use svastha_import::EventDraft;
use x25519_dalek::PublicKey;

use crate::cache::Cache;
use crate::client::RelayClient;
use crate::extract;
use crate::inference::InferenceClient;
use crate::journal::Journal;
use crate::state::NodeState;

/// The extraction method stamped into every draft's provenance (and, on approval,
/// the event's `proposed.method`).
const OCR_METHOD: &str = "ocr";
/// The human provenance label on an OCR'd event. The machine-readable linkage
/// (source blob, method, model) rides the proposal, not this string.
const SOURCE_LABEL: &str = "node-ocr";

/// Plaintext budget for one `proposal` body. The relay caps a mailbox item at
/// 4 KiB; the envelope hex-encodes the sealed body (≈ 2× plus ~0.5 KiB of fixed
/// fields), so a plaintext body under this bound keeps the whole item inside the
/// cap. A page with more findings than fit is split across several envelopes.
const PLAINTEXT_BUDGET: usize = 1600;

/// What one OCR pass did. Counts and ids only — never extracted content.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct OcrReport {
    /// Sources for which a proposal batch was deposited.
    pub proposals: u64,
    /// Sources that extracted nothing (recorded processed, not proposed).
    pub empties: u64,
    /// Sources whose inference or deposit failed this pass (backed off).
    pub failed: u64,
    /// Incoming `proposal_result`s that newly resolved a source.
    pub resolved: u64,
    /// Eligible sources whose plaintext was not yet in the ephemeral cache.
    pub not_ready: usize,
    /// Findings dropped as unmappable across all sources this pass.
    pub dropped_findings: usize,
}

/// A per-owner snapshot taken under the state lock, so inference and network I/O
/// run off it.
struct OwnerJob {
    owner_hex: String,
    owner_x25519: [u8; 32],
    /// `(sha256, mime, capture_time)` for each indexed image attachment.
    sources: Vec<(String, String, Option<String>)>,
}

/// Run one OCR pass over every enrolled owner. Errors on the *listing* round-trips
/// propagate (the caller logs and reconciles next tick); per-source failures never
/// propagate — they back off in the journal so one bad page cannot wedge the rest.
pub fn run(
    client: &RelayClient,
    cache: &Cache,
    state: &Mutex<NodeState>,
    inference: &InferenceClient,
    journal: &mut Journal,
) -> Result<OcrReport> {
    // First fold in any owner decisions that came back, so a resolved source is
    // skipped below even if its journal entry was only "deposited".
    let mut report = OcrReport {
        resolved: collect_resolutions(client, journal)?,
        ..Default::default()
    };

    let now_secs = now_secs();
    let node = client.identity();
    for job in snapshot_jobs(state) {
        let recipient = PublicKey::from(job.owner_x25519);
        for (sha, mime, capture) in &job.sources {
            let source_id = format!("att-{sha}");
            if !journal.eligible(&job.owner_hex, &source_id, now_secs) {
                continue;
            }
            let bytes = match cache.read_attachment(&job.owner_hex, sha)? {
                Some(b) => b,
                // The cache is ephemeral: a page the index knows about may not be
                // on disk yet. Not a failure, not terminal — retry next pass.
                None => {
                    report.not_ready += 1;
                    continue;
                }
            };

            match inference.extract(&bytes, mime) {
                Err(e) => {
                    journal.mark_failed(&job.owner_hex, &source_id, now_secs)?;
                    report.failed += 1;
                    tracing::warn!(
                        owner = short(&job.owner_hex),
                        model = inference.model(),
                        error = %e,
                        "ocr inference failed; backing off this page"
                    );
                }
                Ok(answer) => {
                    let extracted = extract::parse(&answer);
                    report.dropped_findings += extracted.dropped;
                    if extracted.drafts.is_empty() {
                        journal.mark_empty(&job.owner_hex, &source_id)?;
                        report.empties += 1;
                        continue;
                    }
                    let drafts = build_draft_proposals(
                        extracted.drafts,
                        &source_id,
                        inference.model(),
                        capture.as_deref(),
                    );
                    match deposit_proposals(client, node, &recipient, &job.owner_hex, drafts) {
                        Ok(msg_ids) => {
                            journal.mark_deposited(&job.owner_hex, &source_id, &msg_ids)?;
                            report.proposals += 1;
                        }
                        Err(e) => {
                            journal.mark_failed(&job.owner_hex, &source_id, now_secs)?;
                            report.failed += 1;
                            tracing::warn!(
                                owner = short(&job.owner_hex),
                                error = %e,
                                "proposal deposit failed; backing off this page"
                            );
                        }
                    }
                }
            }
        }
    }

    let queued = journal.awaiting_retry();
    state.lock().expect("node state mutex").record_ocr_run(
        queued,
        report.proposals + report.empties,
        report.failed,
    );
    Ok(report)
}

/// Snapshot each owner's image-attachment work list under the state lock.
fn snapshot_jobs(state: &Mutex<NodeState>) -> Vec<OwnerJob> {
    let guard = state.lock().expect("node state mutex");
    guard
        .owner_hexes()
        .into_iter()
        .filter_map(|owner_hex| {
            let os = guard.owner(&owner_hex)?;
            let sources = os
                .index
                .image_attachment_shas()
                .into_iter()
                .map(|sha| {
                    let mime = os
                        .index
                        .attachment(&sha)
                        .map(|m| m.mime.clone())
                        .unwrap_or_default();
                    let capture = os.index.attachment_capture_time(&sha);
                    (sha, mime, capture)
                })
                .collect();
            Some(OwnerJob {
                owner_hex,
                owner_x25519: os.owner_x25519,
                sources,
            })
        })
        .collect()
}

/// Drain the node's own mailbox for `proposal_result`s and apply each to the
/// journal. The result is honoured only when it verifies, its sender matches the
/// relay's attestation, and the journal maps its `proposal_id` to a source that
/// sender owns — so a forged result (which cannot know a proposal id it never saw,
/// nor sign as the owner) resolves nothing. Results are left in the mailbox (a
/// durable record, re-applied idempotently each pass), matching the substrate's
/// leave-in-place posture.
fn collect_resolutions(client: &RelayClient, journal: &mut Journal) -> Result<u64> {
    let mut resolved = 0;
    for entry in client.list_mailbox()? {
        let Some((bytes, from_relay)) = client.get_mailbox(&entry.id)? else {
            continue;
        };
        let Ok(MailboxItem::Message(msg)) = parse_mailbox_item(&bytes) else {
            continue;
        };
        if msg.kind != MessageKind::ProposalResult {
            continue;
        }
        if !msg.verify() || msg.from_hex() != from_relay {
            continue;
        }
        let Ok(plain) = msg.open(client.identity()) else {
            continue;
        };
        let Ok(body) = serde_json::from_slice::<ProposalResultBody>(&plain) else {
            continue;
        };
        if journal.resolve(&msg.from_hex(), &body.proposal_id)? {
            resolved += 1;
        }
    }
    Ok(resolved)
}

/// Turn extracted drafts into unsigned proposal drafts: build the schema-valid
/// [`Event`] (dating it from the fact, else the page's capture time), and attach
/// the source-blob / method / model provenance the owner's signature will later
/// cover via `proposed`.
fn build_draft_proposals(
    drafts: Vec<EventDraft>,
    source_id: &str,
    model: &str,
    capture: Option<&str>,
) -> Vec<DraftProposal> {
    drafts
        .into_iter()
        .map(|d| {
            let effective_at = d.effective_at.or_else(|| capture.map(str::to_string));
            let event = Event::new(
                d.kind,
                d.code,
                effective_at,
                d.value,
                Provenance {
                    source: SOURCE_LABEL.to_string(),
                    source_doc: None,
                },
            );
            DraftProposal {
                event,
                source_blob: Some(source_id.to_string()),
                method: Some(OCR_METHOD.to_string()),
                model: Some(model.to_string()),
            }
        })
        .collect()
}

/// Seal and deposit the drafts as one or more `proposal` envelopes (chunked to fit
/// the mailbox cap), returning the deposited message ids for the journal.
///
/// A multi-envelope deposit that fails partway is reported as a failure so the
/// whole source retries; a re-proposed batch that already landed is harmless —
/// approved events are content-addressed, so a duplicate collapses to one event
/// id. The single-envelope common case is atomic.
fn deposit_proposals(
    client: &RelayClient,
    node: &svastha_core::keys::Identity,
    recipient: &PublicKey,
    owner_hex: &str,
    drafts: Vec<DraftProposal>,
) -> Result<Vec<String>> {
    let mut msg_ids = Vec::new();
    for batch in chunk_by_budget(drafts) {
        let body = ProposalBody { proposals: batch };
        let plaintext = serde_json::to_vec(&body)?;
        let envelope =
            MailboxMessage::seal(node, recipient, MessageKind::Proposal, now_ms(), &plaintext);
        let item_id = format!("prop-{}", envelope.id_hex());
        let bytes = serde_json::to_vec(&envelope)?;
        client.put_mailbox(owner_hex, &item_id, &bytes)?;
        msg_ids.push(envelope.id_hex());
    }
    Ok(msg_ids)
}

/// Greedily group drafts so each group's serialized body stays under
/// [`PLAINTEXT_BUDGET`]. A single draft that alone exceeds the budget is emitted
/// on its own (best effort — the relay may reject an oversized item, which surfaces
/// as a deposit failure and backs off).
fn chunk_by_budget(drafts: Vec<DraftProposal>) -> Vec<Vec<DraftProposal>> {
    let mut batches: Vec<Vec<DraftProposal>> = Vec::new();
    let mut cur: Vec<DraftProposal> = Vec::new();
    for d in drafts {
        cur.push(d);
        if cur.len() > 1 && body_len(&cur) > PLAINTEXT_BUDGET {
            let overflow = cur.pop().expect("just pushed");
            batches.push(std::mem::take(&mut cur));
            cur.push(overflow);
        }
    }
    if !cur.is_empty() {
        batches.push(cur);
    }
    batches
}

fn body_len(batch: &[DraftProposal]) -> usize {
    let body = ProposalBody {
        proposals: batch.to_vec(),
    };
    serde_json::to_vec(&body)
        .map(|v| v.len())
        .unwrap_or(usize::MAX)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// A log-safe short form of an owner id (a public key hex, not PHI).
fn short(owner_hex: &str) -> String {
    owner_hex.chars().take(12).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use svastha_core::event::{Code, EventKind, EventValue};

    fn draft(text_len: usize) -> DraftProposal {
        let event = Event::new(
            EventKind::Document,
            None,
            Some("2026-01-01T00:00:00Z".into()),
            Some(EventValue::Text("x".repeat(text_len))),
            Provenance {
                source: SOURCE_LABEL.into(),
                source_doc: None,
            },
        );
        DraftProposal {
            event,
            source_blob: Some("att-deadbeef".into()),
            method: Some(OCR_METHOD.into()),
            model: Some("m".into()),
        }
    }

    #[test]
    fn small_findings_are_one_batch() {
        let batches = chunk_by_budget(vec![draft(10), draft(10), draft(10)]);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].len(), 3);
    }

    #[test]
    fn oversized_findings_split_across_batches() {
        // Each draft carries ~700 bytes of text, so two exceed the 1600 budget.
        let batches = chunk_by_budget(vec![draft(700), draft(700), draft(700)]);
        assert!(batches.len() > 1, "must split to fit the mailbox cap");
        for b in &batches {
            assert!(!b.is_empty());
        }
    }

    #[test]
    fn build_dates_from_capture_when_finding_has_none() {
        let d = EventDraft {
            kind: EventKind::Observation,
            code: Some(Code {
                system: "http://loinc.org".into(),
                code: "8480-6".into(),
                display: None,
            }),
            effective_at: None,
            value: Some(EventValue::Quantity {
                value: "120".into(),
                unit: None,
            }),
        };
        let out = build_draft_proposals(vec![d], "att-abc", "vision-1", Some("2026-05-05"));
        assert_eq!(out[0].event.effective_at.as_deref(), Some("2026-05-05"));
        assert_eq!(out[0].source_blob.as_deref(), Some("att-abc"));
        assert_eq!(out[0].method.as_deref(), Some("ocr"));
        assert_eq!(out[0].model.as_deref(), Some("vision-1"));
        // The draft is unsigned and carries no `proposed` — the owner stamps that.
        assert!(out[0].event.proposed.is_none());
    }

    #[test]
    fn finding_date_wins_over_capture() {
        let d = EventDraft {
            kind: EventKind::Observation,
            code: None,
            effective_at: Some("2020-01-01".into()),
            value: Some(EventValue::Text("note".into())),
        };
        let out = build_draft_proposals(vec![d], "att-abc", "m", Some("2026-05-05"));
        assert_eq!(out[0].event.effective_at.as_deref(), Some("2020-01-01"));
    }
}
