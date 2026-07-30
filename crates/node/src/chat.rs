//! Cited Q&A over the decrypted log (design §7): the node-side half of the PWA's
//! ask screen. A `chat_msg` question arrives in the node's mailbox; the node
//! retrieves over **that owner's** vault, asks the inference endpoint to answer
//! from the retrieved context, grounds the answer back to the event ids it drew
//! from, and deposits a `chat_msg` answer to the owner's mailbox. **Read-only** —
//! no proposal loop, no writes.
//!
//! ## The two rules that make this trustworthy
//!
//! - **Sender gate.** A question is accepted only when the envelope verifies, the
//!   relay's `svastha-from` attestation matches the signed `from`, **and** that
//!   sender is an owner the node is enrolled with. Anything else is dropped and
//!   counted — mailbox deposits are open to any authenticated identity, so a
//!   validly-signed question from a stranger must not be answered from someone's
//!   vault. This mirrors the web's posture exactly.
//! - **Grounding.** An answer is sent only when it cites at least one event id
//!   actually supplied to the model as context. If nothing retrieves, or the model
//!   returns malformed output or cites nothing usable, the node replies **honestly
//!   that it couldn't answer** rather than forwarding uncited prose. Every citation
//!   is a subset of the supplied context ids by construction (they come from the
//!   context list itself), so an answer can never cite an event the model invented.
//!
//! **Tenancy isolation is structural:** retrieval is handed exactly one owner's
//! [`VaultIndex`](crate::index::VaultIndex) (see [`crate::retrieval`]), so a
//! question from owner A can only ever be answered from — and cite — A's vault.
//!
//! **Scoped to what the owner opted in:** the sender's own
//! [`AnswerScopeControl`] choice narrows that index further before ranking, so
//! cycle and mind entries reach the endpoint only where the owner said they may
//! (see [`crate::answer_scope`]).
//!
//! **Content-free logs.** Never the question, the answer, the context, or any
//! record content — only counts, message ids, and short owner-key prefixes.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use svastha_core::mailbox::{
    parse_mailbox_item, ChatMsgBody, ChatRole, MailboxItem, MailboxMessage, MessageKind,
};
use x25519_dalek::PublicKey;

use crate::answer_scope::AnswerScopeControl;
use crate::client::RelayClient;
use crate::inference::{InferenceClient, InferenceRuntime};
use crate::journal::Journal;
use crate::retrieval::{self, ContextItem};
use crate::state::NodeState;
use svastha_retrieval::{build_prompt, ground, CANT_ANSWER, SYSTEM_PROMPT};

/// How many retrieved context items to feed the model. Personal-scale vaults and a
/// synchronous endpoint — a dozen well-ranked items is plenty and keeps the prompt
/// small.
const MAX_CONTEXT: usize = 12;

/// What one chat pass did. Counts and the granted flag only — never content.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ChatReport {
    /// Grounded answers (≥ 1 citation) deposited to an owner.
    pub answered: u64,
    /// Honest "couldn't answer" replies deposited (nothing grounded).
    pub cant_answer: u64,
    /// Questions left for a later pass because the endpoint was unreachable (not
    /// permanently answered — a transient failure retries, unlike an ungroundable
    /// answer which terminally replies).
    pub deferred: u64,
    /// Dropped by the sender gate (bad envelope, attestation mismatch, non-enrolled
    /// sender, or a body that would not open/parse).
    pub dropped: u64,
    /// A verified chat turn that is not an owner question (e.g. an answer echoed
    /// back): tolerated and left alone.
    pub ignored: u64,
    /// Questions from owners with no usable inference endpoint of their own and
    /// no operator default to fall back on. Left in the mailbox, like a deferred
    /// one — the endpoint may yet be set (see [`crate::inference`]).
    pub no_endpoint: u64,
}

/// Run one chat pass: drain the node's mailbox for `chat_msg` questions and answer
/// each, **each against the asker's own endpoint** (their own if they set one,
/// else the operator's default — see [`crate::inference`]). A question the node
/// cannot yet answer, because that owner has no endpoint at all, waits in the
/// mailbox rather than getting a fake reply, mirroring the web's honest waiting
/// state.
pub fn run(
    client: &RelayClient,
    state: &Mutex<NodeState>,
    inference: &InferenceRuntime,
    scopes: &AnswerScopeControl,
    journal: &mut Journal,
) -> Result<ChatReport> {
    let mut report = ChatReport::default();
    let node = client.identity();

    for entry in client.list_mailbox()? {
        let Some((bytes, from_relay)) = client.get_mailbox(&entry.id)? else {
            continue; // deleted between listing and fetch
        };
        let Ok(MailboxItem::Message(msg)) = parse_mailbox_item(&bytes) else {
            continue; // legacy/other item kinds are not ours
        };
        if msg.kind != MessageKind::ChatMsg {
            continue;
        }
        let msg_id = msg.id_hex();

        // Already answered on an earlier pass (or before a restart): clean up the
        // now-stale question and move on. Never re-answer.
        if journal.request_handled(&msg_id) {
            let _ = client.delete_mailbox(&entry.id);
            continue;
        }

        // Sender gate, part 1: verify-or-drop, then bind the relay attestation.
        if !msg.verify() || msg.from_hex() != from_relay {
            report.dropped += 1;
            continue;
        }
        let owner_hex = msg.from_hex();

        // Open the body (verify already passed) and require a question turn.
        let Ok(plain) = msg.open(node) else {
            report.dropped += 1;
            continue;
        };
        let Ok(body) = serde_json::from_slice::<ChatMsgBody>(&plain) else {
            report.dropped += 1;
            continue;
        };
        if body.role != ChatRole::Question {
            report.ignored += 1;
            continue;
        }

        // Sender gate, part 2 + single-tenant retrieval, under the state lock: the
        // sender must be an enrolled owner, and retrieval reads ONLY that owner's
        // index. `retrieve` is handed one `VaultIndex`, so cross-tenant leakage is
        // impossible by construction, not by discipline.
        // The sender's own opt-in choice (answer_scope.rs) is resolved here, from
        // the same identity the gate just checked — so the scope a question is
        // answered under is always the asker's, never a node-wide setting.
        let scope = scopes.scope(&owner_hex);
        let prepared = {
            let guard = state.lock().expect("node state mutex");
            guard.owner(&owner_hex).map(|os| {
                (
                    os.owner_x25519,
                    retrieval::retrieve(&os.index, &scope, &body.text, MAX_CONTEXT),
                )
            })
        };
        let Some((owner_x25519, context)) = prepared else {
            // Validly signed, but not an owner the node serves: drop and count.
            report.dropped += 1;
            continue;
        };

        // The asker's own endpoint, resolved from the same identity the gate just
        // checked — never another owner's, and never a node-wide setting.
        let Some(inference) = inference.chat_client(&owner_hex) else {
            report.no_endpoint += 1;
            tracing::info!(
                owner = short(&owner_hex),
                "no inference endpoint for this owner; leaving the question unanswered"
            );
            continue;
        };

        // Produce the answer off the lock (inference I/O), then deposit it.
        match build_answer(inference, &body.text, &context) {
            Outcome::Defer => {
                report.deferred += 1;
                tracing::warn!(
                    owner = short(&owner_hex),
                    model = inference.model(),
                    "chat inference unreachable; leaving the question to retry"
                );
            }
            Outcome::Reply { text, citations } => {
                let grounded = !citations.is_empty();
                let reply = ChatMsgBody {
                    role: ChatRole::Answer,
                    text,
                    citations,
                };
                match deposit_reply(client, node, &owner_hex, owner_x25519, &reply) {
                    Ok(()) => {
                        journal.mark_request_handled(&msg_id)?;
                        let _ = client.delete_mailbox(&entry.id);
                        if grounded {
                            report.answered += 1;
                        } else {
                            report.cant_answer += 1;
                        }
                    }
                    Err(e) => {
                        // Relay deposit failed: do not mark handled — retry next
                        // pass so the owner still gets an answer.
                        report.deferred += 1;
                        tracing::warn!(owner = short(&owner_hex), error = %e, "chat reply deposit failed; will retry");
                    }
                }
            }
        }
    }
    Ok(report)
}

/// What to do with a question: reply (grounded or honestly can't-answer), or defer
/// to a later pass because inference was unreachable.
enum Outcome {
    Reply {
        text: String,
        citations: Vec<String>,
    },
    Defer,
}

/// Ground an answer for `question` against the retrieved `context`. Empty context
/// short-circuits to an honest can't-answer without an inference call. A reachable
/// endpoint that returns malformed output or no usable citation also yields the
/// honest can't-answer (never uncited prose); only an *unreachable* endpoint
/// defers.
fn build_answer(inference: &InferenceClient, question: &str, context: &[ContextItem]) -> Outcome {
    if context.is_empty() {
        return Outcome::Reply {
            text: CANT_ANSWER.to_string(),
            citations: Vec::new(),
        };
    }
    match inference.answer(SYSTEM_PROMPT, &build_prompt(question, context)) {
        Ok(raw) => match ground(&raw, context) {
            Some((answer, citations)) if !citations.is_empty() => Outcome::Reply {
                text: answer,
                citations,
            },
            // Reachable but ungroundable → honest can't-answer, not the prose.
            _ => Outcome::Reply {
                text: CANT_ANSWER.to_string(),
                citations: Vec::new(),
            },
        },
        Err(_) => Outcome::Defer,
    }
}

/// Seal a `chat_msg` answer to the owner's X25519 key and deposit it into the
/// owner's mailbox. The item id keys on the reply envelope's own message id.
fn deposit_reply(
    client: &RelayClient,
    node: &svastha_core::keys::Identity,
    owner_hex: &str,
    owner_x25519: [u8; 32],
    reply: &ChatMsgBody,
) -> Result<()> {
    let recipient = PublicKey::from(owner_x25519);
    let plaintext = serde_json::to_vec(reply)?;
    let envelope =
        MailboxMessage::seal(node, &recipient, MessageKind::ChatMsg, now_ms(), &plaintext);
    let item_id = format!("chat-{}", envelope.id_hex());
    let bytes = serde_json::to_vec(&envelope)?;
    client.put_mailbox(owner_hex, &item_id, &bytes)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// A log-safe short form of an owner id (a public key hex, not PHI).
fn short(owner_hex: &str) -> String {
    owner_hex.chars().take(12).collect()
}
