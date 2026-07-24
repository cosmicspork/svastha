//! Node administration over the mailbox (design §2, §9): an owner administers the
//! node's work on **their own** vault with `admin_cmd` envelopes, and the node
//! replies `admin_reply`. Three commands, matching the PWA's admin surface:
//! `job_status`, `log_tail`, and `set_inference_endpoint`.
//!
//! ## The admin trust rule (design §2)
//!
//! Commands are accepted only from an identity the node is **enrolled with** — an
//! owner who granted the node and handed off keys — verified exactly like a chat
//! question (envelope verify + relay attestation + enrolled-owner check). You
//! administer the node's processing of *your* vault, not the node itself. **Node-
//! global operations** (restart, upgrade, choosing whether the node runs at all)
//! are the **host operator's**, not commands — there is deliberately no envelope
//! that can restart or reconfigure the process globally.
//!
//! ## Content-free throughout
//!
//! `job_status` and `log_tail` return only counts, ids, timestamps, and the node's
//! own already-content-free log lines (see [`crate::logtail`]). `set_inference_endpoint`
//! carries a config URL, never record content. Nothing here logs or returns PHI.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use svastha_core::mailbox::{
    parse_mailbox_item, AdminCmdBody, AdminCommand, AdminReplyBody, MailboxItem, MailboxMessage,
    MessageKind,
};
use x25519_dalek::PublicKey;

use crate::client::RelayClient;
use crate::inference::InferenceRuntime;
use crate::journal::Journal;
use crate::logtail::{LogBuffer, CAPACITY};
use crate::state::NodeState;

/// Default number of log lines a `log_tail` returns when the command names none.
const DEFAULT_LOG_LINES: usize = 40;

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
    logs: &LogBuffer,
    journal: &mut Journal,
) -> Result<AdminReport> {
    let mut report = AdminReport::default();
    let node = client.identity();

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

        // Open and parse the command.
        let Ok(plain) = msg.open(node) else {
            report.dropped += 1;
            continue;
        };
        let Ok(body) = serde_json::from_slice::<AdminCmdBody>(&plain) else {
            report.dropped += 1;
            continue;
        };

        let (ok, detail) = execute(&body.command, state, inference, logs, &owner_hex);
        let reply = AdminReplyBody {
            in_reply_to: msg_id.clone(),
            ok,
            detail: Some(detail),
        };
        match deposit_reply(client, node, &owner_hex, owner_x25519, &reply) {
            Ok(()) => {
                journal.mark_request_handled(&msg_id)?;
                let _ = client.delete_mailbox(&entry.id);
                report.replied += 1;
                tracing::info!(owner = short(&owner_hex), ok, "admin command answered");
            }
            Err(e) => {
                report.deferred += 1;
                tracing::warn!(owner = short(&owner_hex), error = %e, "admin reply deposit failed; will retry");
            }
        }
    }
    Ok(report)
}

/// Execute one command, returning `(ok, detail)`. Never fails the pass — a bad
/// value answers `ok: false` with the reason, so the owner sees it in the app.
fn execute(
    command: &AdminCommand,
    state: &Mutex<NodeState>,
    inference: &mut InferenceRuntime,
    logs: &LogBuffer,
    owner_hex: &str,
) -> (bool, String) {
    match command {
        AdminCommand::JobStatus => (true, job_status_detail(state, inference, owner_hex)),
        AdminCommand::LogTail { lines } => {
            let want = lines
                .map(|n| n as usize)
                .unwrap_or(DEFAULT_LOG_LINES)
                .min(CAPACITY);
            (true, log_tail_detail(logs, want))
        }
        AdminCommand::SetInferenceEndpoint { endpoint } => match inference.set_endpoint(endpoint) {
            // Still subject to the boot-time config validation (synchronous,
            // non-batch); a rejected value answers ok:false with the message.
            Ok(detail) => (true, detail),
            Err(msg) => (false, msg),
        },
    }
}

/// A content-free job-status line: this owner's index sizes (per-owner), the
/// global OCR counters, whether inference is configured, and the last reconcile
/// time (Unix seconds). Counts and a timestamp only.
fn job_status_detail(
    state: &Mutex<NodeState>,
    inference: &InferenceRuntime,
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
    let inference = if inference.endpoint().is_some() {
        "configured"
    } else {
        "none"
    };
    format!(
        "vault: events={events} attachments={attachments} docs={docs} curation={curation} | \
         ocr: queued={} processed={} failed={} | inference: {inference} | last_reconcile={last}",
        jobs.queued, jobs.processed, jobs.failed
    )
}

/// The most recent log lines that fit the reply budget, oldest-first. The node's
/// logs are content-free by construction (see [`crate::logtail`]).
fn log_tail_detail(logs: &LogBuffer, want: usize) -> String {
    let lines = logs.tail(want);
    // Keep the newest lines that fit the budget: walk from the end, accumulating
    // until adding another would overflow, then present them oldest-first.
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
    fn log_tail_handles_an_empty_buffer() {
        let logs = LogBuffer::new();
        assert_eq!(log_tail_detail(&logs, 40), "(no log lines yet)");
    }
}
