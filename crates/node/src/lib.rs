//! The Svastha node substrate: enrolment, sync, and a curation-aware plaintext
//! index over the vaults that grant it. This is the foundation OCR (D2) and
//! RAG/chat (D3) sit on; it holds keys and plaintext but ships no models and makes
//! no inference calls yet.
//!
//! The node is a **pure relay client with no inbound ports** (the one listener is
//! the loopback bootstrap page). Every step is outbound-only and every sensitive
//! handoff is end-to-end-encrypted through the relay, so a deployment is secure
//! regardless of network topology (see `docs/ARCHITECTURE.md`, "Self-hosting", and
//! the design doc §7).
//!
//! Trust posture, in one line: the node is a **keyed grantee** each owner grants
//! whole-vault read access to. It can read plaintext (bounded, revocable by
//! rotation) but holds no seed and can never forge history — writes are proposals
//! the owner reviews and signs (D2+).
//!
//! ## Shape
//!
//! - [`config`] — boot config from env (`RELAY_URL` required; inference validated
//!   but unused until D2/D3).
//! - [`identity`] — the node's own disposable identity (the only durable state).
//! - [`client`] — the blocking, signed relay client (shared vaults, mailbox, SSE).
//! - [`sync`] / [`state`] — enrolment via `key_handoff` and the per-owner pull.
//! - [`index`] — the verified, curation-aware plaintext index D2/D3 build on.
//! - [`cache`] — ephemeral decrypted plaintext on disk.
//! - [`bootstrap`] — the loopback-only bootstrap page.

pub mod admin;
pub mod bootstrap;
pub mod cache;
pub mod chat;
pub mod client;
pub mod config;
pub mod extract;
pub mod identity;
pub mod index;
pub mod inference;
pub mod journal;
pub mod logtail;
pub mod ocr;
pub mod poke;
pub mod retrieval;
pub mod state;
pub mod sync;

use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::Result;
use svastha_core::CONTRACT_VERSION;

pub use config::Config;

use cache::Cache;
use client::RelayClient;
use inference::InferenceRuntime;
use journal::Journal;
use logtail::LogBuffer;
use poke::Poke;
use state::NodeState;

/// The upper bound on SSE reconnect backoff.
const MAX_BACKOFF: Duration = Duration::from_secs(30);

/// Run the node: load or generate its identity, serve the bootstrap page, and loop
/// forever reconciling from the relay — poke-driven when the SSE stream is up,
/// timer-driven as a fallback. Returns only on a fatal setup error.
///
/// `logs` is the ring buffer the `log_tail` admin command reads; the caller
/// (`main`) installs it as the tracing sink so both share one buffer.
pub fn run(config: Config, logs: LogBuffer) -> Result<()> {
    let (identity, fresh) = identity::load_or_generate(&config.data_dir)?;
    let identity = Arc::new(identity);
    let code = identity::identity_code(&identity, &config.label);
    announce(&identity, &code, &config, fresh);

    let client = Arc::new(RelayClient::new(config.relay_url.clone(), identity.clone()));
    match client.get_info() {
        Ok(version) if version != CONTRACT_VERSION => tracing::warn!(
            relay = version,
            node = CONTRACT_VERSION,
            "relay contract_version differs from the node's — decoding may fail"
        ),
        Ok(version) => tracing::info!(contract_version = version, "relay reachable"),
        Err(e) => {
            tracing::warn!(error = %e, "relay unreachable at boot; will retry on the poll loop")
        }
    }

    let cache = Arc::new(Cache::new(config.cache_dir.clone()));
    let state = Arc::new(Mutex::new(NodeState::new()));

    // Inference (OCR + RAG) runs only when an endpoint is configured. The runtime
    // resolves the effective endpoint from the env boot default plus any persisted
    // `set_inference_endpoint` override (override wins — see `InferenceRuntime`),
    // and can be reconfigured live by an admin command. The journal is the one
    // durable state besides the identity — content-free by construction (see
    // `journal`); it lives in the data dir so idempotence survives a restart.
    let mut inference = InferenceRuntime::load(config.inference.clone(), &config.data_dir);
    let mut journal = Journal::load(&config.data_dir);
    if inference.client().is_some() {
        tracing::info!("inference enabled: endpoint configured (OCR + cited Q&A)");
    } else {
        tracing::info!("inference disabled: no endpoint configured (admin can set one)");
    }

    spawn_bootstrap(&config, &code, &identity, state.clone());

    // SSE pokes arrive on this channel. Keep a spare sender so the receiver never
    // disconnects even if the stream thread dies — the timer path keeps working.
    let (tx, rx) = mpsc::channel::<Poke>();
    let _keep_open = tx.clone();
    spawn_sse(client.clone(), tx);

    // Initial full reconcile: enrol from the mailbox, then pull every vault.
    reconcile(
        &client,
        &cache,
        &state,
        &mut inference,
        &logs,
        &mut journal,
        Poke::Sync,
    );

    loop {
        let poke = match rx.recv_timeout(config.poll_interval) {
            Ok(poke) => poke,
            Err(RecvTimeoutError::Timeout) => Poke::Sync,
            // Cannot happen while `_keep_open` lives, but fall back to a full pull.
            Err(RecvTimeoutError::Disconnected) => {
                thread::sleep(config.poll_interval);
                Poke::Sync
            }
        };
        reconcile(
            &client,
            &cache,
            &state,
            &mut inference,
            &logs,
            &mut journal,
            poke,
        );
    }
}

/// Act on one poke (or a timer tick). Errors are logged, never fatal: a transient
/// relay outage must not take the node down — the next tick reconciles.
fn reconcile(
    client: &RelayClient,
    cache: &Cache,
    state: &Mutex<NodeState>,
    inference: &mut InferenceRuntime,
    logs: &LogBuffer,
    journal: &mut Journal,
    poke: Poke,
) {
    // A blobs poke only needs a vault pull; mailbox and sync also drain the
    // mailbox (a new enrolment needs its first pull afterward).
    let drain_mailbox = matches!(poke, Poke::Mailbox | Poke::Sync);
    if drain_mailbox {
        match sync::consume_mailbox(client, state) {
            Ok(r) if r.newly_enrolled + r.dropped + r.ignored > 0 => tracing::info!(
                new = r.newly_enrolled,
                merged = r.keyrings_merged,
                dropped = r.dropped,
                ignored = r.ignored,
                "mailbox drained"
            ),
            Ok(_) => {}
            Err(e) => tracing::warn!(error = %e, "mailbox drain failed"),
        }
    }
    match sync::sync_all(client, cache, state) {
        Ok(reports) => {
            for (owner, r) in reports {
                if !r.granted {
                    tracing::info!(owner = short(&owner), "no live grant; nothing pulled");
                } else if r.events + r.curation_applied + r.attachments + r.docs + r.dropped > 0 {
                    tracing::info!(
                        owner = short(&owner),
                        events = r.events,
                        curation = r.curation_applied,
                        curation_ignored = r.curation_ignored,
                        attachments = r.attachments,
                        docs = r.docs,
                        dropped = r.dropped,
                        skipped = r.skipped,
                        "vault synced"
                    );
                }
            }
        }
        Err(e) => tracing::warn!(error = %e, "vault sync failed"),
    }

    // Node administration (design §2): answer `admin_cmd`s from enrolled owners.
    // Runs regardless of inference config so `set_inference_endpoint` can enable
    // inference on a node booted without it — hence it comes before chat/OCR, so a
    // just-set endpoint serves this same pass.
    if drain_mailbox {
        match admin::run(client, state, inference, logs, journal) {
            Ok(r) if r.replied + r.dropped + r.deferred > 0 => tracing::info!(
                replied = r.replied,
                dropped = r.dropped,
                deferred = r.deferred,
                "admin pass"
            ),
            Ok(_) => {}
            Err(e) => tracing::warn!(error = %e, "admin pass failed"),
        }
    }

    // Cited Q&A (design §7): answer `chat_msg` questions. Only when inference is
    // available — a question the node cannot yet answer waits in the mailbox
    // rather than getting a fake reply.
    if drain_mailbox {
        if let Some(client_inf) = inference.client() {
            match chat::run(client, state, client_inf, journal) {
                Ok(r) if r.answered + r.cant_answer + r.dropped + r.deferred + r.ignored > 0 => {
                    tracing::info!(
                        answered = r.answered,
                        cant_answer = r.cant_answer,
                        deferred = r.deferred,
                        dropped = r.dropped,
                        ignored = r.ignored,
                        "chat pass"
                    );
                }
                Ok(_) => {}
                Err(e) => tracing::warn!(error = %e, "chat pass failed"),
            }
        }
    }

    // OCR the newly-synced pages into proposals (design §7). Idempotent across
    // ticks and restarts via the journal, so running it on every reconcile is
    // cheap — an already-processed page short-circuits.
    if let Some(client_inf) = inference.client() {
        match ocr::run(client, cache, state, client_inf, journal) {
            Ok(r)
                if r.proposals + r.empties + r.failed + r.resolved > 0
                    || r.not_ready > 0
                    || r.dropped_findings > 0 =>
            {
                tracing::info!(
                    proposals = r.proposals,
                    empties = r.empties,
                    failed = r.failed,
                    resolved = r.resolved,
                    not_ready = r.not_ready,
                    dropped_findings = r.dropped_findings,
                    "ocr pass"
                );
            }
            Ok(_) => {}
            Err(e) => tracing::warn!(error = %e, "ocr pass failed"),
        }
    }

    // Stamp the pass so `job_status` can report a last-reconcile time.
    if let Ok(mut guard) = state.lock() {
        guard.record_reconcile(now_secs());
    }
}

/// Wall-clock Unix seconds, for the last-reconcile stamp.
fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Log the node's identity code and a QR of it, so an operator can grant the node.
/// The code is public (both public keys plus a label); nothing secret is printed.
fn announce(identity: &svastha_core::keys::Identity, code: &str, config: &Config, fresh: bool) {
    tracing::info!(
        contract_version = CONTRACT_VERSION,
        fingerprint = %identity::fingerprint(identity),
        bootstrap = %config.bootstrap_addr,
        fresh_identity = fresh,
        "svastha node starting"
    );
    tracing::info!("node identity code (grant this from your app):\n{code}");
    if let Some(qr) = identity::qr_unicode(code) {
        tracing::info!("scan to grant:\n{qr}");
    }
}

fn spawn_bootstrap(
    config: &Config,
    code: &str,
    identity: &svastha_core::keys::Identity,
    state: Arc<Mutex<NodeState>>,
) {
    let page = bootstrap::BootstrapPage {
        identity_code: code.to_string(),
        fingerprint: identity::fingerprint(identity),
        label: config.label.clone(),
        qr_svg: identity::qr_svg(code),
    };
    let addr = config.bootstrap_addr.clone();
    thread::spawn(move || {
        if let Err(e) = bootstrap::serve(&addr, page, state) {
            tracing::error!(error = %e, "bootstrap page server exited");
        }
    });
}

fn spawn_sse(client: Arc<RelayClient>, tx: mpsc::Sender<Poke>) {
    thread::spawn(move || {
        let mut backoff = Duration::from_secs(1);
        loop {
            match client.stream_pokes(|poke| {
                let _ = tx.send(poke);
            }) {
                // Clean end (relay closed the stream): reconnect promptly.
                Ok(()) => backoff = Duration::from_secs(1),
                Err(e) => {
                    tracing::debug!(error = %e, "poke stream dropped; backing off");
                    thread::sleep(backoff);
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                    continue;
                }
            }
            thread::sleep(Duration::from_secs(1));
        }
    });
}

/// A log-safe short form of an owner id (a public key hex, not PHI, but kept terse).
fn short(owner_hex: &str) -> String {
    owner_hex.chars().take(12).collect()
}
