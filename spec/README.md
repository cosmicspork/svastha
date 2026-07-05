# Trust contract (spec)

The formal, versioned contract every component agrees on, independent of
language:

- the encryption envelope (key wrapping, payload sealing),
- the event schema,
- the relay wire protocol (auth handshake, blob endpoints).

`crates/core` is the executable contract for the Rust spine and its WASM build.
This directory holds the written spec and language-neutral test vectors, so a
non-Rust reimplementation or an auditor can validate against the same bytes.

`svastha_core::CONTRACT_VERSION` tracks breaking changes; clients and relays
negotiate on it so independently deployed and self-hosted pieces can coexist.

Status: key derivation, the encryption envelope, the event schema, and the relay
wire protocol (auth handshake, blob endpoints, grants, and mailbox) are
specified below.

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

   `{VERSION}` is `CONTRACT_VERSION` (currently `0`, so `svastha/v0/x25519` and
   `svastha/v0/ed25519`). The label embeds the version so a contract bump
   deliberately changes the derived keys. The 32-byte X25519 material is used as
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
   salt so the wrapping is pinned to this exchange; the `info` label embeds
   `{VERSION}` (`CONTRACT_VERSION`, currently `0` → `svastha/v0/wrap`) so a
   contract bump deliberately invalidates old wrappings.
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

## Event schema

The store is an append-only log of typed, immutable, signed facts. An event is
content-addressed (so the same fact from two providers collapses on union) and
signed (so its author and integrity are verifiable). Both rest on one explicit
canonical byte encoding.

An event has a `kind` (one of `observation`, `condition`, `medication_statement`,
`immunization`, `encounter`, `procedure`, `allergy_intolerance`, `document`,
`nutrition_intake`), an optional `code` (a terminology `Code`: `system`, `code`,
optional `display`), an optional ISO-8601 `effective_at`, an optional `value`,
and a `provenance` (`source`, optional `source_doc`). A `value` is one of:

- `quantity` — a decimal-string `value` and an optional UCUM `unit` (`Code`).
  Numbers are strings, never floats, so the bytes are exact and reproducible.
- `coded` — a `Code`.
- `text` — a string.

### Canonical encoding

Fields are encoded into a deterministic byte string:

- **string** → 4-byte big-endian length ‖ UTF-8 bytes.
- **option** → `0x00` if absent, else `0x01` ‖ the value's encoding.
- **`Code`** → `system` ‖ `code` ‖ `display?`.
- **`kind`** → its wire name (the `snake_case` string above), length-prefixed, so
  reordering the enum cannot silently change ids.
- **`value`** → a 1-byte variant tag (`0x00` quantity, `0x01` coded, `0x02` text)
  followed by its fields in the order listed above.

The **canonical content** is `kind ‖ code? ‖ effective_at? ‖ value?`. It excludes
`id` and `provenance`, so a fact reported by two sources canonicalizes identically.

A multi-part fact (a blood pressure reading, a several-item meal) is written as
one event per component sharing an `effective_at`; there are no panel or grouping
events. This is an informative convention — ids do not depend on it.

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
sign( "svastha/v{VERSION}/event" ‖ id ‖ source ‖ source_doc? )
```

where `id` is the 32 raw content-id bytes and `source`/`source_doc?` are the
canonical provenance. Because `id` is a collision-resistant commitment to all
content, signing `id ‖ provenance` covers the whole record. The `svastha/v{VERSION}/event`
prefix is version-tagged and domain-separates event signatures from the relay-auth
handshake and any other Ed25519 use. A `SignedEvent` carries the `event`, the
`author` (Ed25519 public key), and the `signature`, both as hex.

Test vectors: [`vectors/event.json`](vectors/event.json). Each entry pins a
structured `event` → its `canon` bytes and `id`; signed entries add a
`signer_seed`, the `author`, and the (deterministic, RFC 8032) `signature`. Two
entries differ only in provenance to pin the cross-source id collision. Regenerate
with `cargo run -p svastha-core --example event_vectors` (only on a deliberate,
version-bumped contract change).

## Relay wire protocol

The relay is a zero-knowledge store-and-forward server: it holds no keys, stores
only ciphertext and routing metadata, and authenticates every request by an
Ed25519 signature. Authentication is **stateless and per-request** — no sessions,
no server secrets, no nonce store — which keeps the relay a dumb, keyless single
binary anyone can self-host.

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
relay rejects requests outside a small freshness window (a server policy). Within
that window a signed request can still be replayed; since v1 blobs are stored
under the caller's own key, a replay only re-stores the caller's own ciphertext.
A nonce store is a later hardening.

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

A store-and-forward drop box, used to hand a grantee the vault key a grant
alone doesn't carry: the depositor wraps it (ECIES) to the recipient's X25519
key before depositing, so the relay only ever sees ciphertext. Any authed
identity may deposit into any recipient's mailbox — there is nothing to
protect at deposit time, since the payload is opaque and the recipient decides
whether to trust it (see the client-side accept flow in
`docs/ARCHITECTURE.md`). Reading, listing, and deleting are scoped to the
caller's own mailbox.

| Method & path | Auth | Body | Success | Notes |
|---|---|---|---|---|
| `PUT /v0/mailbox/{recipient}/{id}` | yes | ≤ 4 KiB | `204` / `413` | deposit an item for `{recipient}` |
| `GET /v0/mailbox` | yes | — | `200 {"items":[{"id":...,"from":hex}...]}` | list the caller's items |
| `GET /v0/mailbox/{id}` | yes | — | `200` octets / `404` | fetch one, with a `svastha-from: {hex}` response header |
| `DELETE /v0/mailbox/{id}` | yes | — | `204` / `404` | delete one |

`{recipient}` is 64 lowercase hex chars or `400`; `{id}` reuses the blob `{id}`
rule above. The 4 KiB cap is deliberately small: a mailbox item carries one
wrapped vault key plus a small JSON envelope, never anything larger, so the
cap bounds the spam surface without constraining legitimate use. The
`svastha-from` header is the relay's attestation of the depositor's
already-verified auth identity — not a claim the client makes about itself —
which the receiving client then binds to whatever identity the payload itself
claims to be from, so a mismatch is detectable.

The relay is stateless and keyless: it never decrypts, holds no user keys, and
ships as a single static binary for self-hosting. All of the above — blobs,
grants, and mailbox — reuse the one auth handshake; server-side semantics
(the two-404 non-leak rule, the mailbox cap, method routing) are pinned by the
relay's integration tests rather than by test vectors, since none of it changes
the signed bytes.
