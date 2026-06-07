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

Status: key derivation and the encryption envelope are specified below. The relay
protocol is documented here as it is implemented.

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
