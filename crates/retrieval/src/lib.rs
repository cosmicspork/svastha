//! Retrieval for cited Q&A: rank a vault's events against a question, render the
//! top matches into the context a model reads, and ground the model's answer back
//! to the event ids it was actually given.
//!
//! Native and WASM both build this, so the processing node and the browser run
//! one ranker and one **citation contract** rather than two that can drift.
//!
//! ## Where tenancy isolation lives
//!
//! [`rank`] scores exactly the [`Candidate`]s it is handed and nothing else, and
//! [`ground`] can only return ids drawn from the [`ContextItem`]s it is handed.
//! So a citation is always an id the caller supplied — but *which* vault those
//! candidates came from is the caller's guarantee to make, not this crate's. The
//! node keeps that guarantee structurally by building candidates from a single
//! owner's `VaultIndex`; a caller that pooled two owners' events into one slice
//! would defeat it, and no signature here would stop them.
//!
//! ## Honest, personal-scale retrieval
//!
//! No embeddings, no vector store — the vaults are personal-scale, so keyword
//! overlap plus light recency and kind/intent signals is enough and keeps the
//! whole thing auditable.
//!
//! ## Curation-aware, but resolution is the caller's
//!
//! A [`Candidate`] arrives with its display `name` and its curated `status`
//! already resolved. That split is deliberate: the browser resolves a name
//! through an offline terminology dictionary the node does not carry, so the
//! same code here would produce worse context on one client than the other if it
//! owned resolution. Status still shapes both the rendering (`[current]`/`[past]`)
//! and the ranking — a "what am I *currently* taking" question demotes resolved
//! concepts, and a "what did I *used to*..." question demotes active ones.
//!
//! ## Scope is decided before ranking, not after
//!
//! [`AnswerScope`] says which of the owner's entries a candidate list may be
//! built from at all. Cycle and mind entries are excluded unless the owner opted
//! that category in, and the filter runs *before* [`rank`] — a scored-then-
//! dropped item has already been shaped into a prompt, and an excluded entry
//! must never influence what an endpoint is told. See [`scope`].

mod prompt;
mod rank;
mod scope;

pub use prompt::{build_prompt, ground, CANT_ANSWER, SYSTEM_PROMPT};
pub use rank::{rank, render_line};
pub use scope::{sensitive_category, AnswerScope, SensitiveCategory};

use serde::{Deserialize, Serialize};
use svastha_core::event::Event;

/// A concept's current/past status. Defaults to [`Active`](ConceptStatus::Active)
/// when the owner has recorded no `status:` override (a medication with no
/// override is current, a problem is active).
///
/// Serializes as `"active"`/`"inactive"` — the same two strings the web's
/// `curation.ts` `ConceptStatus` uses, so a candidate assembled in the browser
/// crosses into WASM without a translation layer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConceptStatus {
    Active,
    Inactive,
}

/// One event offered to the ranker, with the two things this crate deliberately
/// does not resolve itself: the display `name` the owner would see, and the
/// curated `status` of the concept it folds into.
#[derive(Clone, Debug)]
pub struct Candidate<'a> {
    pub event: &'a Event,
    pub name: String,
    pub status: ConceptStatus,
}

/// One retrieved, rendered context item. `event_id` is the citation the answer
/// carries; `text` is what the model reads.
///
/// Serializable so a client can rank in WASM, carry the result out to make the
/// inference call itself, and hand the same items back to [`ground`] — which is
/// what keeps citations a subset of what was actually supplied.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ContextItem {
    /// The event content id (hex) — the citation.
    pub event_id: String,
    /// The curation-aware rendering the model sees as context.
    pub text: String,
    /// The relevance score (higher is better); exposed for tests/logging.
    pub score: f32,
}
