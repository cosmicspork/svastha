//! The typed mailbox message envelope: the one shape everything new on the
//! store-and-forward mailbox rides — proposals, node administration, cited Q&A,
//! and the vault-key handoff that used to be the mailbox's only, implicit
//! payload. It is a **typed, versioned, end-to-end-encrypted** envelope, and the
//! wave's principal trust-contract addition.
//!
//! ```text
//! { v, kind, from, sent_at, id, body, signature }
//! ```
//!
//! - `v` is the envelope version (a small discriminator, currently
//!   [`ENVELOPE_VERSION`] = 1), distinct from [`crate::CONTRACT_VERSION`]: the
//!   envelope format can revise on its own cadence.
//! - `kind` selects the body schema ([`MessageKind`]).
//! - `from` is the sender's Ed25519 identity; the envelope is **signed by it**.
//! - `sent_at` is the sender's clock in Unix **milliseconds** (like a curation
//!   record's `updated_at`) — informational, never trusted for ordering.
//! - `body` is the kind-specific plaintext **sealed to the recipient's X25519
//!   key** ([`SealedBox`]); the relay only ever forwards ciphertext.
//! - `id` is the content id of the whole envelope (a hash of its canonical
//!   bytes), carried so a relay can de-duplicate a message it sees twice — cheap
//!   now, and it makes cross-relay dedupe trivial if a client ever syncs against
//!   more than one relay.
//!
//! **Sealed then signed.** The body is sealed to the recipient first; the
//! signature then covers the message id — which commits to the sealed body along
//! with `v`, `kind`, `from`, and `sent_at`. So a recipient can **verify-or-drop
//! before decrypting** (the same posture as a curation record from a doctor-share
//! bundle): a tampered or misrouted envelope fails [`MailboxMessage::verify`]
//! without the decrypt path ever running.
//!
//! **Grandfathering.** Before this envelope existed, the mailbox carried a bare
//! wrapped-key deposit — a small JSON blob with a `wrapped_hex` field and no
//! signature. That format ([`LegacyWrappedKeyDeposit`]) still parses within the
//! current contract major (see [`parse_mailbox_item`]); a new sender sends a
//! [`MessageKind::KeyHandoff`] envelope instead. Both are readable side by side
//! because holding [`crate::CONTRACT_MAJOR`] fixed keeps every old wrapped key
//! openable.
//!
//! `spec/README.md` is the authoritative description and
//! `spec/vectors/mailbox.json` pins the bytes.

use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use x25519_dalek::PublicKey;

use crate::envelope::{seal_to, seal_to_with_ephemeral, EnvelopeError, SealedBox};
use crate::event::Event;
use crate::keys::Identity;

/// The current envelope-format version. Distinct from
/// [`crate::CONTRACT_VERSION`]: it discriminates the on-the-wire envelope shape
/// and rides in the signed canonical bytes, so tampering with it fails
/// verification.
pub const ENVELOPE_VERSION: u8 = 1;

/// Domain tag for the message-id hash. **Version-independent** (like the
/// event-id tag, and unlike the HKDF labels) so a message keeps one identity for
/// dedupe regardless of the contract build that produced it — the point of the id
/// is cross-relay de-duplication, a stable identity, not a versioned artifact.
const DOMAIN_MSG_ID: &[u8] = b"svastha/mailbox-msg-id\0";

/// Failures parsing a mailbox item from untrusted bytes.
#[derive(Debug, thiserror::Error)]
pub enum MailboxError {
    /// The bytes are neither a typed [`MailboxMessage`] nor a legacy
    /// [`LegacyWrappedKeyDeposit`].
    #[error("unrecognized mailbox item")]
    Unrecognized,
}

/// The kind of a mailbox message; selects the body schema. The `snake_case`
/// serde form is also the stable wire name used in the canonical encoding, so
/// reordering this enum cannot silently change a message id (mirrors
/// [`crate::event::EventKind`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    /// Draft events suggested by a granted identity for the owner to approve.
    Proposal,
    /// The owner's accept/reject decision echoed back to the proposer.
    ProposalResult,
    /// Owner-signed node administration (set inference endpoint, job status, …).
    AdminCmd,
    /// The node's reply to an [`AdminCmd`](MessageKind::AdminCmd).
    AdminReply,
    /// A retrieval-augmented question or answer turn.
    ChatMsg,
    /// A wrapped vault key (or, once epochs land, a wrapped keyring) — the typed
    /// successor to the bare wrapped-key deposit.
    KeyHandoff,
}

impl MessageKind {
    /// The stable wire name (matches the serde `snake_case` form). Used in the
    /// canonical encoding so reordering the enum cannot change ids.
    fn wire_name(&self) -> &'static str {
        match self {
            MessageKind::Proposal => "proposal",
            MessageKind::ProposalResult => "proposal_result",
            MessageKind::AdminCmd => "admin_cmd",
            MessageKind::AdminReply => "admin_reply",
            MessageKind::ChatMsg => "chat_msg",
            MessageKind::KeyHandoff => "key_handoff",
        }
    }
}

/// A typed, sealed, signed mailbox envelope. Build one with
/// [`MailboxMessage::seal`]; a recipient calls [`verify`](Self::verify) (drop on
/// false) then [`open`](Self::open).
///
/// Serializes flat, all byte fields as lowercase hex:
/// `{ v, kind, from, sent_at, id, body, signature }`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MailboxMessage {
    /// Envelope version (see [`ENVELOPE_VERSION`]).
    pub v: u8,
    pub kind: MessageKind,
    /// The sender's Ed25519 public key (hex): the signer and the
    /// verification key.
    #[serde(with = "hex_bytes")]
    from: [u8; 32],
    /// Sender clock, Unix milliseconds.
    pub sent_at: i64,
    /// The content id of this envelope (hex): `SHA-256` over its canonical bytes.
    #[serde(with = "hex_bytes")]
    id: [u8; 32],
    /// The kind-specific body, sealed to the recipient ([`SealedBox`] wire
    /// bytes, hex).
    #[serde(with = "hex_vec")]
    body: Vec<u8>,
    #[serde(with = "hex_bytes")]
    signature: [u8; 64],
}

impl MailboxMessage {
    /// Seal `body_plaintext` to `recipient_x25519` and sign the envelope as
    /// `sender`. `kind` selects how a recipient interprets the opened body;
    /// `sent_at` is the sender's Unix-millisecond clock.
    pub fn seal(
        sender: &Identity,
        recipient_x25519: &PublicKey,
        kind: MessageKind,
        sent_at: i64,
        body_plaintext: &[u8],
    ) -> Self {
        // Empty AAD on the body seal: the envelope signature (over the id, which
        // commits to the sealed body along with kind/from/sent_at) is what binds
        // the body to its envelope, so no separate AEAD binding is needed.
        let sealed = seal_to(recipient_x25519, body_plaintext, &[]);
        Self::assemble(sender, kind, sent_at, sealed.to_bytes())
    }

    /// Seal with a caller-supplied ephemeral secret and nonce — reproducible, so
    /// only for test vectors; production callers use [`seal`](Self::seal). The
    /// Ed25519 signature is already deterministic (RFC 8032), so nothing else
    /// needs pinning.
    pub fn seal_with(
        sender: &Identity,
        recipient_x25519: &PublicKey,
        kind: MessageKind,
        sent_at: i64,
        body_plaintext: &[u8],
        ephemeral_secret: [u8; 32],
        nonce: [u8; 24],
    ) -> Self {
        let sealed = seal_to_with_ephemeral(
            recipient_x25519,
            body_plaintext,
            &[],
            ephemeral_secret,
            nonce,
        );
        Self::assemble(sender, kind, sent_at, sealed.to_bytes())
    }

    fn assemble(sender: &Identity, kind: MessageKind, sent_at: i64, body: Vec<u8>) -> Self {
        let mut msg = Self {
            v: ENVELOPE_VERSION,
            kind,
            from: sender.verifying_key().to_bytes(),
            sent_at,
            id: [0u8; 32],
            body,
            signature: [0u8; 64],
        };
        msg.id = msg.msg_id();
        msg.signature = sender.sign(&msg.signing_bytes()).to_bytes();
        msg
    }

    /// The sender's Ed25519 public key (hex).
    pub fn from_hex(&self) -> String {
        hex::encode(self.from)
    }

    /// The message id (hex).
    pub fn id_hex(&self) -> String {
        hex::encode(self.id)
    }

    /// The canonical byte encoding of the envelope — `v ‖ kind ‖ from ‖ sent_at
    /// ‖ body`. `from` is included (a message from a different sender is a
    /// different message; there is no cross-source collapse to preserve, unlike
    /// an event's content id), so the id de-duplicates only truly identical
    /// envelopes. Field encoding matches the rest of the contract: a single byte
    /// for `v`, length-prefixed strings/bytes, big-endian fixed-width integers.
    pub fn canonical_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.push(self.v);
        put_str(&mut out, self.kind.wire_name());
        out.extend_from_slice(&self.from);
        out.extend_from_slice(&self.sent_at.to_be_bytes());
        put_bytes(&mut out, &self.body);
        out
    }

    /// The content id: `SHA-256` over a version-independent domain tag and the
    /// canonical bytes. Recomputed from the fields, never trusting the stored
    /// `id`, so [`verify`](Self::verify) can reject a mismatched one.
    pub fn msg_id(&self) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(DOMAIN_MSG_ID);
        hasher.update(self.canonical_bytes());
        hasher.finalize().into()
    }

    /// The bytes `from` signs: a version-tagged domain label (separating mailbox
    /// signatures from event/curation/relay-auth ones) then the message id. The
    /// id is a collision-resistant commitment to every field, so signing it
    /// covers the whole envelope — the same shape as
    /// [`crate::event::Event::signing_bytes`] signing the content id.
    pub fn signing_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(crate::version_label("mailbox").as_bytes());
        out.extend_from_slice(&self.msg_id());
        out
    }

    /// Verify the envelope: the stored `id` must equal the recomputed message id,
    /// and the signature must bind that id to `from`. Any tampering — with `v`,
    /// `kind`, `from`, `sent_at`, or the sealed `body` — changes the recomputed
    /// id and fails; a wrong `from` is the wrong verification key and fails.
    /// Callers **verify-or-drop before [`open`](Self::open)**.
    pub fn verify(&self) -> bool {
        if self.id != self.msg_id() {
            return false;
        }
        let Ok(from) = VerifyingKey::from_bytes(&self.from) else {
            return false;
        };
        let signature = Signature::from_bytes(&self.signature);
        crate::keys::verify(&from, &self.signing_bytes(), &signature)
    }

    /// Open the sealed body with the recipient's identity. Does not verify —
    /// callers [`verify`](Self::verify) first and drop on failure. Fails with
    /// [`EnvelopeError`] if the body was not sealed to this identity or is
    /// malformed.
    pub fn open(&self, recipient: &Identity) -> Result<Vec<u8>, EnvelopeError> {
        let sealed = SealedBox::from_bytes(&self.body)?;
        recipient.open_sealed_box(&sealed, &[])
    }
}

// --- body schemas ---
//
// The plaintext each `kind` seals. Kept in `core` so the node (native) and the
// web client (WASM) share one definition, but deliberately minimal and
// additively extensible: optional fields use serde defaults and unknown fields
// are ignored, so a newer sender can add fields without breaking an older
// reader. None of this is signed or hashed by the envelope — the body is opaque
// sealed bytes to the crypto above; these types only shape the plaintext.

/// [`MessageKind::KeyHandoff`] body — the typed successor to the bare
/// wrapped-key deposit. `wrapped_hex` is the wrapped vault key (today) or wrapped
/// keyring (once epochs land) as [`crate::envelope::WrappedKey`] wire bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyHandoffBody {
    pub from_ed: String,
    pub from_x25519: String,
    pub label: String,
    pub wrapped_hex: String,
}

/// [`MessageKind::Proposal`] body — draft events for the owner to approve. The
/// proposer identity is the envelope `from`, so it is not repeated per draft.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProposalBody {
    pub proposals: Vec<DraftProposal>,
}

/// One proposed event with its extraction provenance. On approval the owner
/// stamps [`crate::event::Proposed`] (`by` = the envelope `from`, plus these
/// fields) onto the event and signs it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DraftProposal {
    /// The draft: schema-valid and content-addressed, but **unsigned** until the
    /// owner approves.
    pub event: Event,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_blob: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// [`MessageKind::ProposalResult`] body — the owner's decision echoed to the
/// proposer. Ids are event content ids (hex).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProposalResultBody {
    /// The proposal message id (hex) this responds to.
    pub proposal_id: String,
    #[serde(default)]
    pub accepted: Vec<String>,
    #[serde(default)]
    pub rejected: Vec<String>,
}

/// A node-administration command (owner → node). Additive: a new command is a
/// new variant; the `cmd` tag names it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum AdminCommand {
    SetInferenceEndpoint {
        endpoint: String,
    },
    JobStatus,
    LogTail {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lines: Option<u32>,
    },
}

/// [`MessageKind::AdminCmd`] body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdminCmdBody {
    pub command: AdminCommand,
}

/// [`MessageKind::AdminReply`] body — the node's answer to an admin command.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdminReplyBody {
    /// The admin-command message id (hex) this replies to.
    pub in_reply_to: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// The two turns a [`ChatMsgBody`] carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatRole {
    Question,
    Answer,
}

/// [`MessageKind::ChatMsg`] body — a retrieval-augmented Q&A turn. An answer
/// carries the event ids (hex) it drew from, so the client can deep-link each
/// citation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatMsgBody {
    pub role: ChatRole,
    pub text: String,
    #[serde(default)]
    pub citations: Vec<String>,
}

// --- grandfathering: the legacy bare wrapped-key deposit ---

/// Today's (pre-envelope) mailbox payload: a small JSON blob a client wrote
/// directly as a `vaultkey-*` mailbox item, carrying one wrapped vault key and no
/// signature. Retained so it still parses within the current contract major; new
/// senders send a [`MessageKind::KeyHandoff`] envelope. The wrapped key inside
/// stays openable because [`crate::CONTRACT_MAJOR`] is held fixed across the
/// [`crate::CONTRACT_VERSION`] bump.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyWrappedKeyDeposit {
    pub v: u8,
    pub from_ed: String,
    pub from_x25519: String,
    pub label: String,
    pub wrapped_hex: String,
}

/// A parsed mailbox item: either a typed envelope or a grandfathered legacy
/// deposit. `Message` is boxed because the envelope is much larger than the
/// legacy variant.
#[derive(Clone, Debug)]
pub enum MailboxItem {
    Message(Box<MailboxMessage>),
    Legacy(LegacyWrappedKeyDeposit),
}

/// Parse a raw mailbox item, accepting both the typed envelope (tried first, the
/// new normal) and the grandfathered bare wrapped-key deposit. The two are
/// unambiguous: a typed envelope requires `kind`/`from`/`id`/`body`/`signature`,
/// a legacy deposit requires `from_ed`/`from_x25519`/`wrapped_hex` — neither
/// parses as the other. A caller still [`verify`](MailboxMessage::verify)s a
/// returned [`MailboxItem::Message`] before trusting it.
pub fn parse_mailbox_item(bytes: &[u8]) -> Result<MailboxItem, MailboxError> {
    if let Ok(msg) = serde_json::from_slice::<MailboxMessage>(bytes) {
        return Ok(MailboxItem::Message(Box::new(msg)));
    }
    if let Ok(legacy) = serde_json::from_slice::<LegacyWrappedKeyDeposit>(bytes) {
        return Ok(MailboxItem::Legacy(legacy));
    }
    Err(MailboxError::Unrecognized)
}

// --- canonical encoding primitives ---
//
// The same length-prefix scheme as the event/curation/relay-auth encodings: a
// field is u32 big-endian length ‖ bytes. Duplicated here so each contract module
// owns its encoding locally.

fn put_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

fn put_str(out: &mut Vec<u8>, s: &str) {
    put_bytes(out, s.as_bytes());
}

/// serde adapter: fixed-size byte arrays as lowercase hex (matches the id and
/// signature wire form across the contract).
mod hex_bytes {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer, const N: usize>(
        bytes: &[u8; N],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&hex::encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>, const N: usize>(
        deserializer: D,
    ) -> Result<[u8; N], D::Error> {
        let s = String::deserialize(deserializer)?;
        hex::decode(&s)
            .map_err(serde::de::Error::custom)?
            .try_into()
            .map_err(|_| serde::de::Error::custom("wrong byte length"))
    }
}

/// serde adapter: a variable-length byte vector (the sealed body) as lowercase
/// hex.
mod hex_vec {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&hex::encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(deserializer)?;
        hex::decode(&s).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::{wrap_key, DataKey};
    use crate::event::{Code, EventKind, EventValue, Provenance};
    use serde_json::json;

    fn observation() -> Event {
        Event::new(
            EventKind::Observation,
            Some(Code {
                system: "http://loinc.org".into(),
                code: "8867-4".into(),
                display: None,
            }),
            Some("2026-01-02T15:04:05Z".into()),
            Some(EventValue::Quantity {
                value: "72".into(),
                unit: None,
            }),
            Provenance {
                source: "node".into(),
                source_doc: None,
            },
        )
    }

    fn sealed(kind: MessageKind, body: &[u8]) -> (Identity, Identity, MailboxMessage) {
        let sender = Identity::from_seed(b"sender seed");
        let recipient = Identity::from_seed(b"recipient seed");
        let msg = MailboxMessage::seal(
            &sender,
            &recipient.x25519_public(),
            kind,
            1_753_280_000_000,
            body,
        );
        (sender, recipient, msg)
    }

    #[test]
    fn seal_verify_open_round_trip() {
        let (_s, recipient, msg) = sealed(MessageKind::ChatMsg, b"hello node");
        assert!(msg.verify());
        assert_eq!(msg.open(&recipient).unwrap(), b"hello node");
        assert_eq!(msg.v, ENVELOPE_VERSION);
        assert_eq!(msg.id_hex(), hex::encode(msg.msg_id()));
    }

    #[test]
    fn from_is_the_sender() {
        let sender = Identity::from_seed(b"sender seed");
        let recipient = Identity::from_seed(b"recipient seed");
        let msg = MailboxMessage::seal(
            &sender,
            &recipient.x25519_public(),
            MessageKind::KeyHandoff,
            1,
            b"body",
        );
        assert_eq!(
            msg.from_hex(),
            hex::encode(sender.verifying_key().to_bytes())
        );
    }

    #[test]
    fn verify_rejects_tampered_kind() {
        let (_s, _r, mut msg) = sealed(MessageKind::Proposal, b"x");
        msg.kind = MessageKind::AdminCmd;
        assert!(!msg.verify());
    }

    #[test]
    fn verify_rejects_tampered_sent_at() {
        let (_s, _r, mut msg) = sealed(MessageKind::Proposal, b"x");
        msg.sent_at += 1;
        // The stored id no longer matches the recomputed one.
        assert!(!msg.verify());
    }

    #[test]
    fn verify_rejects_tampered_body() {
        let (_s, _r, mut msg) = sealed(MessageKind::Proposal, b"x");
        msg.body[0] ^= 0x01;
        assert!(!msg.verify());
    }

    #[test]
    fn verify_rejects_tampered_signature() {
        let (_s, _r, mut msg) = sealed(MessageKind::Proposal, b"x");
        msg.signature[0] ^= 0x01;
        assert!(!msg.verify());
    }

    #[test]
    fn verify_rejects_wrong_from() {
        let (_s, _r, mut msg) = sealed(MessageKind::Proposal, b"x");
        let attacker = Identity::from_seed(b"attacker seed");
        msg.from = attacker.verifying_key().to_bytes();
        // Swapping `from` alone changes the id (from is in the preimage) and the
        // verification key; either is enough to fail.
        assert!(!msg.verify());
    }

    #[test]
    fn open_rejects_wrong_recipient() {
        let (_s, _r, msg) = sealed(MessageKind::ChatMsg, b"secret");
        let attacker = Identity::from_seed(b"attacker seed");
        assert!(msg.open(&attacker).is_err());
    }

    #[test]
    fn envelope_serde_round_trip() {
        let (_s, _r, msg) = sealed(MessageKind::KeyHandoff, b"body");
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: MailboxMessage = serde_json::from_str(&json).unwrap();
        assert!(parsed.verify());
        assert_eq!(parsed.id_hex(), msg.id_hex());
        // Flat wire shape.
        let value = serde_json::to_value(&msg).unwrap();
        for field in ["v", "kind", "from", "sent_at", "id", "body", "signature"] {
            assert!(value.get(field).is_some(), "missing {field}");
        }
    }

    #[test]
    fn body_schemas_round_trip() {
        // The plaintext body schemas serialize and parse (they ride sealed inside
        // the envelope, so only serde correctness matters here).
        let kh = KeyHandoffBody {
            from_ed: "aa".into(),
            from_x25519: "bb".into(),
            label: "phone".into(),
            wrapped_hex: "cc".into(),
        };
        let prop = ProposalBody {
            proposals: vec![DraftProposal {
                event: observation(),
                source_blob: Some("att-deadbeef".into()),
                method: Some("ocr".into()),
                model: Some("m".into()),
            }],
        };
        let admin = AdminCmdBody {
            command: AdminCommand::SetInferenceEndpoint {
                endpoint: "http://inference.internal/v1".into(),
            },
        };
        let chat = ChatMsgBody {
            role: ChatRole::Answer,
            text: "you were prescribed X".into(),
            citations: vec!["ev-1".into(), "ev-2".into()],
        };
        for v in [
            serde_json::to_value(&kh).unwrap(),
            serde_json::to_value(&prop).unwrap(),
            serde_json::to_value(&admin).unwrap(),
            serde_json::to_value(&chat).unwrap(),
        ] {
            // Round-trips through a string without loss.
            let s = v.to_string();
            let back: serde_json::Value = serde_json::from_str(&s).unwrap();
            assert_eq!(v, back);
        }
        // Additive tolerance: an unknown field on a body is ignored, not rejected.
        let mut with_extra = serde_json::to_value(&chat).unwrap();
        with_extra["future_field"] = json!(true);
        let parsed: ChatMsgBody = serde_json::from_value(with_extra).unwrap();
        assert_eq!(parsed, chat);
    }

    #[test]
    fn parse_prefers_typed_envelope() {
        let (_s, _r, msg) = sealed(MessageKind::KeyHandoff, b"body");
        let bytes = serde_json::to_vec(&msg).unwrap();
        match parse_mailbox_item(&bytes).unwrap() {
            MailboxItem::Message(m) => assert!(m.verify()),
            MailboxItem::Legacy(_) => panic!("typed envelope parsed as legacy"),
        }
    }

    #[test]
    fn parse_grandfathers_legacy_deposit() {
        // A bare wrapped-key deposit (today's format) still parses, and the
        // wrapped key inside still opens — the whole point of holding the major
        // fixed.
        let owner = Identity::from_seed(b"owner seed");
        let recipient = Identity::from_seed(b"recipient seed");
        let data_key = DataKey::generate();
        let wrapped = wrap_key(&recipient.x25519_public(), &data_key);
        let legacy = json!({
            "v": 1,
            "from_ed": hex::encode(owner.verifying_key().to_bytes()),
            "from_x25519": hex::encode(owner.x25519_public().as_bytes()),
            "label": "old phone",
            "wrapped_hex": hex::encode(wrapped.to_bytes()),
        });
        let bytes = serde_json::to_vec(&legacy).unwrap();
        match parse_mailbox_item(&bytes).unwrap() {
            MailboxItem::Legacy(dep) => {
                let wrapped =
                    crate::envelope::WrappedKey::from_bytes(&hex::decode(dep.wrapped_hex).unwrap())
                        .unwrap();
                assert!(recipient.unwrap_key(&wrapped).is_ok());
            }
            MailboxItem::Message(_) => panic!("legacy deposit parsed as typed"),
        }
    }

    #[test]
    fn parse_rejects_garbage() {
        assert!(matches!(
            parse_mailbox_item(b"{\"v\":1}"),
            Err(MailboxError::Unrecognized)
        ));
    }

    // --- pinned spec vectors ---

    #[derive(Deserialize)]
    struct VectorFile {
        contract_version: u32,
        messages: Vec<MessageVector>,
        legacy: Vec<LegacyVector>,
    }

    #[derive(Deserialize)]
    struct MessageVector {
        note: String,
        valid: bool,
        /// The full pinned envelope (always present).
        envelope: MailboxMessage,
        /// Rebuild inputs — present only on the valid, freshly-sealed vectors so a
        /// reimplementation can reproduce every byte from seeds and nonces.
        #[serde(default)]
        sender_seed_hex: Option<String>,
        #[serde(default)]
        recipient_seed_hex: Option<String>,
        #[serde(default)]
        recipient_x25519_public_hex: Option<String>,
        #[serde(default)]
        kind: Option<MessageKind>,
        #[serde(default)]
        sent_at: Option<i64>,
        #[serde(default)]
        ephemeral_secret_hex: Option<String>,
        #[serde(default)]
        seal_nonce_hex: Option<String>,
        #[serde(default)]
        body_plaintext_hex: Option<String>,
        #[serde(default)]
        canon_hex: Option<String>,
        #[serde(default)]
        id_hex: Option<String>,
        #[serde(default)]
        signing_bytes_hex: Option<String>,
        #[serde(default)]
        signature_hex: Option<String>,
    }

    #[derive(Deserialize)]
    struct LegacyVector {
        note: String,
        json: serde_json::Value,
        recipient_seed_hex: String,
        unwraps: bool,
    }

    const VECTORS: &str = include_str!("../../../spec/vectors/mailbox.json");

    fn arr32(s: &str) -> [u8; 32] {
        hex::decode(s).unwrap().try_into().unwrap()
    }

    fn arr24(s: &str) -> [u8; 24] {
        hex::decode(s).unwrap().try_into().unwrap()
    }

    #[test]
    fn matches_spec_vectors() {
        let file: VectorFile = serde_json::from_str(VECTORS).expect("parse vectors");
        assert_eq!(
            file.contract_version,
            crate::CONTRACT_VERSION,
            "vectors are pinned to a different contract version"
        );

        for v in &file.messages {
            // Every vector pins the verify() outcome.
            assert_eq!(v.envelope.verify(), v.valid, "verify: {}", v.note);

            // Valid, freshly-sealed vectors additionally pin every derived byte and
            // let a reimplementation reproduce the envelope from seeds + nonces.
            if let Some(sender_seed) = &v.sender_seed_hex {
                let sender = Identity::from_seed(&hex::decode(sender_seed).unwrap());
                let recipient = Identity::from_seed(
                    &hex::decode(v.recipient_seed_hex.as_ref().unwrap()).unwrap(),
                );
                assert_eq!(
                    hex::encode(recipient.x25519_public().as_bytes()),
                    *v.recipient_x25519_public_hex.as_ref().unwrap(),
                    "recipient public: {}",
                    v.note
                );

                let body = hex::decode(v.body_plaintext_hex.as_ref().unwrap()).unwrap();
                let built = MailboxMessage::seal_with(
                    &sender,
                    &recipient.x25519_public(),
                    v.kind.unwrap(),
                    v.sent_at.unwrap(),
                    &body,
                    arr32(v.ephemeral_secret_hex.as_ref().unwrap()),
                    arr24(v.seal_nonce_hex.as_ref().unwrap()),
                );

                assert_eq!(
                    hex::encode(built.canonical_bytes()),
                    *v.canon_hex.as_ref().unwrap(),
                    "canon: {}",
                    v.note
                );
                assert_eq!(
                    hex::encode(built.msg_id()),
                    *v.id_hex.as_ref().unwrap(),
                    "id: {}",
                    v.note
                );
                assert_eq!(
                    hex::encode(built.signing_bytes()),
                    *v.signing_bytes_hex.as_ref().unwrap(),
                    "signing bytes: {}",
                    v.note
                );
                assert_eq!(
                    hex::encode(built.signature),
                    *v.signature_hex.as_ref().unwrap(),
                    "signature: {}",
                    v.note
                );
                // The freshly built envelope equals the pinned one, verifies, and
                // opens back to the plaintext.
                assert_eq!(
                    serde_json::to_value(&built).unwrap(),
                    serde_json::to_value(&v.envelope).unwrap(),
                    "envelope: {}",
                    v.note
                );
                assert!(built.verify(), "built verify: {}", v.note);
                assert_eq!(built.open(&recipient).unwrap(), body, "open: {}", v.note);
            }
        }

        for v in &file.legacy {
            let bytes = serde_json::to_vec(&v.json).unwrap();
            match parse_mailbox_item(&bytes).expect(&v.note) {
                MailboxItem::Legacy(dep) => {
                    let recipient =
                        Identity::from_seed(&hex::decode(&v.recipient_seed_hex).unwrap());
                    let wrapped = crate::envelope::WrappedKey::from_bytes(
                        &hex::decode(&dep.wrapped_hex).unwrap(),
                    )
                    .unwrap();
                    assert_eq!(
                        recipient.unwrap_key(&wrapped).is_ok(),
                        v.unwraps,
                        "legacy unwrap: {}",
                        v.note
                    );
                }
                MailboxItem::Message(_) => panic!("legacy vector parsed as typed: {}", v.note),
            }
        }
    }
}
