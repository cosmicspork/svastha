//! Node administration over the mailbox (design §2, §9): an owner administers the
//! node's work on **their own** vault with `admin_cmd` envelopes, and the node
//! replies `admin_reply`. The commands match the PWA's admin surface:
//! `job_status`, `log_tail`, `set_inference_endpoint`, `pause_ocr`/`resume_ocr`,
//! and `set_answer_scope`.
//!
//! ## The admin trust rule (design §2)
//!
//! Commands are accepted only from an identity the node is **enrolled with** — an
//! owner who granted the node and handed off keys — verified exactly like a chat
//! question (envelope verify + relay attestation + enrolled-owner check). You
//! administer the node's processing of your vault, not the node itself: **node-
//! process operations** (restart, upgrade, choosing whether the node runs at all)
//! are the **host operator's**, not commands — there is deliberately no envelope
//! that can restart the process.
//!
//! ### What is per-owner and what is not
//!
//! Authorization is per owner; *effect* is only where the code says so, and
//! saying otherwise in a trust document would be a lie a reader could not check:
//!
//! - `pause_ocr` / `resume_ocr` — **per owner.** The choice is keyed by the
//!   sender and persisted per owner (see [`crate::ocr_control`]); pausing stops
//!   the node reading your pages and nobody else's.
//! - `set_inference_endpoint` — **node-wide.** One [`InferenceRuntime`] serves
//!   every enrolled owner, so on a multi-owner node any owner can repoint it for
//!   all of them. It carries a config URL, never record content, and the boot
//!   validation still applies — but it is a shared control, not a private one.
//! - `log_tail` — **node-wide**, and `job_status` is mixed: this owner's index
//!   sizes and reading state alongside the node's OCR counters.
//!
//! A deployment that cannot accept those shared surfaces enrols one owner per
//! node. Making inference per-owner is a real design change (per-owner runtimes,
//! per-owner persistence), not a wording fix, and is deliberately not smuggled in
//! behind one.
//!
//! ## Content-free throughout
//!
//! `job_status` and `log_tail` return only counts, ids, timestamps, and the node's
//! own already-content-free log lines (see [`crate::logtail`]). `set_inference_endpoint`
//! carries a config URL and `set_answer_scope` carries category *names*, never
//! record content. Nothing here logs or returns PHI.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use svastha_core::mailbox::{
    parse_mailbox_item, AdminCmdBody, AdminCommand, AdminReplyBody, MailboxItem, MailboxMessage,
    MessageKind,
};
use x25519_dalek::PublicKey;

use crate::answer_scope::AnswerScopeControl;
use crate::client::RelayClient;
use crate::inference::InferenceRuntime;
use crate::journal::Journal;
use crate::logtail::{LogBuffer, CAPACITY};
use crate::ocr_control::OcrControl;
use crate::state::NodeState;

/// Default number of log lines a `log_tail` returns when the command names none.
const DEFAULT_LOG_LINES: usize = 40;

/// How one `set_answer_scope` is ordered against another from the same owner:
/// the sender's signed `sent_at`, with the envelope id breaking a tie so the
/// order is total and identical on every node that sees the same two commands.
///
/// The id tiebreak is arbitrary but deterministic — two commands stamped the
/// same millisecond have no real order, and picking one consistently is better
/// than letting mailbox iteration decide.
type ScopeStamp = (i64, String);

/// Whether `candidate` is a later instruction than `best` (if any) — the rule
/// [`run`] folds over an owner's scope commands to pick the pass's winner. See
/// [`ScopeStamp`].
fn supersedes(candidate: &ScopeStamp, best: Option<&ScopeStamp>) -> bool {
    match best {
        None => true,
        Some(best) => candidate > best,
    }
}

/// Byte budget for a reply `detail` so the sealed `admin_reply` stays under the
/// relay's 4 KiB mailbox-item cap (the envelope hex-encodes the sealed body, ≈ 2×,
/// plus fixed fields). A long `log_tail` keeps only its most recent lines that fit.
const DETAIL_BUDGET: usize = 1500;

/// What one admin pass did. Counts only — never command or reply content.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct AdminReport {
    /// Replies deposited (whether `ok: true` or `ok: false` — a rejected command
    /// is still answered honestly).
    pub replied: u64,
    /// Left for a later pass because the reply deposit failed (transient relay).
    pub deferred: u64,
    /// Dropped by the sender gate (bad envelope, attestation mismatch, non-enrolled
    /// sender, or a body that would not open/parse).
    pub dropped: u64,
}

/// Run one admin pass: drain the node's mailbox for `admin_cmd`s and answer each.
/// Runs on every reconcile regardless of whether inference is configured — that is
/// how `set_inference_endpoint` can enable inference on a node booted without it.
pub fn run(
    client: &RelayClient,
    state: &Mutex<NodeState>,
    inference: &mut InferenceRuntime,
    control: &mut OcrControl,
    scopes: &mut AnswerScopeControl,
    logs: &LogBuffer,
    journal: &mut Journal,
) -> Result<AdminReport> {
    let mut report = AdminReport::default();
    let node = client.identity();

    // ## Why this pass is in two phases
    //
    // The mailbox hands items over in no particular order (the relay lists from a
    // map), so two `set_answer_scope` instructions sent seconds apart can arrive
    // reversed. Applying them as they come lands the node on the stale one
    // whenever that happens.
    //
    // A guard that skips an out-of-order command is not enough, and the way it
    // fails is worth stating: when the older one happens to arrive *first* it is
    // genuinely applied — and answered `ok: true` — and then overwritten by the
    // newer one later in the same pass. Its sender is told its scope is in force
    // when, moments later, it is not. `ok` means applied, so the only way for
    // every reply in the pass to be true is to decide the winner **before**
    // answering anyone.
    //
    // So: phase one gathers and vets, phase two applies and replies. Only
    // `set_answer_scope` is ordered this way — it is the one whose stale
    // application keeps disclosing silently.
    let mut gathered: Vec<Gathered> = Vec::new();
    let mut winners: BTreeMap<String, ScopeStamp> = BTreeMap::new();

    for entry in client.list_mailbox()? {
        let Some((bytes, from_relay)) = client.get_mailbox(&entry.id)? else {
            continue;
        };
        let Ok(MailboxItem::Message(msg)) = parse_mailbox_item(&bytes) else {
            continue;
        };
        if msg.kind != MessageKind::AdminCmd {
            continue;
        }
        let msg_id = msg.id_hex();

        if journal.request_handled(&msg_id) {
            let _ = client.delete_mailbox(&entry.id);
            continue;
        }

        // Sender gate: verify-or-drop, bind the relay attestation.
        if !msg.verify() || msg.from_hex() != from_relay {
            report.dropped += 1;
            continue;
        }
        let owner_hex = msg.from_hex();

        // The sender must be an enrolled owner (design §2). Capture the seal target
        // while we hold the lock.
        let owner_x25519 = {
            let guard = state.lock().expect("node state mutex");
            guard.owner(&owner_hex).map(|os| os.owner_x25519)
        };
        let Some(owner_x25519) = owner_x25519 else {
            report.dropped += 1;
            continue;
        };

        let Ok(plain) = msg.open(node) else {
            report.dropped += 1;
            continue;
        };
        let Ok(body) = serde_json::from_slice::<AdminCmdBody>(&plain) else {
            report.dropped += 1;
            continue;
        };

        let stamp: ScopeStamp = (msg.sent_at, msg_id.clone());
        if matches!(body.command, AdminCommand::SetAnswerScope { .. })
            && supersedes(&stamp, winners.get(&owner_hex))
        {
            winners.insert(owner_hex.clone(), stamp.clone());
        }

        gathered.push(Gathered {
            entry_id: entry.id,
            msg_id,
            owner_hex,
            owner_x25519,
            stamp,
            command: body.command,
        });
    }

    // Phase two, first the winners. Applying them before anything is answered is
    // what lets every reply below describe the scope the pass actually settled
    // on — a superseded command's reply names the scope that beat it, and a
    // `job_status` in the same pass reports the same thing. Answering in arrival
    // order would let a reply quote a scope that was true only mid-pass.
    let mut settled: BTreeMap<String, (bool, String)> = BTreeMap::new();
    for item in &gathered {
        let is_winner = matches!(item.command, AdminCommand::SetAnswerScope { .. })
            && winners.get(&item.owner_hex) == Some(&item.stamp);
        if !is_winner {
            continue;
        }
        let outcome = execute(
            &item.command,
            state,
            inference,
            control,
            scopes,
            logs,
            &item.owner_hex,
            false,
        );
        settled.insert(item.msg_id.clone(), outcome);
    }

    // Then answer everyone, winners included (their outcome is already decided).
    for item in gathered {
        let (ok, detail) = match settled.remove(&item.msg_id) {
            Some(outcome) => outcome,
            None => {
                let superseded = matches!(item.command, AdminCommand::SetAnswerScope { .. });
                execute(
                    &item.command,
                    state,
                    inference,
                    control,
                    scopes,
                    logs,
                    &item.owner_hex,
                    superseded,
                )
            }
        };
        let reply = AdminReplyBody {
            in_reply_to: item.msg_id.clone(),
            ok,
            detail: Some(detail),
        };
        match deposit_reply(client, node, &item.owner_hex, item.owner_x25519, &reply) {
            Ok(()) => {
                journal.mark_request_handled(&item.msg_id)?;
                let _ = client.delete_mailbox(&item.entry_id);
                report.replied += 1;
                tracing::info!(owner = short(&item.owner_hex), ok, "admin command answered");
            }
            Err(e) => {
                report.deferred += 1;
                tracing::warn!(owner = short(&item.owner_hex), error = %e, "admin reply deposit failed; will retry");
            }
        }
    }
    Ok(report)
}

/// One vetted command, held between the pass's two phases. Carries only what
/// phase two needs; the envelope itself is not kept.
struct Gathered {
    entry_id: String,
    msg_id: String,
    owner_hex: String,
    owner_x25519: [u8; 32],
    stamp: ScopeStamp,
    command: AdminCommand,
}

/// Execute one command, returning `(ok, detail)`. Never fails the pass — a bad
/// value answers `ok: false` with the reason, so the owner sees it in the app.
#[allow(clippy::too_many_arguments)]
fn execute(
    command: &AdminCommand,
    state: &Mutex<NodeState>,
    inference: &mut InferenceRuntime,
    control: &mut OcrControl,
    scopes: &mut AnswerScopeControl,
    logs: &LogBuffer,
    owner_hex: &str,
    // Set only for a `set_answer_scope` that is not this owner's latest in the
    // pass. Decided by the caller, which is the only place that can see all of
    // them (see `run`).
    superseded: bool,
) -> (bool, String) {
    match command {
        AdminCommand::JobStatus => (
            true,
            job_status_detail(state, inference, control, scopes, owner_hex),
        ),
        AdminCommand::LogTail { lines } => {
            let want = lines
                .map(|n| n as usize)
                .unwrap_or(DEFAULT_LOG_LINES)
                .min(CAPACITY);
            (true, log_tail_detail(logs, want))
        }
        // Reading is the one node behaviour an owner can start and stop, because
        // it is the one that writes into their approval queue — and it stops for
        // the sender's vault alone (unlike the endpoint below, which is shared;
        // see the module doc).
        AdminCommand::PauseOcr => match control.set_paused(owner_hex, true) {
            Ok(detail) => (true, detail),
            Err(msg) => (false, msg),
        },
        AdminCommand::ResumeOcr => match control.set_paused(owner_hex, false) {
            Ok(detail) => (true, detail),
            Err(msg) => (false, msg),
        },
        // The one command that changes what leaves the node. It is owner-scoped
        // for the same reason pausing is, and for one more: an opt-in to your own
        // cycle or mind entries is not a choice anyone else can make for you.
        AdminCommand::SetAnswerScope { include } => {
            if superseded {
                // Understood, and deliberately **not applied** — a later
                // instruction from this owner is in force, and applying this one
                // would undo it.
                //
                // `ok: false`, because on this wire `ok` means applied. Answering
                // `true` for a command the node declined to act on is the one
                // thing a second device cannot detect: it would read its own
                // reply as "the node is doing what I asked" while the node was
                // enforcing the other device's choice. The marker then says what
                // *is* in force, so the device can see the difference rather than
                // take the boolean's word for it.
                let scope = scopes.scope(owner_hex);
                return (
                    false,
                    format!(
                        "a later instruction of yours is in force, so this one was not applied; {} {}",
                        scope.describe(),
                        scope.marker()
                    ),
                );
            }
            match scopes.set_scope(owner_hex, include) {
                Ok(detail) => {
                    // Applied — and it still states the resulting scope, so a
                    // client confirms on an exact match rather than on `ok`
                    // alone. One rule for every reply.
                    (
                        true,
                        format!("{detail} {}", scopes.scope(owner_hex).marker()),
                    )
                }
                Err(msg) => (false, msg),
            }
        }
        // A command from a newer app than this node. Answered, not ignored: the
        // owner needs to be able to tell "this node will not do that" from "this
        // node never heard me", and only a reply can do that. Nothing is guessed
        // at and nothing is changed.
        AdminCommand::Unknown => (
            false,
            "this node does not know that command, so nothing was done. It is probably older \
             than the app that sent it — update the node"
                .to_string(),
        ),
        AdminCommand::SetInferenceEndpoint { endpoint } => match inference.set_endpoint(endpoint) {
            // Still subject to the boot-time config validation (synchronous,
            // non-batch); a rejected value answers ok:false with the message.
            Ok(detail) => (true, detail),
            Err(msg) => (false, msg),
        },
    }
}

/// A content-free job-status line: this owner's index sizes and *their own*
/// reading state, the node's OCR counters, whether inference is configured, and
/// the last reconcile time (Unix seconds). Counts and a timestamp only.
fn job_status_detail(
    state: &Mutex<NodeState>,
    inference: &InferenceRuntime,
    control: &OcrControl,
    scopes: &AnswerScopeControl,
    owner_hex: &str,
) -> String {
    let guard = state.lock().expect("node state mutex");
    let (events, attachments, docs, curation) = guard
        .owner(owner_hex)
        .map(|os| {
            (
                os.index.event_count(),
                os.index.attachment_count(),
                os.index.doc_count(),
                os.index.curation_count(),
            )
        })
        .unwrap_or((0, 0, 0, 0));
    let jobs = guard.job_status();
    let last = guard
        .last_reconcile()
        .map(|s| s.to_string())
        .unwrap_or_else(|| "never".to_string());
    // Per-role model id (config, not record content — already stamped into
    // provenance and shown in the PWA), or "none" when that role has no endpoint.
    let ocr = inference.ocr_client().map(|c| c.model()).unwrap_or("none");
    let chat = inference.chat_client().map(|c| c.model()).unwrap_or("none");
    format!(
        "vault: events={events} attachments={attachments} docs={docs} curation={curation} | \
         ocr: {reading} queued={} processed={} failed={} max-per-pass={} | \
         inference: ocr-model={ocr} chat-model={chat} | answers: {scope} | \
         last_reconcile={last}",
        jobs.queued,
        jobs.processed,
        jobs.failed,
        control.max_pages_per_pass(),
        scope = scopes.scope(owner_hex).describe(),
        // Whose pause this is, because the answer is only ever about the asker:
        // a paused status the owner cannot account for reads like a node fault.
        reading = if control.paused(owner_hex) {
            "paused by you"
        } else {
            "reading"
        }
    )
}

/// The most recent log lines that fit the reply budget, oldest-first. The node's
/// logs are content-free by construction (see [`crate::logtail`]).
fn log_tail_detail(logs: &LogBuffer, want: usize) -> String {
    let lines = logs.tail(want);
    let mut kept: Vec<&String> = Vec::new();
    let mut used = 0usize;
    for line in lines.iter().rev() {
        let cost = line.len() + 1; // +1 for the joining newline
        if used + cost > DETAIL_BUDGET && !kept.is_empty() {
            break;
        }
        used += cost;
        kept.push(line);
    }
    kept.reverse();
    if kept.is_empty() {
        return "(no log lines yet)".to_string();
    }
    let mut detail: String = kept.into_iter().cloned().collect::<Vec<_>>().join("\n");
    // A single line longer than the budget is truncated so the item still fits.
    if detail.len() > DETAIL_BUDGET {
        detail.truncate(DETAIL_BUDGET);
    }
    detail
}

/// Seal an `admin_reply` to the owner's X25519 key and deposit it.
fn deposit_reply(
    client: &RelayClient,
    node: &svastha_core::keys::Identity,
    owner_hex: &str,
    owner_x25519: [u8; 32],
    reply: &AdminReplyBody,
) -> Result<()> {
    let recipient = PublicKey::from(owner_x25519);
    let plaintext = serde_json::to_vec(reply)?;
    let envelope = MailboxMessage::seal(
        node,
        &recipient,
        MessageKind::AdminReply,
        now_ms(),
        &plaintext,
    );
    let item_id = format!("areply-{}", envelope.id_hex());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_tail_keeps_the_newest_lines_within_budget() {
        let logs = LogBuffer::new();
        for i in 0..1000 {
            logs.push(format!("log line number {i} with some padding text"));
        }
        let detail = log_tail_detail(&logs, CAPACITY);
        assert!(detail.len() <= DETAIL_BUDGET, "detail fits the item cap");
        // The very last line is the newest and must be present.
        assert!(detail.contains("number 999"), "newest line kept");
        assert!(!detail.contains("number 0 "), "oldest dropped to fit");
    }

    #[test]
    fn a_scope_command_is_ordered_by_sent_at_then_id() {
        let first = (100i64, "aaa".to_string());
        let later = (200i64, "bbb".to_string());

        // Nothing applied yet: the first one through is applied.
        assert!(supersedes(&first, None));
        // A later instruction replaces an earlier one...
        assert!(supersedes(&later, Some(&first)));
        // ...and an earlier one arriving afterwards does not undo it. This is the
        // whole point: mailbox order is not send order.
        assert!(!supersedes(&first, Some(&later)));
        // Re-applying the same command is not a later instruction.
        assert!(!supersedes(&first, Some(&first)));
    }

    #[test]
    fn commands_stamped_the_same_millisecond_still_have_one_order() {
        // No real order exists between them, so any consistent rule will do —
        // what matters is that it is the same rule every time, rather than
        // whichever the mailbox happened to yield first.
        let a = (100i64, "aaa".to_string());
        let b = (100i64, "bbb".to_string());
        assert!(supersedes(&b, Some(&a)));
        assert!(!supersedes(&a, Some(&b)));
    }

    #[test]
    fn log_tail_handles_an_empty_buffer() {
        let logs = LogBuffer::new();
        assert_eq!(log_tail_detail(&logs, 40), "(no log lines yet)");
    }
}
