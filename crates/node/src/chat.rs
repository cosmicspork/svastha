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
//! **Content-free logs.** Never the question, the answer, the context, or any
//! record content — only counts, message ids, and short owner-key prefixes.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use serde::Deserialize;
use svastha_core::mailbox::{
    parse_mailbox_item, ChatMsgBody, ChatRole, MailboxItem, MailboxMessage, MessageKind,
};
use x25519_dalek::PublicKey;

use crate::client::RelayClient;
use crate::inference::InferenceClient;
use crate::journal::Journal;
use crate::retrieval::{self, ContextItem};
use crate::state::NodeState;

/// How many retrieved context items to feed the model. Personal-scale vaults and a
/// synchronous endpoint — a dozen well-ranked items is plenty and keeps the prompt
/// small.
const MAX_CONTEXT: usize = 12;

/// The honest reply text when the node cannot ground an answer (nothing retrieved,
/// or the model produced no usable citation). Sent with **empty** citations.
const CANT_ANSWER: &str = "I couldn't find anything in your record to answer that with a citation.";

/// System instruction: answer strictly from the numbered context, cite what you
/// used, and refuse rather than invent. Not a diagnostician.
const SYSTEM_PROMPT: &str = "\
You answer a person's questions using ONLY their own medical records, provided as \
a numbered context list. Draw every statement from that context and cite the item \
numbers you used. Do not diagnose, predict, infer, or add anything not present in \
the context. If the context does not contain the answer, say so plainly. Respond \
with a single JSON object and nothing else.";

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
}

/// Run one chat pass: drain the node's mailbox for `chat_msg` questions and answer
/// each. Called only when an inference client exists — a question the node cannot
/// yet answer (no endpoint) waits in the mailbox rather than getting a fake reply,
/// mirroring the web's honest waiting state.
pub fn run(
    client: &RelayClient,
    state: &Mutex<NodeState>,
    inference: &InferenceClient,
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
        let prepared = {
            let guard = state.lock().expect("node state mutex");
            guard.owner(&owner_hex).map(|os| {
                (
                    os.owner_x25519,
                    retrieval::retrieve(&os.index, &body.text, MAX_CONTEXT),
                )
            })
        };
        let Some((owner_x25519, context)) = prepared else {
            // Validly signed, but not an owner the node serves: drop and count.
            report.dropped += 1;
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

/// The user prompt: the question and the numbered context, plus the exact output
/// schema. Numbering is 1-based and maps back to `context` positions in [`ground`].
fn build_prompt(question: &str, context: &[ContextItem]) -> String {
    let mut s = String::new();
    s.push_str("Question: ");
    s.push_str(question.trim());
    s.push_str("\n\nContext (numbered records from the person's own vault):\n");
    for (i, item) in context.iter().enumerate() {
        s.push_str(&format!("[{}] {}\n", i + 1, item.text));
    }
    s.push_str(
        "\nRespond with JSON of the form:\n\
         {\"answer\": \"<a plain-language answer drawn only from the context>\", \
         \"used\": [<the item numbers you drew from>]}\n\
         If the context does not answer the question, respond {\"answer\": \"\", \"used\": []}.",
    );
    s
}

/// The model's expected reply: a plain answer plus the 1-based context item
/// numbers it used. Tolerant (defaults, unknown fields ignored).
#[derive(Debug, Default, Deserialize)]
struct ModelAnswer {
    #[serde(default)]
    answer: String,
    #[serde(default)]
    used: Vec<u32>,
}

/// Map a model answer back to grounded citations. Returns `(answer, citation_ids)`
/// where each id is the content id of a **supplied** context item (defensive: a
/// number out of range is dropped, duplicates collapse, order preserved). `None`
/// when the output is unparseable or the answer text is empty. The caller still
/// requires the citation list to be non-empty before sending.
fn ground(raw: &str, context: &[ContextItem]) -> Option<(String, Vec<String>)> {
    let parsed = parse_json_object::<ModelAnswer>(raw)?;
    let answer = parsed.answer.trim();
    if answer.is_empty() {
        return None;
    }
    let mut citations: Vec<String> = Vec::new();
    for n in parsed.used {
        // 1-based → 0-based; ignore anything outside the supplied context.
        let Some(idx) = (n as usize).checked_sub(1) else {
            continue;
        };
        if let Some(item) = context.get(idx) {
            if !citations.contains(&item.event_id) {
                citations.push(item.event_id.clone());
            }
        }
    }
    Some((answer.to_string(), citations))
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

/// Parse a JSON object out of a model answer, tolerating fenced/prose-wrapped
/// output the same way [`crate::extract`] does: a clean parse first, then the
/// substring from the first `{` to the last `}`.
fn parse_json_object<T: for<'de> Deserialize<'de>>(answer: &str) -> Option<T> {
    if let Ok(v) = serde_json::from_str::<T>(answer.trim()) {
        return Some(v);
    }
    let start = answer.find('{')?;
    let end = answer.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str::<T>(&answer[start..=end]).ok()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(ids: &[&str]) -> Vec<ContextItem> {
        ids.iter()
            .enumerate()
            .map(|(i, id)| ContextItem {
                event_id: id.to_string(),
                text: format!("item {i}"),
                score: 1.0,
            })
            .collect()
    }

    #[test]
    fn ground_maps_used_numbers_to_context_ids() {
        let context = ctx(&["aaa", "bbb", "ccc"]);
        let raw = r#"{"answer":"You take aaa and ccc.","used":[1,3]}"#;
        let (answer, cites) = ground(raw, &context).unwrap();
        assert_eq!(answer, "You take aaa and ccc.");
        assert_eq!(cites, vec!["aaa", "ccc"]);
    }

    #[test]
    fn ground_drops_out_of_range_and_dedupes() {
        let context = ctx(&["aaa", "bbb"]);
        // 9 is out of range; 1 repeats.
        let raw = r#"{"answer":"a","used":[1,1,9,0]}"#;
        let (_a, cites) = ground(raw, &context).unwrap();
        assert_eq!(
            cites,
            vec!["aaa"],
            "out-of-range/zero dropped, dupes collapsed"
        );
    }

    #[test]
    fn ground_rejects_empty_answer_and_garbage() {
        let context = ctx(&["aaa"]);
        assert!(ground(r#"{"answer":"","used":[1]}"#, &context).is_none());
        assert!(ground("I cannot read this", &context).is_none());
    }

    #[test]
    fn ground_tolerates_prose_wrapped_json() {
        let context = ctx(&["aaa", "bbb"]);
        let raw = "Sure!\n```json\n{\"answer\":\"ok\",\"used\":[2]}\n```\n";
        let (answer, cites) = ground(raw, &context).unwrap();
        assert_eq!(answer, "ok");
        assert_eq!(cites, vec!["bbb"]);
    }

    #[test]
    fn citations_are_always_a_subset_of_supplied_context() {
        // The model "cites" a number that is not in the two-item context; ground
        // yields no citation for it, so an answer citing only invented items is
        // reported with empty citations (the caller then sends can't-answer).
        let context = ctx(&["aaa", "bbb"]);
        let (_a, cites) = ground(r#"{"answer":"x","used":[5,6]}"#, &context).unwrap();
        assert!(cites.is_empty(), "no invented id can become a citation");
    }
}
