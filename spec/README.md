# Trust contract (spec)

The formal, versioned contract every component agrees on, independent of
language:

- the encryption envelope (key wrapping, payload sealing),
- the event schema,
- the relay wire protocol (auth handshake, blob endpoints).

`crates/core` is the executable contract for the Rust spine and its WASM build.
This directory holds the written spec and language-neutral test vectors, so a
non-Rust reimplementation or an auditor can validate against the same bytes.

Status: key derivation, the encryption envelope, the vault-key keyring (key
epochs), the event schema, the curation record, the typed mailbox message
envelope, and the relay wire protocol (auth handshake, blob endpoints, grants,
mailbox, and shares) are specified below.

## Versioning

Two numbers, deliberately separate:

- **`svastha_core::CONTRACT_VERSION`** — the negotiated **wire** version, reported
  at `GET /v0/info`. Clients and relays read it to negotiate capabilities so
  independently deployed and self-hosted pieces can coexist. It advances
  **additively within a major**: a new envelope kind, a new optional field. It is
  **`2`** as of the node/protocol wave: `1` added the typed mailbox envelope and
  the optional event provenance field, and `2` added key epochs (the vault-key
  keyring); it was `0` through the first release.
- **The contract *major*** — the cryptographic era embedded in every HKDF /
  domain-separation label (`svastha/v{MAJOR}/…`, currently `0`). It bumps **only**
  on a key-rotating break that re-derives every identity and re-wraps every vault
  key.

Holding the major fixed while `CONTRACT_VERSION` advances is the whole point: an
additive wire change must never orphan a vault. Every derived key, wrapped vault
key, and signature made under major `0` stays valid across every version bump —
the concrete meaning of "backward compatible within a major." A change that
*would* invalidate stored material is not additive and belongs to a future major,
not a version bump. (This refines the earlier framing, when the two numbers were
one: the label embeds the **major**, not the wire version.)

Key epochs (version `2`) are the sharpest test of this discipline: rotation adds
new epoch keys, never touching the old ones, and the keyring's byte format is
new — but no *derived* value moves. A legacy single-key `vault.key` still reads
(as epoch 0), every pre-epoch blob still opens under its unchanged genesis key,
and the epoch marker rides in AEAD associated data, not in any signed or derived
preimage. So the pre-existing test vectors are byte-identical across the `1 → 2`
bump except for the `contract_version` field itself.

## Key derivation

An identity is two keypairs derived from one BIP39 seed: **X25519** for
encryption (wrapping vault keys to recipients) and **Ed25519** for signing
(events and the relay auth handshake).

1. **Mnemonic → seed.** Standard BIP39: the mnemonic plus an optional passphrase
   produce a 64-byte seed (PBKDF2-HMAC-SHA512, 2048 rounds, salt
   `"mnemonic" + passphrase`). An empty passphrase is the default.
2. **Seed → keys.** HKDF-SHA256 over the seed (IKM = the 64-byte seed, no salt)
   with a distinct `info` label per key expands to 32 bytes of key material:

   | Key | `info` label | Use |
   |---|---|---|
   | X25519 secret | `svastha/v{VERSION}/x25519` | encryption / key wrapping |
   | Ed25519 secret | `svastha/v{VERSION}/ed25519` | signing / auth |

   `{VERSION}` is the contract **major** (currently `0`, so `svastha/v0/x25519`
   and `svastha/v0/ed25519`) — see "Versioning" above. The label embeds the major
   so a *major* break deliberately changes the derived keys, while an additive
   `CONTRACT_VERSION` bump leaves them untouched. The 32-byte X25519 material is used as
   an `x25519-dalek` `StaticSecret` (clamping happens at DH time); the 32-byte
   Ed25519 material is the `SigningKey` seed.

Test vectors: [`vectors/key-derivation.json`](vectors/key-derivation.json). Each
entry pins `mnemonic` + `passphrase` → `seed_hex` → the two public keys (hex).
The seeds are the canonical BIP39 reference seeds. Regenerate with
`cargo run -p svastha-core --example derive_vectors` (only on a deliberate,
version-bumped contract change).

## Encryption envelope

A vault is encrypted under a symmetric **data key** (256-bit). Two operations,
both using the same AEAD — **XChaCha20-Poly1305** (192-bit nonce, 128-bit tag):

### Payload sealing

Seal a payload under the data key with a random 24-byte nonce. Associated data
(`aad`) is authenticated but not encrypted, so callers can bind context (e.g. an
event id) without revealing it.

```
seal(data_key, plaintext, aad) -> nonce(24) ‖ ciphertext+tag
```

The wire form is the nonce followed by the AEAD ciphertext (the Poly1305 tag is
the last 16 bytes). `open` reverses it and rejects any nonce/key/aad mismatch or
tampering.

### Key wrapping

Wrap the data key to a recipient's X25519 public key (ECIES / sealed-box), so it
can be shared without the relay ever seeing it unwrapped:

1. The sender generates an **ephemeral X25519 keypair** `(e_sk, e_pk)`.
2. `shared = X25519(e_sk, recipient_pk)`.
3. `wrap_key = HKDF-SHA256(ikm = shared, salt = e_pk ‖ recipient_pk,
   info = "svastha/v{VERSION}/wrap")[..32]`. Both public keys are bound into the
   salt so the wrapping is pinned to this exchange; the `info` label embeds the
   contract **major** (currently `0` → `svastha/v0/wrap`, see "Versioning") so a
   *major* break invalidates old wrappings while an additive version bump does
   not — which is exactly what keeps an old wrapped vault key openable across the
   `0 → 1` version bump.
4. Seal the 32-byte data key under `wrap_key` (sealing, above, with empty `aad`).

```
wrap(recipient_pk, data_key) -> e_pk(32) ‖ nonce(24) ‖ ciphertext+tag(48)
```

Unwrap is the mirror: the recipient computes `shared = X25519(recipient_sk, e_pk)`,
re-derives `wrap_key` (it knows its own `recipient_pk`), and opens the sealed key.

Test vectors: [`vectors/envelope.json`](vectors/envelope.json). `sealing` entries
pin `key` + `nonce` + `aad` + `plaintext` → `sealed`; `wrapping` entries pin a
recipient `seed`, `ephemeral_secret`, `nonce`, and `data_key` → `wrapped` (the
recipient seed lets a reimplementation exercise unwrap end-to-end). All bytes are
hex. Regenerate with `cargo run -p svastha-core --example envelope_vectors` (only
on a deliberate, version-bumped contract change).

## Key epochs (the vault keyring)

Revocation is key rotation, and rotation must be real without ever bulk
re-encrypting an append-only log. So the vault key becomes a **keyring** of epoch
keys: the original data key is **epoch 0** (the *genesis* epoch); a rotation mints
a fresh epoch key; new blobs seal under the newest epoch, and existing blobs are
never re-sealed — their epoch key stays in the ring so they keep opening. An
append-only log earns an append-only key history. This was `CONTRACT_VERSION`
`2`; it changes no derived value (see "Versioning").

### Keyring wire format

`vault.key` was a bare `WrappedKey`; it becomes a serialized keyring — every epoch
key wrapped to the owner (the same self-wrapped ECIES construction), concatenated
into one blob, still stored as-is (it is how a restoring device obtains the keys,
so it cannot itself be sealed under them). The container is:

```
"svkr" ‖ format(1) ‖ count(u32)
      ‖ [ epoch_id(16) ‖ created_at(i64) ‖ len(u32) ‖ wrapped_key ]…
```

Integers are big-endian; `wrapped_key` is `WrappedKey` wire bytes. Entries
serialize in canonical order (ascending `(created_at, epoch_id)`), so the same set
of epochs always yields identical `vault.key` bytes. `format` is `1` and revises
only if the *framing* changes, independent of `CONTRACT_VERSION`.

**Grandfathering.** A legacy single-key `vault.key` is a bare `WrappedKey`, which
has no `svkr` prefix. It is read as a one-epoch **genesis** keyring — the same
posture as the mailbox's grandfathered bare wrapped-key deposit. A reader tries the
container first and falls back to the bare-wrapped parse, so nothing an owner
already stored becomes unreadable within the major.

### Opaque, mergeable epoch ids

An epoch id is **opaque** — random for a rotation, a fixed all-zero sentinel for
genesis — never a sequence counter. Ordering lives in the keyring structure
(`created_at`, tie-broken by id), not in the id. Two replicas that rotate
independently therefore mint *distinct* ids instead of colliding on the same
integer, and the fixed genesis id lets two devices that each wrote their own
genesis dedupe to one epoch instead of forking the un-rotated vault.

**Newest selection.** The current epoch (what new blobs seal under) is the maximum
by `(created_at, id)` — deterministic across any replicas holding the same epochs,
so a merged keyring agrees on the current epoch with no shared clock.

**Merge** is the **union of epochs**, keyed on the id. Because no id ever names two
different keys, the union keeps every distinct epoch key and loses none — the
property that lets keyrings from independent sources (or a relay-held `vault.key`
against a local one) reconcile. It is commutative and deterministic: where both
rings carry an id, the entry with the lexicographically greater wrapped bytes wins
(such entries wrap the same key, so the choice affects only the exact bytes).

### Epoch marker in the AAD (backward-compatible)

A sealed blob binds its epoch to the ciphertext through the AEAD **associated
data**, so the relay never sees a rotation marker — it stays as blind to rotation
cadence as to everything else — yet a blob cannot be replayed under the wrong
epoch. The scheme is deliberately backward compatible:

- **Genesis epoch** (id all-zero): `aad = blob_id` — byte-identical to the
  pre-epoch contract (see "Sync and backup" in `docs/ARCHITECTURE.md`), so every
  blob sealed before epochs existed still opens.
- **Any rotated epoch**: `aad = blob_id ‖ 0x1f ‖ epoch_id`. The `0x1f` (ASCII unit
  separator) is outside the relay's blob-id charset `[A-Za-z0-9._-]`, so it can
  never occur inside a blob id — a marked AAD can never collide with the bare AAD
  of some other blob.

The marker is **not stored anywhere**: opening tries each epoch's `(key, aad)`
pair until the AEAD authenticates. Because each epoch has a distinct key, only the
correct pair opens, so trial decryption cannot cross epochs and nothing new
reaches the relay.

### Re-keying grantees

On rotation, each still-trusted grantee is handed the keyring **re-wrapped to
them** (every epoch key unwrapped from the owner and re-wrapped to the grantee's
X25519 key, preserving ids and clocks) through a `key_handoff` message (below).
It can then open every past and current epoch. A revoked identity is simply never
handed the new ring, and its grant edge is deleted. As ever, this cannot retract
what the revoked party already decrypted or the old-epoch material it already
holds — the honest-revocation caveat — but everything sealed *after* the rotation
is beyond it.

Test vectors: [`vectors/keyring.json`](vectors/keyring.json). `genesis_legacy`
pins that a bare single-key `vault.key` parses as genesis and unwraps;
`multi_epoch` pins a genesis-plus-two-rotations keyring's bytes and newest
selection; `rotated_blob` pins a blob sealed under a non-zero epoch with its marked
AAD; `pre_epoch_blob` pins that a bare-AAD blob still opens under genesis; `merge`
pins a union of two independently-rotated replicas and its newest. Regenerate with
`cargo run -p svastha-core --example keyring_vectors` (only on a deliberate,
version-bumped contract change).

## Event schema

The store is an append-only log of typed, immutable, signed facts. An event is
content-addressed (so the same fact from two providers collapses on union) and
signed (so its author and integrity are verifiable). Both rest on one explicit
canonical byte encoding.

An event has a `kind` (one of `observation`, `condition`, `medication_statement`,
`immunization`, `encounter`, `procedure`, `allergy_intolerance`, `document`,
`nutrition_intake`), an optional `code` (a terminology `Code`: `system`, `code`,
optional `display`), an optional ISO-8601 `effective_at`, an optional `value`,
a `provenance` (`source`, optional `source_doc`), and an optional `proposed`
(see "Proposal provenance" below). A `value` is one of:

- `quantity` — a decimal-string `value` and an optional UCUM `unit` (`Code`).
  Numbers are strings, never floats, so the bytes are exact and reproducible.
- `coded` — a `Code`.
- `text` — a string.
- `attachment` — a captured document (e.g. a photographed paper record): a
  `sha256` (lowercase hex of the SHA-256 of the *plaintext* bytes — the content
  address, derivable before encryption so it matches across devices), a `mime`
  string, and an integer byte `size`. The bytes themselves live out of band as a
  content-addressed, vault-sealed blob (the client's `att-{sha256}` namespace —
  an app-level convention documented in `docs/ARCHITECTURE.md`, invisible to the
  relay). Any caption the user typed is **not** a field here: it rides as a
  sibling `text`-valued `document` event sharing the attachment's `effective_at`
  (the multi-part convention below), so it lives where a note's text lives and
  the image event's id stays a pure function of the bytes.

### Canonical encoding

Fields are encoded into a deterministic byte string:

- **string** → 4-byte big-endian length ‖ UTF-8 bytes.
- **option** → `0x00` if absent, else `0x01` ‖ the value's encoding.
- **`Code`** → `system` ‖ `code` ‖ `display?`.
- **`kind`** → its wire name (the `snake_case` string above), length-prefixed, so
  reordering the enum cannot silently change ids.
- **`value`** → a 1-byte variant tag (`0x00` quantity, `0x01` coded, `0x02` text,
  `0x03` attachment) followed by its fields in the order listed above. An
  `attachment` is `sha256` (string) ‖ `mime` (string) ‖ `size`, where `size` is a
  **u64 as 8 big-endian bytes** — the same fixed-width integer encoding the
  relay-auth preimage already uses for its timestamp.

The **canonical content** is `kind ‖ code? ‖ effective_at? ‖ value?`. It excludes
`id`, `provenance`, and `proposed`, so a fact reported by two sources — or the same
fact approved from a proposal versus logged directly — canonicalizes identically.

A multi-part fact (a blood pressure reading, a several-item meal, a paper record's
photo plus its caption, a multi-page capture's N photos) is written as one event
per component sharing an `effective_at`; there are no panel or grouping events.
This is an informative convention — ids do not depend on it.

**Versioning.** Adding the `attachment` variant is an *additive* value shape: it
does not change key derivation, the encryption envelope, the signing preimage
structure, or the relay protocol, and every pre-existing event canonicalizes to
byte-identical output (the new tag appears only in new events). The content-id
domain tag is version-independent by design, so ids are stable regardless. It
therefore needs no *major* bump (which would rotate every derived identity and
HKDF label and orphan every existing vault). New vectors are pinned under the
current major; see "Versioning" at the top.

### Proposal provenance

An event carries an **optional** `proposed` object attesting it began as a
proposal — a draft an owner reviewed and signed (see the typed mailbox envelope
below and `docs/ARCHITECTURE.md`, "Node"):

- `by` — the proposer's Ed25519 identity (hex), e.g. the processing node.
- `source_blob` — the `att-`/`doc-` blob the extraction drew from (optional).
- `method` — the extraction method, e.g. `"ocr"` (optional).
- `model` — the inference model id (optional).

It is **absent on every pre-existing and ordinary self-authored event** and, like
`provenance`, is **excluded from the content id** — so an approved proposal keeps
the same id as the same fact logged directly. Its place in the signing preimage
is the subtle part, specified next.

### Content-addressed id

```
id = SHA-256( "svastha/event-id\0" ‖ canonical_content )
```

The 32-byte hash, lowercase hex. The domain tag is **version-independent** (unlike
the key-derivation and envelope HKDF labels, which embed `CONTRACT_VERSION` to
invalidate on a bump): a fact should keep its identity across a contract bump so
the union/de-dup property survives upgrades.

### Signing

The author signs, with Ed25519:

```
sign( "svastha/v{VERSION}/event" ‖ id ‖ source ‖ source_doc?
      ‖ [ by ‖ source_blob? ‖ method? ‖ model? ]   // ONLY when proposed present
)
```

where `id` is the 32 raw content-id bytes, `source`/`source_doc?` are the
canonical provenance, and `{VERSION}` is the contract **major**. Because `id` is a
collision-resistant commitment to all content, signing `id ‖ provenance` covers
the whole record. A `SignedEvent` carries the `event`, the `author` (Ed25519
public key), and the `signature`, both as hex.

**The `proposed` bracket is appended only when the field is present.** This is a
load-bearing canonicalization invariant: an *absent* `proposed` appends **zero
bytes** — not the `0x00` presence byte an in-struct option uses — so every event
authored before this field existed produces the exact preimage it did before, and
its signature stays valid with no *major* bump. When present, the four fields are
appended (each with the standard length-prefix / option encoding) so the owner's
signature attests to the proposal provenance. Absence and presence are
unambiguous, since a verifier reconstructs the preimage from the event's own
`proposed` field; stripping or forging the field flips the recomputed preimage and
fails verification.

Test vectors: [`vectors/event.json`](vectors/event.json). Each entry pins a
structured `event` → its `canon` bytes and `id`; signed entries add a
`signer_seed`, the `author`, and the (deterministic, RFC 8032) `signature`. Two
entries differ only in provenance to pin the cross-source id collision. The
existing (proposal-free) signed vectors are themselves the guard that an absent
`proposed` changes nothing: they still reproduce byte-for-byte. Regenerate with
`cargo run -p svastha-core --example event_vectors` (only on a deliberate,
version-bumped contract change).

## Curation record

The event log above is immutable; a thin **curation overlay** carries the mutable
state layered on top (tags, hides, notes, favorite quick-log templates, and
concept-level status/name records). Each entry is a small, namespace-defined
value under an app-level key, merged last-writer-wins. `core` is namespace-
agnostic: `key` and `value` are opaque to the contract. The overlay's app-level
conventions (which key namespaces exist, the mutable `cur-*` blob mapping, and its
owner-only-in-v1 sync scope) live in `docs/ARCHITECTURE.md`, "Curation overlay".

A curation record is **signed** — Ed25519, by the same owner identity that signs
events. A record has:

- `key` — the app-level curation key (a UTF-8 string), e.g. `tag:{event_id}`.
- `value` — the namespace-defined payload, an arbitrary JSON value.
- `updated_at` — a plain client clock in **Unix milliseconds** (an `i64`), not a
  signed or server-attested timestamp. It is only the merge ordering key.
- `author` — the writer's 32-byte Ed25519 public key (hex).

### Canonical encoding and signing

The value is first reduced to **canonical JSON**: compact (no incidental
whitespace) with object keys sorted lexicographically, so the same logical value
always encodes to the same bytes regardless of the input key order. The author
then signs, with Ed25519, over this preimage:

```
sign( "svastha/v{VERSION}/curation"    // domain label; VERSION = CONTRACT_VERSION
  ‖ len(key)             ‖ key          // len is u32 big-endian, value UTF-8
  ‖ len(canon(value))    ‖ canon(value) // canonical JSON, length-prefixed
  ‖ updated_at )                        // i64 big-endian (8 bytes)
```

The field encoding (u32-big-endian-length-prefixed strings/bytes, big-endian
fixed-width integers) is exactly the event and relay-auth scheme. `author` is
**not** in the preimage — it is the verification key, the same way a `SignedEvent`
treats its own `author`, so substituting a different `author` still fails
verification (the signature was made by a different key). The `…/curation` domain
label separates these signatures from the `…/event` and `…/relay-auth` ones. A
`SignedCurationRecord` carries all four fields plus the `signature` (hex), in one
**flat** JSON object: `{ key, value, updated_at, author, signature }`.

**Merge (last-writer-wins).** For two records under the same key, the higher
`updated_at` wins; a tie breaks toward the lexicographically greater `author`.
Comparing the raw `author` bytes is identical to comparing their lowercase-hex
form (fixed-width hex is order-preserving). The merge is a pure, deterministic,
commutative tiebreak and does **not** verify signatures: a caller receiving a
record from outside its own vault (a doctor-share bundle) **verifies-or-drops
first**, then merges only what verified.

**Versioning.** Signing a curation record is *additive*: it does not touch key
derivation, the encryption envelope, the signing-preimage structure of events, or
the relay protocol, and no pre-existing wire value changes shape. Like the
`attachment` value shape before it, it therefore needs no *major* bump (which
would rotate every derived identity and HKDF label and orphan every existing
vault). New vectors are pinned under the current major.

Test vectors: [`vectors/curation.json`](vectors/curation.json). One valid record
pins its canonical preimage and deterministic (RFC 8032) signature; three tamper
cases (a mutated `value`, a mutated `key`, and a signature re-attributed to a
wrong `author`) each pin `valid: false`, the outcome a correct verifier must
produce. Regenerate with `cargo run -p svastha-core --example curation_vectors`
(only on a deliberate, version-bumped contract change).

## Mailbox message envelope

Everything new on the store-and-forward mailbox — proposals, node administration,
cited Q&A, and the vault-key handoff that used to be the mailbox's only, implicit
payload — rides one typed, versioned, end-to-end-encrypted **message envelope**.
It is the wave's principal contract addition. The relay is blind to it: the body
is sealed, and the envelope is opaque bytes the relay stores and forwards like any
other mailbox item.

A `MailboxMessage` is a flat JSON object, all byte fields lowercase hex:

```
{ v, kind, from, sent_at, id, body, signature }
```

- `v` — the **envelope version**, a single byte (currently `1`). Distinct from
  `CONTRACT_VERSION`: the envelope shape can revise on its own cadence. It rides in
  the signed bytes, so tampering with it fails verification.
- `kind` — one of `proposal`, `proposal_result`, `admin_cmd`, `admin_reply`,
  `chat_msg`, `key_handoff`. Selects how a recipient interprets the opened body.
- `from` — the sender's 32-byte Ed25519 public key; the envelope is signed by it.
- `sent_at` — the sender's clock in **Unix milliseconds** (an `i64`),
  informational and never trusted for ordering.
- `id` — the 32-byte message id (below), carried so a relay can de-duplicate a
  message it sees more than once (and so cross-relay dedupe is trivial later).
- `body` — the kind-specific plaintext **sealed to the recipient's X25519 key** (a
  sealed box, below).
- `signature` — the 64-byte Ed25519 signature over the signing preimage.

### Sealing the body

The body is sealed to the recipient with the **same ECIES construction as key
wrapping**, generalized from a fixed 32-byte data key to an arbitrary-length
payload — a **sealed box**:

1. The sender generates an ephemeral X25519 keypair `(e_sk, e_pk)`.
2. `shared = X25519(e_sk, recipient_pk)`.
3. `box_key = HKDF-SHA256(ikm = shared, salt = e_pk ‖ recipient_pk,
   info = "svastha/v{MAJOR}/mailbox-box")[..32]`. The label is **domain-separated
   from key wrapping** (`…/wrap`) so a message-seal can never be opened as a
   key-wrap or vice versa, and embeds the contract major like every other label.
4. Seal the plaintext under `box_key` (payload sealing, with empty `aad`).

```
seal_box(recipient_pk, plaintext) -> e_pk(32) ‖ nonce(24) ‖ ciphertext+tag
```

The `body` field is these bytes. Empty `aad` is deliberate: the envelope signature
(below) binds the body to its envelope, so no separate AEAD binding is needed.

### Message id and signing (sealed, then signed)

The **canonical bytes** of the envelope are `v ‖ kind ‖ from ‖ sent_at ‖ body`,
using the contract's standard encoding — a single byte for `v`, length-prefixed
strings/bytes (u32 big-endian length), big-endian fixed-width integers, and `from`
as its 32 raw bytes. `kind` is encoded as its wire name (the `snake_case` string),
length-prefixed, so reordering the enum cannot change ids. `from` **is** included
(a message from a different sender is a different message; there is no
cross-source collapse to preserve, unlike an event's content id).

```
id = SHA-256( "svastha/mailbox-msg-id\0" ‖ canonical_bytes )
```

The id domain tag is **version-independent** (like the event-id tag): a message's
dedupe identity is stable regardless of the build that produced it. The author
then signs, with Ed25519:

```
sign( "svastha/v{MAJOR}/mailbox" ‖ id )
```

Because `id` commits to every field, signing it covers the whole envelope — the
same shape as an event signing its content id. The `…/mailbox` label
domain-separates these from event, curation, and relay-auth signatures.

**Sealed then signed → verify-or-drop before decrypting.** The body is sealed
first; the signature then covers the id, which commits to the sealed body. A
recipient therefore **verifies first and drops on failure**, without the decrypt
path ever running — the same posture as a curation record from a doctor-share
bundle. `verify` recomputes the id from the fields (rejecting a mismatched stored
`id`) and checks the signature against `from`; any tampering with `v`, `kind`,
`from`, `sent_at`, or the sealed `body` changes the recomputed id and fails, and a
wrong `from` is the wrong verification key.

### Body schemas

The sealed plaintext each `kind` carries is defined in `crates/core` (so the node
and the web client share one shape) but is **minimal and additively extensible**:
optional fields default, unknown fields are ignored, so a newer sender can add
fields without breaking an older reader. None of it is signed or hashed by the
envelope — it is opaque sealed bytes to the crypto above.

- `key_handoff` — `{ from_ed, from_x25519, label, wrapped_hex }`. `wrapped_hex` is
  a **wrapped keyring** (the keyring container bytes from "Key epochs" above,
  wrapped to the recipient), or — grandfathered — a bare wrapped vault key, which a
  keyring reader accepts as a one-epoch genesis keyring. This is the typed
  successor to the bare wrapped-key deposit (see grandfathering below).
- `proposal` — `{ proposals: [ { event, source_blob?, method?, model? } … ] }`,
  each `event` an **unsigned but schema-valid** draft the owner signs on approval
  (stamping `proposed`, with `by` = the envelope `from`). The proposer is the
  envelope `from`, not repeated per draft.
- `proposal_result` — `{ proposal_id, accepted: [id…], rejected: [id…] }`: the
  owner's decision echoed to the proposer (event content ids).
- `admin_cmd` — `{ command }`, a tagged owner→node command
  (`set_inference_endpoint`, `job_status`, `log_tail`). The node accepts commands
  only from an identity holding a live grant *it itself* issued; node-global
  administration stays with the host operator.
- `admin_reply` — `{ in_reply_to, ok, detail? }`.
- `chat_msg` — `{ role, text, citations: [event_id…] }`: a retrieval-augmented Q&A
  turn; an answer carries the event ids it cited.

### Grandfathering the bare wrapped-key deposit

Before this envelope, the mailbox carried one implicit payload: a small unsigned
JSON blob with a `wrapped_hex` field (`{ v, from_ed, from_x25519, label,
wrapped_hex }`). That format **still parses within the current major** — a reader
tries the typed envelope first, then falls back to the legacy deposit; the two are
unambiguous (a typed envelope requires `kind`/`from`/`id`/`body`/`signature`, a
legacy one requires `from_ed`/`from_x25519`/`wrapped_hex`, and neither parses as
the other). The wrapped key inside stays openable precisely because the major is
held fixed across the version bump. New senders send a `key_handoff` envelope.

Test vectors: [`vectors/mailbox.json`](vectors/mailbox.json). Two valid,
freshly-sealed vectors (a `key_handoff` and a `proposal`) pin the canonical bytes,
message id, signing bytes, signature, and full envelope, and carry the seeds and
nonces to reproduce every byte and to open the body end-to-end; two tamper cases
(a flipped signature, and a mutated `sent_at` whose stored id no longer matches)
pin `valid: false`; one legacy vector pins that a bare wrapped-key deposit still
parses and unwraps. Regenerate with
`cargo run -p svastha-core --example mailbox_vectors` (only on a deliberate,
version-bumped contract change).

## Relay wire protocol

The relay is a zero-knowledge store-and-forward server: it holds no keys, stores
only ciphertext and routing metadata, and authenticates every request by an
Ed25519 signature. Authentication is **per-request** — no sessions and no server
secrets — which keeps the relay a dumb, keyless single binary anyone can
self-host. The only server-side auth state is an **ephemeral replay guard** (a
nonce store, see the Auth handshake below): it holds no secret and is cleared by
a restart, so it does not compromise that keyless, self-hostable posture.

### Auth handshake

A request is described by its `method`, its `path` (including the query string),
the SHA-256 of its (possibly empty) body, and a Unix-seconds `timestamp`. The
client signs this canonical preimage:

```
"svastha/v{VERSION}/relay-auth"     // domain label; VERSION = CONTRACT_VERSION
  ‖ len(method)  ‖ method           // len is u32 big-endian, value UTF-8
  ‖ len(path)    ‖ path
  ‖ sha256(body)                    // 32 bytes
  ‖ timestamp                       // u64 big-endian
```

Binding the method, path, and body hash means a captured signature cannot be
replayed against a different verb, route, or payload. The `relay-auth` domain
label (distinct from the event signature's `…/event` label) prevents a signature
made for one purpose from being accepted for another. The signature is Ed25519
over these bytes.

Transport: the client sends three hex headers alongside the request —

- `Svastha-Public-Key` — the 32-byte Ed25519 public key (the caller's identity),
- `Svastha-Timestamp` — the same Unix-seconds value bound above,
- `Svastha-Signature` — the 64-byte signature.

The relay recomputes the preimage from the actual request and verifies the
signature against `Svastha-Public-Key`. The signed `timestamp` bounds replay: the
relay rejects requests outside a small freshness window (a server policy).

**Replay guard (nonce store).** Within that freshness window, the relay also
remembers the `Svastha-Signature` of each **state-changing** request (any method
other than `GET`/`HEAD`) and rejects a second request bearing the same signature
as a replay (`401`). Because the preimage binds the method, path, body hash, and
timestamp, and Ed25519 (RFC 8032) is deterministic, a captured request replays
byte-for-byte with the *identical* signature — so the signature itself is the
nonce, and no nonce field is added to the wire format. The signed bytes are
unchanged; this is a server-side policy like the freshness window.

Idempotent reads (`GET`/`HEAD`) are deliberately **not** guarded: replaying one
has no effect — it returns data the caller already holds and reveals nothing new
— and because the signed timestamp is only second-granular, guarding reads would
falsely reject a client that legitimately repeats a listing within the same
second (e.g. two pulls racing on unlock and tab-focus). The guarded surface is
exactly the requests where a replay could ever matter.

A signature is remembered only until its `timestamp` ages out of the window
(after which the freshness check rejects it anyway), so the store holds at most
one window of traffic. It is **in-memory only**: a restart clears it, briefly
reopening replay for still-fresh signatures — accepted deliberately to keep the
relay a keyless single binary with no durable auth state, since the residual
exposure requires replaying a captured live request across the exact moment of a
restart. A client always re-signs each attempt with the current time, so a
genuine retry carries a fresh timestamp (and signature) and is never mistaken for
a replay.

Test vectors: [`vectors/relay-auth.json`](vectors/relay-auth.json). Each entry
pins a `method` + `path` + `body` + `timestamp` + `signer_seed` → the `canon`
preimage, the `public_key`, and the (deterministic, RFC 8032) `signature`; a GET
(empty body) and a PUT (non-empty body) are included. All bytes are hex.
Regenerate with `cargo run -p svastha-core --example relay_auth_vectors` (only on
a deliberate, version-bumped contract change).

### Blob endpoints

All bytes the relay stores are opaque ciphertext; it sees only the owner public
key (from the auth headers) as routing metadata. Storage is scoped per owner, so
one identity can never read another's blobs. Two endpoints are open; the rest
require the auth handshake above.

| Method & path | Auth | Body | Success | Notes |
|---|---|---|---|---|
| `GET /health` | — | — | `200 ok` | liveness |
| `GET /v0/info` | — | — | `200 {"contract_version":N}` | version negotiation |
| `PUT /v0/blobs/{id}` | yes | ciphertext | `204` | store (or replace) a blob |
| `GET /v0/blobs/{id}` | yes | — | `200` octets / `404` | fetch the caller's blob |
| `GET /v0/blobs` | yes | — | `200 {"ids":[...]}` | list the caller's blob ids |
| `DELETE /v0/blobs/{id}` | yes | — | `204` / `404` | delete the caller's blob |

`{id}` is a client-chosen token, `[A-Za-z0-9._-]`, 1–128 chars, and never `.` or
`..` (→ `400`); the request body is capped at 16 MiB (→ `413`). A failed or
missing signature, or a timestamp outside the relay's freshness window, is `401`;
a storage failure is `500`.
Client blob-layout conventions (which ids hold what, and how their contents are
sealed) are app-level and documented in `docs/ARCHITECTURE.md` ("Sync and
backup"); the wire contract here is unchanged by them.

### Grants

A grant is pure routing metadata: it tells the relay "grantee may list and read
owner's blobs," nothing more. The relay still never decrypts anything — a grant
without the wrapped vault key (which travels through the mailbox, below) is
ciphertext-only access. Keys are Ed25519 identities, the same ones the auth
handshake authenticates. All auth-required rows use the same handshake as the
blob endpoints above; there is no separate auth scheme for sharing.

| Method & path | Auth | Body | Success | Notes |
|---|---|---|---|---|
| `PUT /v0/grants/{grantee}` | yes | — | `204` | authorize `{grantee}` to read the caller's shared blobs; idempotent |
| `DELETE /v0/grants/{grantee}` | yes | — | `204` / `404` | revoke |
| `GET /v0/grants` | yes | — | `200 {"grantees":[hex...]}` | who the caller has granted |
| `GET /v0/shared` | yes | — | `200 {"owners":[hex...]}` | who has granted the caller |
| `GET /v0/shared/{owner}/blobs` | yes | — | `200 {"ids":[...]}` / `404` | list `{owner}`'s blob ids, gated on a live grant |
| `GET /v0/shared/{owner}/blobs/{id}` | yes | — | `200` octets / `404` | fetch one of `{owner}`'s blobs, gated on a live grant |

`{grantee}`/`{owner}` are 64 lowercase hex chars (an Ed25519 public key) or
`400`. **A missing grant and a missing blob both answer `404`.** If they
answered differently, a caller could probe an arbitrary public key and learn
from the status code alone whether it grants them access — leaking the sharing
graph, which the relay is otherwise blind to. One status code for "not shared
with you" and "nothing there" keeps that graph unobservable. There are no
write routes under `/v0/shared/*`; a `PUT` or `DELETE` there is `405`.
Revocation stops future reads only — it cannot retract anything the grantee
already synced to their device; the client is responsible for saying so.

### Mailbox

A store-and-forward drop box. Deposits are opaque to the relay: a depositor seals
the payload to the recipient's X25519 key before depositing, so the relay only
ever sees ciphertext. Every new deposit is a typed **mailbox message envelope**
(see "Mailbox message envelope" above) — proposals, node admin, chat, and the
`key_handoff` that carries a wrapped vault key; a bare wrapped-key deposit
(today's pre-envelope format) is still accepted and grandfathered client-side. The
relay treats all of these identically: opaque bytes it routes by recipient. Any
authed identity may deposit into any recipient's mailbox — there is nothing to
protect at deposit time, since the payload is opaque and the recipient
verifies-or-drops and decides whether to trust it (see the client-side accept flow
in `docs/ARCHITECTURE.md`). Reading, listing, and deleting are scoped to the
caller's own mailbox.

| Method & path | Auth | Body | Success | Notes |
|---|---|---|---|---|
| `PUT /v0/mailbox/{recipient}/{id}` | yes | ≤ 4 KiB | `204` / `413` | deposit an item for `{recipient}` |
| `GET /v0/mailbox` | yes | — | `200 {"items":[{"id":...,"from":hex}...]}` | list the caller's items |
| `GET /v0/mailbox/{id}` | yes | — | `200` octets / `404` | fetch one, with a `svastha-from: {hex}` response header |
| `DELETE /v0/mailbox/{id}` | yes | — | `204` / `404` | delete one |

`{recipient}` is 64 lowercase hex chars or `400`; `{id}` reuses the blob `{id}`
rule above. The 4 KiB cap is deliberately small: a mailbox item carries a typed
envelope whose sealed body is a wrapped key, a small proposal batch, or a chat
turn, never anything larger, so the cap bounds the spam surface without
constraining legitimate use. The
`svastha-from` header is the relay's attestation of the depositor's
already-verified auth identity — not a claim the client makes about itself —
which the receiving client then binds to whatever identity the payload itself
claims to be from, so a mismatch is detectable.

### Push channel

The pull endpoints above (blob list, mailbox list) are the single source of
truth for what a client holds. On top of them, one long-lived endpoint lets the
relay **poke** a connected client to pull sooner, instead of waiting for its
poll timer:

| Method & path | Auth | Body | Success | Notes |
|---|---|---|---|---|
| `GET /v0/events` | yes | — | `200` `text/event-stream` | long-lived stream of payload-free pokes for the authed caller |

The stream carries **payload-free pokes only** — Server-Sent Events whose
`event:` field names *which* pull to run (`blobs` or `mailbox`), with a single
non-informative `data:` byte. A poke never carries a blob id, count, owner, or
any content, so the push channel reveals nothing the relay does not already
route, and stays as zero-knowledge as every other endpoint. Authentication is
the ordinary handshake above; because native `EventSource` cannot set request
headers, a client opens the stream with fetch-streaming (a normal `GET` whose
body it reads incrementally), so nothing endpoint-specific is added.

The channel is **lossy by design and carries no delivery guarantee.** The pull
path remains authoritative, so a dropped poke costs nothing — the client
discovers the change on its next pull regardless (on unlock, on a timer, on tab
focus). The relay buffers nothing for a disconnected client and never replays
missed pokes; a poke reaches only a stream connected at the instant it fires.
A client that has fallen behind may receive a generic `sync` poke (pull
everything) in place of the specific ones it missed.

The relay pokes an identity when something it can pull changes: a **`mailbox`**
poke to a recipient when an item is deposited for it, and a **`blobs`** poke to a
blob owner's own other streams *and* to every identity holding a live grant on
that vault when a blob is written or deleted. Which identities can read a vault
is grant metadata the relay already holds, so poking them leaks nothing new.

A **heartbeat** comment (`:`), sent roughly every 30 seconds, keeps the idle
connection alive across intermediaries that close a quiet stream (commonly after
~60 seconds); it is a payload-free SSE comment, never content. An operator
terminating TLS or load-balancing in front of the relay must set the proxy
read/idle timeout above the heartbeat interval so the stream is not severed
mid-life.

### Shares

A **share** lets a record owner hand a subset of their history to a doctor (or
anyone) who has no Svastha identity. The owner builds the subset client-side,
re-encrypts it under a fresh per-share key, and uploads the result as one sealed
**bundle**; the recipient opens a link and fetches the bundle by an unguessable
bearer **token**. The relay stays zero-knowledge: the bundle is opaque
ciphertext like every other byte it holds, and the per-share key that decrypts
it travels only in the link's URL *fragment* (`#…`), which browsers never send
to the server — so it never reaches the relay.

The bundle's internal structure is app-level (opaque to the relay, documented in
`docs/ARCHITECTURE.md`). A bundle **MAY** carry an optional `curation` array of
`SignedCurationRecord`s (see "Curation record" above) alongside its `events`, so
a share can include the owner's per-concept **status** (current/past,
active/resolved) and **name** overrides:

- Only the `status:` and `name:` namespaces cross the vault boundary — never
  `tag:`/`hide:`/`note:`/`fav:` (the owner's private working state) — and only
  for a concept some event in the same bundle folds into. A record for an
  excluded concept is never carried, so the array cannot leak the shape of what
  the scope left out.
- The recipient **verifies each record's signature against the bundle's declared
  `signer`** — the same signer every event's `author` is pinned to — and **drops
  (and counts) any that fail**, exactly as it does a tampered or spliced event.
  A record whose `author` is not the signer, or that carries no signature, is
  dropped; a share recipient outside the vault cannot grandfather an unsigned
  record the way a device merging its own vault can.

The field is optional and additive: a bundle from before it existed omits it and
opens identically, and a recipient that predates it ignores the unknown field.
This is the reason the curation record is signed and its verification lives in
the trust contract.

| Method & path | Auth | Body | Success | Notes |
|---|---|---|---|---|
| `PUT /v0/share/{token}` | yes | sealed bundle | `204` / `413` | create or replace; expiry via the `Svastha-Share-Expires` header, clamped |
| `GET /v0/share/{token}` | — | — | `200` octets / `410` / `404` | **unauthenticated** fetch by bearer token |
| `DELETE /v0/share/{token}` | yes | — | `204` / `404` | revoke; the caller must be the stored owner |

`{token}` reuses the blob `{id}` charset rule (`[A-Za-z0-9._-]`, never `.` or
`..`) and must **additionally be ≥ 22 chars** — about 128 bits of entropy over
that 64-symbol alphabet when the client fills it from a CSPRNG — because the read
path is unauthenticated, so the token *is* the credential. A shorter or
malformed token is `400`.

**Expiry.** The owner's desired expiry rides the `Svastha-Share-Expires` request
header (Unix seconds). The relay **clamps** it to at most **30 days** from now,
and defaults to that ceiling if the header is absent or unparseable. (The client
picks a shorter default — 7 days — which is a client concern.) The header is
advisory metadata, not part of the signed request preimage; the clamp is what
bounds how long an unauthenticated bearer link can keep working.

**Size cap.** The bundle is capped at **8 MiB** (→ `413`), distinct from and
below the 16 MiB blob `MAX_BODY`: a share is a re-encrypted subset built for one
recipient, not a whole vault, so it gets its own, tighter ceiling.

**Status codes.** `GET` answers `200` for a valid share; `410 Gone` for an
expired share (lazily detected on access — the relay deletes the bundle bytes
and leaves a tombstone) or a revoked one; and `404` for a token that never
existed. **This `410`/`404` distinction deliberately diverges from the grants'
two-404 non-leak rule: a share token is an unguessable ≥128-bit bearer secret,
so only someone handed the link can probe it, and the distinction materially
improves the recipient's error message** ("this share ended" versus "no such
link"). `DELETE` is owner-only: a caller who is not the stored owner receives the
same `404` as a token that never existed, the non-leak posture the `/v0/shared/*`
routes use for unauthorized access. A token, once used, is **bound to its
creating owner** — live or tombstoned — so a `PUT` by any other authenticated
identity also answers `404` rather than replacing (or squatting on) the share.

Revoke and expiry both drop the bundle bytes and leave a small **tombstone**
(token, owner, reason — `expired` or `revoked` — and timestamp) so the `410`/`404`
split survives after the content is gone; tombstones older than 90 days are
swept. The relay has no periodic-task machinery, so expiry is caught lazily on
`GET` and a sweep also runs on startup. Both expiry and revocation stop *future*
fetches only — neither can recall a bundle a recipient already pulled, and the
client is responsible for saying so.

**What the relay learns.** For a share it sees that the token exists, the owner's
identity (from the authenticated `PUT`/`DELETE`), the bundle's byte size, its
timestamps (created, expiry, and any revocation), and fetch traffic (that some
bearer hit the link, and when). It never learns the bundle's content, its scope
(which events the owner chose to include), or the recipient's identity — the
recipient authenticates with nothing, and the decryption key never reaches the
relay.

The relay is keyless and holds no durable server state beyond the blobs, grants,
mailbox items, and shares themselves: it never decrypts, holds no user keys, and
ships as a single static binary for self-hosting (the auth replay guard and the
push-channel hub are ephemeral in-memory state, not secrets, cleared by a
restart). All of the above — blobs, grants, mailbox, shares, and the event
stream — reuse the one auth handshake, except the share *read*, the system's
only unauthenticated endpoint (its bearer token stands in for auth). Server-side
semantics (the two-404 non-leak rule and the share read's deliberate `410`/`404`
exception to it, the mailbox and share caps, the expiry clamp, the replay-guard
rejection, the payload-free/lossy push channel, method routing) are pinned by the
relay's integration tests rather than by test vectors, since none of it changes
the signed bytes.
