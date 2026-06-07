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

Status: key derivation, the encryption envelope, and the event schema are
specified below. The relay protocol is documented here as it is implemented.

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
`immunization`, `encounter`, `procedure`, `allergy_intolerance`, `document`), an
optional `code` (a terminology `Code`: `system`, `code`, optional `display`), an
optional ISO-8601 `effective_at`, an optional `value`, and a `provenance`
(`source`, optional `source_doc`). A `value` is one of:

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
