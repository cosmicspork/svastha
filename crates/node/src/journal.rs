//! The OCR idempotence journal — the node's durable record of which captured
//! pages it has already acted on, so a restart never re-deposits a duplicate
//! proposal.
//!
//! ## Why this is safe to persist (it is metadata-only, by construction)
//!
//! The plaintext cache is ephemeral (design §7); the node identity is the only
//! other durable state. This journal sits **alongside the identity in the data
//! dir**, and it is the one exception to "durable = identity only" — permitted
//! because it holds *no plaintext*. Every value it stores is already relay-visible
//! routing metadata: `att-`/`doc-` **blob ids** (content hashes the relay stores
//! blobs under) and mailbox **message ids** (the envelope ids the relay forwards).
//! There is no extracted text, no event content, no image bytes — nothing the
//! relay does not already hold. So persisting it leaks nothing new, and it is what
//! lets idempotence survive the one thing the ephemeral cache cannot: a restart
//! between depositing a proposal and the owner acting on it.
//!
//! ## The idempotence rules, in one place
//!
//! A captured page (an `att-` source) is a candidate for OCR **iff** it is not
//! already terminal and not in a failure back-off:
//!
//! - **Deposited / Resolved / Empty are terminal — never re-propose.**
//!   - *Deposited*: a proposal is already in the owner's mailbox; awaiting action.
//!   - *Resolved*: a `proposal_result` came back — **accepted or rejected both
//!     mean done.** Rejected means rejected: a rejected source is never
//!     re-proposed, and neither is a source that disappears and later reappears
//!     (re-shared) — the journal is keyed by the stable content hash and outlives
//!     the blob's presence.
//!   - *Empty*: OCR ran and found nothing legible; recorded processed, not
//!     proposed.
//! - **Failed is the only retryable state**, and only after its back-off elapses,
//!   so one persistently-failing page backs off instead of wedging the queue.
//!
//! Resolution maps a `proposal_result`'s `proposal_id` back to its source through
//! this journal; it is honoured only when the result is signed by the same owner
//! the source belongs to (checked in [`crate::ocr`]). If the journal is ever lost,
//! idempotence degrades gracefully to re-propose-and-dedup: approved events are
//! content-addressed, so a duplicate proposal collapses to the same event id.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// The journal file under the data dir.
const JOURNAL_FILE: &str = "ocr-journal.json";

/// Back-off schedule for a failing page: 60s doubling per attempt, capped at an
/// hour, so a broken page retries occasionally without ever blocking the others.
const BACKOFF_BASE_SECS: i64 = 60;
const BACKOFF_CAP_SECS: i64 = 3600;

/// The state of one captured page in the pipeline.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SourceStatus {
    /// One or more proposal envelopes were deposited; awaiting the owner.
    Deposited,
    /// The owner acted (accepted or rejected). Terminal.
    Resolved,
    /// OCR ran and extracted nothing. Terminal.
    Empty,
    /// A transient failure; retry once `next_at` (Unix seconds) has passed.
    Failed { attempts: u32, next_at: i64 },
}

impl SourceStatus {
    /// Terminal states are never re-proposed.
    fn is_terminal(&self) -> bool {
        matches!(
            self,
            SourceStatus::Deposited | SourceStatus::Resolved | SourceStatus::Empty
        )
    }
}

/// One source's entry: its status and the ids of any proposals deposited for it
/// (needed to map an incoming `proposal_result` back to this source).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct SourceEntry {
    status_kind: Option<SourceStatus>,
    #[serde(default)]
    proposals: Vec<String>,
}

/// Per-owner journal: sources by `att-` id.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct OwnerJournal {
    sources: BTreeMap<String, SourceEntry>,
}

/// The whole journal, keyed by owner Ed25519 hex.
#[derive(Debug, Default, Serialize, Deserialize)]
struct JournalData {
    owners: BTreeMap<String, OwnerJournal>,
}

/// The durable OCR journal. Loaded once at boot; every mutation flushes
/// atomically (write-temp-then-rename) so a crash mid-write can never corrupt it.
pub struct Journal {
    path: PathBuf,
    data: JournalData,
}

impl Journal {
    /// Load the journal from the data dir, or start empty. A corrupt file is
    /// logged and treated as empty rather than fatal — the worst case is
    /// re-propose-and-dedup, never a brick.
    pub fn load(data_dir: &Path) -> Self {
        let path = data_dir.join(JOURNAL_FILE);
        let data = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|_| {
                tracing::warn!(
                    "ocr journal at {} is unreadable; starting empty (proposals will dedup by content id)",
                    path.display()
                );
                JournalData::default()
            }),
            Err(_) => JournalData::default(),
        };
        Self { path, data }
    }

    /// Whether `source` should be OCR'd now: not terminal, and past any back-off.
    pub fn eligible(&self, owner_hex: &str, source: &str, now_secs: i64) -> bool {
        match self
            .data
            .owners
            .get(owner_hex)
            .and_then(|o| o.sources.get(source))
            .and_then(|e| e.status_kind.as_ref())
        {
            None => true, // never seen
            Some(SourceStatus::Failed { next_at, .. }) => now_secs >= *next_at,
            Some(s) => !s.is_terminal(),
        }
    }

    /// Record that proposals were deposited for `source` (ids for later
    /// resolution). Persists.
    pub fn mark_deposited(
        &mut self,
        owner_hex: &str,
        source: &str,
        msg_ids: &[String],
    ) -> Result<()> {
        let entry = self.entry(owner_hex, source);
        entry.status_kind = Some(SourceStatus::Deposited);
        for id in msg_ids {
            if !entry.proposals.contains(id) {
                entry.proposals.push(id.clone());
            }
        }
        self.flush()
    }

    /// Record that `source` extracted nothing (terminal). Persists.
    pub fn mark_empty(&mut self, owner_hex: &str, source: &str) -> Result<()> {
        self.entry(owner_hex, source).status_kind = Some(SourceStatus::Empty);
        self.flush()
    }

    /// Record a transient failure for `source`, extending its back-off. Persists.
    pub fn mark_failed(&mut self, owner_hex: &str, source: &str, now_secs: i64) -> Result<()> {
        let entry = self.entry(owner_hex, source);
        let attempts = match &entry.status_kind {
            Some(SourceStatus::Failed { attempts, .. }) => attempts + 1,
            _ => 1,
        };
        entry.status_kind = Some(SourceStatus::Failed {
            attempts,
            next_at: now_secs + backoff_secs(attempts),
        });
        self.flush()
    }

    /// Resolve the source that proposal message `msg_id` belongs to, if it is in
    /// `owner_hex`'s journal (the caller has already checked the `proposal_result`
    /// was signed by `owner_hex`). Returns whether a source was newly resolved.
    /// Idempotent: resolving an already-resolved source is a no-op.
    pub fn resolve(&mut self, owner_hex: &str, msg_id: &str) -> Result<bool> {
        let Some(owner) = self.data.owners.get_mut(owner_hex) else {
            return Ok(false);
        };
        let Some((_, entry)) = owner
            .sources
            .iter_mut()
            .find(|(_, e)| e.proposals.iter().any(|p| p == msg_id))
        else {
            return Ok(false);
        };
        if entry.status_kind == Some(SourceStatus::Resolved) {
            return Ok(false);
        }
        entry.status_kind = Some(SourceStatus::Resolved);
        self.flush()?;
        Ok(true)
    }

    /// The number of sources currently in a failure back-off across all owners —
    /// the "still waiting" gauge the job status reports as `queued`.
    pub fn awaiting_retry(&self) -> usize {
        self.data
            .owners
            .values()
            .flat_map(|o| o.sources.values())
            .filter(|e| matches!(e.status_kind, Some(SourceStatus::Failed { .. })))
            .count()
    }

    fn entry(&mut self, owner_hex: &str, source: &str) -> &mut SourceEntry {
        self.data
            .owners
            .entry(owner_hex.to_string())
            .or_default()
            .sources
            .entry(source.to_string())
            .or_default()
    }

    /// Atomic flush: write a sibling temp file, then rename over the journal, so a
    /// crash leaves either the old file or the new one, never a partial write.
    fn flush(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create journal dir {}", parent.display()))?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(&self.data).context("serialize ocr journal")?;
        {
            let mut f =
                std::fs::File::create(&tmp).with_context(|| format!("create {}", tmp.display()))?;
            f.write_all(&bytes)
                .with_context(|| format!("write {}", tmp.display()))?;
            f.sync_all().ok();
        }
        std::fs::rename(&tmp, &self.path)
            .with_context(|| format!("rename {} -> {}", tmp.display(), self.path.display()))
    }
}

/// Exponential back-off in seconds for the given attempt count, capped.
fn backoff_secs(attempts: u32) -> i64 {
    let shifted = BACKOFF_BASE_SECS.checked_shl(attempts.saturating_sub(1));
    shifted.unwrap_or(BACKOFF_CAP_SECS).min(BACKOFF_CAP_SECS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn journal() -> (tempfile::TempDir, Journal) {
        let dir = tempfile::tempdir().unwrap();
        let j = Journal::load(dir.path());
        (dir, j)
    }

    #[test]
    fn unseen_source_is_eligible_deposited_is_not() {
        let (_d, mut j) = journal();
        assert!(j.eligible("owner", "att-a", 0));
        j.mark_deposited("owner", "att-a", &["m1".into()]).unwrap();
        assert!(!j.eligible("owner", "att-a", 0), "deposited is terminal");
    }

    #[test]
    fn empty_is_terminal() {
        let (_d, mut j) = journal();
        j.mark_empty("owner", "att-a").unwrap();
        assert!(!j.eligible("owner", "att-a", 1_000_000_000));
    }

    #[test]
    fn failed_respects_backoff_then_retries() {
        let (_d, mut j) = journal();
        j.mark_failed("owner", "att-a", 1000).unwrap();
        // Within the 60s first back-off: not eligible.
        assert!(!j.eligible("owner", "att-a", 1030));
        // After it: eligible again.
        assert!(j.eligible("owner", "att-a", 1000 + 60));
        // A second failure backs off further (120s).
        j.mark_failed("owner", "att-a", 1100).unwrap();
        assert!(!j.eligible("owner", "att-a", 1100 + 60));
        assert!(j.eligible("owner", "att-a", 1100 + 120));
        assert_eq!(j.awaiting_retry(), 1);
    }

    #[test]
    fn resolve_maps_proposal_back_to_source() {
        let (_d, mut j) = journal();
        j.mark_deposited("owner", "att-a", &["m1".into(), "m2".into()])
            .unwrap();
        // A result for a proposal we don't know: no resolution.
        assert!(!j.resolve("owner", "unknown").unwrap());
        // A result for m2 resolves the source; a rejected source stays terminal.
        assert!(j.resolve("owner", "m2").unwrap());
        assert!(!j.eligible("owner", "att-a", 0), "resolved is terminal");
        // Idempotent.
        assert!(!j.resolve("owner", "m1").unwrap());
    }

    #[test]
    fn resolution_is_scoped_to_the_owner() {
        let (_d, mut j) = journal();
        j.mark_deposited("owner-a", "att-a", &["m1".into()])
            .unwrap();
        // A result claiming owner-b cannot resolve owner-a's source.
        assert!(!j.resolve("owner-b", "m1").unwrap());
        assert!(
            !j.eligible("owner-a", "att-a", 0),
            "still deposited, untouched"
        );
    }

    #[test]
    fn survives_a_reload() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut j = Journal::load(dir.path());
            j.mark_deposited("owner", "att-a", &["m1".into()]).unwrap();
        }
        // A fresh load (a simulated restart) sees the deposited source.
        let j = Journal::load(dir.path());
        assert!(!j.eligible("owner", "att-a", 0));
    }

    #[test]
    fn backoff_is_capped() {
        assert_eq!(backoff_secs(1), 60);
        assert_eq!(backoff_secs(2), 120);
        assert_eq!(
            backoff_secs(100),
            BACKOFF_CAP_SECS,
            "huge attempt count caps"
        );
    }
}
