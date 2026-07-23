//! Web Push: the poke bus's second transport. When an identity is poked (a
//! mailbox deposit, or a blob write visible under its grant scope), the relay
//! already fans the poke out to that identity's live SSE streams (`pokes.rs`).
//! For an identity that has registered a Web Push subscription, the *same* poke
//! also goes out via Web Push — so "something is waiting for you" reaches a
//! locked phone whose PWA isn't open.
//!
//! **Payload-free by construction.** A Web Push carries no content: never a blob
//! id, count, kind, or owner — only a constant, non-informative marker
//! ([`PUSH_MARKER`]), encrypted (RFC 8291, aes128gcm) to the subscription's own
//! keys. The push services (Apple, Google, Mozilla) therefore learn only that a
//! poke happened and *when* — the same timing metadata SSE already exposes to
//! anyone watching the connection — and never anything the relay itself cannot
//! read. The service worker shows a generic notification; it could not decrypt
//! medical content even if the push carried it, because svastha seals its keys
//! at rest while the vault is locked.
//!
//! **Optional.** Push is off unless the operator supplies a VAPID keypair (see
//! the relay README). With no key, [`AppState::push`](crate::AppState::push) is
//! `None`, the `/v0/push*` endpoints answer `503`, and every other relay
//! behavior is untouched.
//!
//! The subscription store is pure routing metadata, the same class as a grant
//! edge: it maps an identity to the push endpoints it wants woken, and the relay
//! holds no key that can read a notification. It plugs in behind the
//! [`PushStore`] trait exactly as blobs, grants, and the mailbox do.
//!
//! The transport is the standard axum + `web-push`/VAPID stack: a VAPID-signed,
//! RFC 8291 (aes128gcm) encrypted push per subscription, pruning subscriptions
//! the push service reports gone.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use web_push::{
    ContentEncoding, IsahcWebPushClient, SubscriptionInfo, VapidSignatureBuilder, WebPushClient,
    WebPushError, WebPushMessageBuilder,
};

use crate::pokes::PokeHub;

/// A W3C Web Push subscription as the browser produces it (the object returned by
/// `PushManager.subscribe().toJSON()`). The relay needs these transport keys in
/// the clear to encrypt to the push service — they are the browser's per-endpoint
/// keys, not any svastha identity or vault key, and carry no message content, so
/// storing them does not weaken zero-knowledge.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Subscription {
    pub endpoint: String,
    pub keys: SubscriptionKeys,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

/// The constant, information-free payload every push carries. Encrypted to the
/// subscription's keys like any Web Push body, so the push service never reads
/// even this — but it is identical for every poke regardless of what changed, so
/// it could leak nothing even if it were plaintext. A fixed marker (rather than
/// an empty tickle) guarantees the service worker's `push` event always carries
/// data, which some push services require to deliver at all.
pub const PUSH_MARKER: &[u8] = b"svastha";

/// How long after pushing an identity the relay swallows further pushes to it.
///
/// A single sync often writes a burst of blobs (many `ev-`/`att-` puts in a
/// row), and each one pokes. Without a collapse window that burst would be a
/// dozen buzzes on the phone for one logical event. Debouncing per identity — at
/// most one push per identity per window, no matter how many blobs the burst
/// touched — turns the burst into one notification.
///
/// The trade-off is latency vs. spam: a longer window collapses more
/// aggressively but delays the *next* genuinely-separate notification by up to
/// this long. A few seconds is comfortably longer than a sync burst yet short
/// enough that a later, unrelated change still feels prompt. The **SSE** stream
/// is unaffected — it stays real-time; only Web Push is debounced, because only
/// Web Push costs the user a lock-screen interruption.
const COLLAPSE_WINDOW: Duration = Duration::from_secs(5);

/// Derive a subscription's stable store key from its endpoint. One identity may
/// register several subscriptions (one per device/browser); keying on a hash of
/// the endpoint means re-registering the *same* device replaces its entry rather
/// than accumulating duplicates, and lets a `DELETE` naming an endpoint remove
/// exactly one. The endpoint is treated as opaque — only its hash is a key.
pub fn subscription_key(endpoint: &str) -> String {
    hex::encode(Sha256::digest(endpoint.as_bytes()))
}

/// A store of Web Push subscriptions, partitioned by identity (an Ed25519 public
/// key, the same identity the auth handshake authenticates). One identity may
/// hold several subscriptions, keyed by [`subscription_key`]. Pure routing
/// metadata — same class as a grant edge. Implementations are cheap to share
/// across handlers (`Send + Sync`).
pub trait PushStore: Send + Sync {
    /// Register (or replace) a subscription for `identity` under `sub_key`.
    fn put(&self, identity: &[u8; 32], sub_key: &str, sub: &Subscription) -> io::Result<()>;
    /// Remove one subscription; returns whether it existed.
    fn delete(&self, identity: &[u8; 32], sub_key: &str) -> io::Result<bool>;
    /// Remove every subscription for `identity`; returns how many were removed.
    fn delete_all(&self, identity: &[u8; 32]) -> io::Result<usize>;
    /// List `identity`'s subscriptions as `(sub_key, subscription)` pairs — the
    /// key lets the fan-out prune a dead subscription in place.
    fn list(&self, identity: &[u8; 32]) -> io::Result<Vec<(String, Subscription)>>;
}

type Identities = HashMap<[u8; 32], HashMap<String, Subscription>>;

/// In-memory subscription store. Loses everything on restart — fine for tests and
/// an ephemeral relay; a subscription simply re-registers on the client's next
/// unlock. Never errors.
#[derive(Default)]
pub struct MemoryPushStore {
    identities: Mutex<Identities>,
}

impl MemoryPushStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl PushStore for MemoryPushStore {
    fn put(&self, identity: &[u8; 32], sub_key: &str, sub: &Subscription) -> io::Result<()> {
        self.identities
            .lock()
            .unwrap()
            .entry(*identity)
            .or_default()
            .insert(sub_key.to_string(), sub.clone());
        Ok(())
    }

    fn delete(&self, identity: &[u8; 32], sub_key: &str) -> io::Result<bool> {
        Ok(self
            .identities
            .lock()
            .unwrap()
            .get_mut(identity)
            .is_some_and(|subs| subs.remove(sub_key).is_some()))
    }

    fn delete_all(&self, identity: &[u8; 32]) -> io::Result<usize> {
        Ok(self
            .identities
            .lock()
            .unwrap()
            .remove(identity)
            .map(|subs| subs.len())
            .unwrap_or(0))
    }

    fn list(&self, identity: &[u8; 32]) -> io::Result<Vec<(String, Subscription)>> {
        Ok(self
            .identities
            .lock()
            .unwrap()
            .get(identity)
            .map(|subs| subs.iter().map(|(k, s)| (k.clone(), s.clone())).collect())
            .unwrap_or_default())
    }
}

/// Durable filesystem subscription store. Each subscription is a small JSON file
/// at `{root}/push/{hex(identity)}/{sub_key}`; writes are atomic (stage in a
/// sibling `.tmp` dir, then rename), the same pattern as [`crate::store::FsStore`].
/// `hex(identity)` is 64 hex chars and `sub_key` is a 64-hex-char SHA-256, so
/// neither can escape `root`.
pub struct FsPushStore {
    root: PathBuf,
    tmp: PathBuf,
}

impl FsPushStore {
    pub fn new(root: impl AsRef<Path>) -> io::Result<Self> {
        let root = root.as_ref().join("push");
        let tmp = root.join(".tmp");
        fs::create_dir_all(&tmp)?;
        Ok(Self { root, tmp })
    }

    fn identity_dir(&self, identity: &[u8; 32]) -> PathBuf {
        self.root.join(hex::encode(identity))
    }
}

impl PushStore for FsPushStore {
    fn put(&self, identity: &[u8; 32], sub_key: &str, sub: &Subscription) -> io::Result<()> {
        let dir = self.identity_dir(identity);
        fs::create_dir_all(&dir)?;
        let encoded = serde_json::to_vec(sub).map_err(io::Error::other)?;
        let mut tmp = NamedTempFile::new_in(&self.tmp)?;
        tmp.write_all(&encoded)?;
        tmp.flush()?;
        tmp.persist(dir.join(sub_key)).map_err(|e| e.error)?;
        Ok(())
    }

    fn delete(&self, identity: &[u8; 32], sub_key: &str) -> io::Result<bool> {
        match fs::remove_file(self.identity_dir(identity).join(sub_key)) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e),
        }
    }

    fn delete_all(&self, identity: &[u8; 32]) -> io::Result<usize> {
        let dir = self.identity_dir(identity);
        let count = match fs::read_dir(&dir) {
            Ok(entries) => entries.count(),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(e),
        };
        match fs::remove_dir_all(&dir) {
            Ok(()) => Ok(count),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(0),
            Err(e) => Err(e),
        }
    }

    fn list(&self, identity: &[u8; 32]) -> io::Result<Vec<(String, Subscription)>> {
        let entries = match fs::read_dir(self.identity_dir(identity)) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let mut out = Vec::new();
        for entry in entries {
            let entry = entry?;
            let key = entry.file_name().to_string_lossy().into_owned();
            match fs::read(entry.path()) {
                Ok(bytes) => {
                    if let Ok(sub) = serde_json::from_slice::<Subscription>(&bytes) {
                        out.push((key, sub));
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        Ok(out)
    }
}

/// The operator-supplied VAPID keypair and subject, held so the relay can
/// authenticate itself to the push services. The private key never leaves the
/// relay; the public key is handed to clients (via `GET /v0/push/key`) as the
/// `applicationServerKey` they subscribe with. Both are base64url as the
/// `web-push` crate and the browser both expect.
#[derive(Clone)]
pub struct Vapid {
    /// VAPID `sub` claim: a `mailto:` or `https:` contact the push service can
    /// reach the operator at. Operator-supplied — never a hardcoded host.
    pub subject: String,
    /// Public key (base64url), exposed to clients as `applicationServerKey`.
    pub public_key: String,
    /// Private key (base64url), used only to sign the VAPID JWT. Never exposed.
    pub private_key: String,
}

/// The push transport: the operator's VAPID keys, the subscription store, and a
/// per-identity collapse-window clock. Present only when push is configured (see
/// the module docs); its absence turns the feature off cleanly.
pub struct PushService {
    vapid: Vapid,
    store: Arc<dyn PushStore>,
    /// Last time each identity was pushed, for the collapse window. Bounded by
    /// pruning entries older than [`COLLAPSE_WINDOW`] on every access, so it
    /// holds at most the identities pushed within one window.
    collapse: Mutex<HashMap<[u8; 32], Instant>>,
}

impl PushService {
    /// Build the service over an already-constructed subscription store.
    pub fn new(vapid: Vapid, store: Arc<dyn PushStore>) -> Self {
        Self {
            vapid,
            store,
            collapse: Mutex::new(HashMap::new()),
        }
    }

    /// The subscription store, for the `/v0/push*` handlers.
    pub fn store(&self) -> &Arc<dyn PushStore> {
        &self.store
    }

    /// The VAPID public key clients subscribe with (`applicationServerKey`).
    pub fn public_key(&self) -> &str {
        &self.vapid.public_key
    }

    /// Fan a poke out to `identity`'s Web Push subscriptions — off the write's hot
    /// path. Returns immediately: the actual sends are spawned, so a slow or
    /// unreachable push service never blocks the blob/mailbox write that poked.
    ///
    /// Two things short-circuit before any work is queued:
    ///
    /// - **SSE suppression.** If the identity currently holds a live SSE stream,
    ///   it is foregrounded and already got the real-time poke there; a
    ///   lock-screen buzz would be redundant, so it is skipped. This is
    ///   best-effort — a stream that drops in the same instant just means a
    ///   missed push, which the next pull corrects, exactly the push channel's
    ///   lossy-by-design contract.
    /// - **Collapse window.** At most one push per identity per
    ///   [`COLLAPSE_WINDOW`], so a sync burst is one notification, not a dozen.
    pub fn notify(self: &Arc<Self>, hub: &PokeHub, identity: [u8; 32]) {
        // Foregrounded (a live stream) → already poked over SSE; don't also buzz.
        if hub.has_live_stream(&identity) {
            return;
        }
        {
            let now = Instant::now();
            let mut collapse = self.collapse.lock().unwrap();
            collapse.retain(|_, last| now.duration_since(*last) < COLLAPSE_WINDOW);
            if collapse.contains_key(&identity) {
                // Pushed within the window already: this poke collapses into it.
                return;
            }
            collapse.insert(identity, now);
        }
        let service = Arc::clone(self);
        // Off the hot path: the send is network I/O to an external push service.
        tokio::spawn(async move { service.fan_out(identity).await });
    }

    /// Send the payload-free marker to each of `identity`'s subscriptions,
    /// pruning any the push service reports permanently gone. Transient failures
    /// are logged and left in place — the next poke retries, and the pull path is
    /// authoritative regardless.
    async fn fan_out(&self, identity: [u8; 32]) {
        let subs = match self.store.list(&identity) {
            Ok(subs) => subs,
            Err(e) => {
                tracing::warn!(error = %e, "push: listing subscriptions failed");
                return;
            }
        };
        if subs.is_empty() {
            return;
        }
        let client = match IsahcWebPushClient::new() {
            Ok(client) => client,
            Err(e) => {
                tracing::warn!(error = %e, "push: web-push client init failed");
                return;
            }
        };
        for (sub_key, sub) in subs {
            match send_one(&client, &self.vapid, &sub).await {
                Ok(()) => {}
                Err(e) => {
                    // A subscription the push service says is gone or invalid is
                    // dead — the browser unsubscribed or the endpoint expired.
                    // Prune it so the relay stops trying (and the store doesn't
                    // grow stale). Other errors are transient: leave the entry.
                    if matches!(
                        e,
                        WebPushError::EndpointNotFound(_) | WebPushError::EndpointNotValid(_)
                    ) {
                        let _ = self.store.delete(&identity, &sub_key);
                    }
                    tracing::warn!(error = %e, "push: send failed");
                }
            }
        }
    }
}

/// Encrypt and send the constant marker to one subscription with a fresh VAPID
/// signature. The payload is [`PUSH_MARKER`] — identical for every poke — sealed
/// (aes128gcm) to the subscription's own keys, so nothing the relay routes on
/// reaches the push service in the clear.
async fn send_one(
    client: &IsahcWebPushClient,
    vapid: &Vapid,
    sub: &Subscription,
) -> Result<(), WebPushError> {
    let info = SubscriptionInfo::new(
        sub.endpoint.clone(),
        sub.keys.p256dh.clone(),
        sub.keys.auth.clone(),
    );
    let mut sig = VapidSignatureBuilder::from_base64(&vapid.private_key, &info)?;
    sig.add_claim("sub", vapid.subject.as_str());
    let signature = sig.build()?;

    let mut msg = WebPushMessageBuilder::new(&info);
    msg.set_payload(ContentEncoding::Aes128Gcm, PUSH_MARKER);
    msg.set_vapid_signature(signature);
    client.send(msg.build()?).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn id(b: u8) -> [u8; 32] {
        [b; 32]
    }

    fn sub(endpoint: &str) -> Subscription {
        Subscription {
            endpoint: endpoint.to_string(),
            keys: SubscriptionKeys {
                p256dh: "p".to_string(),
                auth: "a".to_string(),
            },
        }
    }

    #[test]
    fn subscription_key_is_stable_per_endpoint() {
        assert_eq!(
            subscription_key("https://x/1"),
            subscription_key("https://x/1")
        );
        assert_ne!(
            subscription_key("https://x/1"),
            subscription_key("https://x/2")
        );
    }

    fn round_trip(store: &dyn PushStore) {
        let alice = id(1);
        let e1 = "https://push.example/aaa";
        let e2 = "https://push.example/bbb";
        store.put(&alice, &subscription_key(e1), &sub(e1)).unwrap();
        store.put(&alice, &subscription_key(e2), &sub(e2)).unwrap();

        let mut got = store.list(&alice).unwrap();
        got.sort_by(|a, b| a.1.endpoint.cmp(&b.1.endpoint));
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].1.endpoint, e1);

        // Re-registering the same device replaces, not duplicates.
        store.put(&alice, &subscription_key(e1), &sub(e1)).unwrap();
        assert_eq!(store.list(&alice).unwrap().len(), 2);

        // Delete one.
        assert!(store.delete(&alice, &subscription_key(e1)).unwrap());
        assert_eq!(store.list(&alice).unwrap().len(), 1);
        assert!(!store.delete(&alice, &subscription_key(e1)).unwrap());

        // Delete all clears the rest.
        assert_eq!(store.delete_all(&alice).unwrap(), 1);
        assert!(store.list(&alice).unwrap().is_empty());
        assert_eq!(store.delete_all(&alice).unwrap(), 0);
    }

    #[test]
    fn memory_round_trip() {
        round_trip(&MemoryPushStore::new());
    }

    #[test]
    fn fs_round_trip() {
        let dir = tempdir().unwrap();
        round_trip(&FsPushStore::new(dir.path()).unwrap());
    }

    #[test]
    fn fs_survives_reopen() {
        let dir = tempdir().unwrap();
        let alice = id(1);
        let e = "https://push.example/keep";
        {
            let store = FsPushStore::new(dir.path()).unwrap();
            store.put(&alice, &subscription_key(e), &sub(e)).unwrap();
        }
        let reopened = FsPushStore::new(dir.path()).unwrap();
        assert_eq!(reopened.list(&alice).unwrap().len(), 1);
    }

    #[test]
    fn identities_are_isolated() {
        let store = MemoryPushStore::new();
        let e = "https://push.example/x";
        store.put(&id(1), &subscription_key(e), &sub(e)).unwrap();
        assert!(store.list(&id(2)).unwrap().is_empty());
    }
}
