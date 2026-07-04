# Architecture

Svastha is a self-custodial, end-to-end-encrypted, local-first personal medical
records system. Your records live encrypted on your devices, sync through a relay
that cannot read them, and are decrypted only by keys derived from a seed phrase
you alone hold.

This document is the source of truth for the design. Read it before changing the
trust contract: the crypto envelope, the event schema, or the relay protocol.

## Principles

- **Self-custody.** Keys are derived from a user-held BIP39 seed. No operator,
  including a hosted Svastha, holds keys or can read records.
- **Zero-knowledge infrastructure.** The relay sees ciphertext and routing
  metadata only. It is a dumb pipe, not a trusted service. Distinguish a
  centralized *service* (the thing to avoid) from centralized *infrastructure* (a
  relay that cannot read anything, which is fine and useful).
- **Local-first.** The app works offline against on-device storage. The network
  is for backup and, later, sync and sharing.
- **Lived data.** The record is not just imported clinical history: self-tracked
  vitals, symptoms, medications, food, and exercise are first-class events in the
  same log, so reactions can be traced back to their inputs. The binding UX
  constraint is entry friction — logging must be fast enough to happen every
  day, or the record never contains the data that makes patterns findable.

## The trust contract (`crates/core`)

`core` is the single source of truth for the security-critical code: the
encryption envelope and the event schema. It compiles to native (relay, node)
and to WASM (web), so this code exists in exactly one place and cannot drift
between a TypeScript client and a Rust server.

`svastha_core::CONTRACT_VERSION` versions the on-the-wire format (envelope, event
schema, relay protocol). Independently deployed and self-hosted pieces will run
different builds, so the version is negotiated and changes are backward
compatible within a major. `spec/` holds the written contract and
language-neutral test vectors so an auditor or a non-Rust reimplementation can
validate against the same bytes.

## Identity and keys

A BIP39 seed phrase derives two keypairs via an HKDF over the seed:

- **X25519** for encryption (wrapping vault keys).
- **Ed25519** for signing (events and the relay auth handshake).

Each device and each person is an identity (a public key). The seed is the one
secret; recovery is social (a caregiver or family member is the backup), which
matters for non-technical and aging users and for jurisdictions where
unrecoverable loss is a problem.

## Vaults and grants

- A **vault** is a collection encrypted with a symmetric data key. It is the unit
  of sharing.
- **Sharing** wraps a vault's data key to a recipient's X25519 public key
  (envelope encryption). The relay never sees an unwrapped key.
- A **grant** generalizes sharing: a filter over events, a recipient, a mode
  (point-in-time snapshot, ongoing feed, or both), and terms (duration,
  revocability, purpose). Family and caregiver access and the future research
  marketplace are the same primitive at different settings. An ongoing grant is a
  subscription to the filtered tail of the append-only log.
- **Revocation** is key rotation: re-wrap to everyone except the revoked party and
  encrypt future events under the new key. It cannot retract already-decrypted
  data, and the UX must say so.
- **Key discovery** is out of band (in-person QR, short verification codes),
  because the sharing graph is mostly people who physically meet.

The first shipped slice of this model is deliberately narrow: **whole-vault,
ongoing, read-only sharing between two people in one household.** Each vault
keeps a single writer — the owner logs, the other person reads — so no
multi-writer merge machinery is needed yet. The relay learns only the grant edge
(routing metadata, consistent with zero-knowledge); the wrapped vault key travels
through a store-and-forward mailbox. Filtered grants, terms, and the research
marketplace remain later work, and revocation is still key rotation with the same
caveat: it cannot retract already-decrypted data, and the UI must say so. (The
relay's grant and mailbox endpoints are specified in the Relay section as that
phase lands.)

## Event model

Most clinical history is immutable history. The store is an append-only log of
typed, signed, stably-identified events, plus a thin mutable curation overlay
(tags, "current medication", corrections).

- Imported facts merge by union and de-duplication. Stable, content-addressed ids
  let the same immunization reported by two providers collapse to one.
- Only the small curation overlay needs conflict resolution (last-writer-wins or
  similar).

This keeps conflict handling light even with multiple concurrent writers (for
example a caregiver and the patient), so a heavyweight CRDT framework is not
required; an encrypted multi-writer event log carries the load.

## Data model and interop

FHIR and C-CDA are interface formats, used only at the boundary. They are too
heavy and nested to be the internal model for a local-first event log. Internally
Svastha keeps a lean, FHIR-informed shape and reuses the standard code systems
(LOINC, RxNorm, SNOMED, CVX).

- **Import.** US EHR exports arrive as Epic C-CDA (in IHE XDM packages) or as FHIR
  R4 bundles. C-CDA converts to FHIR at the boundary (Microsoft FHIR-Converter or
  `srdc/cda2fhir`), then maps into the internal event model. The verbatim source
  document is kept as an immutable provenance blob for re-derivation.
- **India (later).** Document ingestion with on-device OCR (native OS OCR through
  the wrapper for quality, human-in-the-loop for handwriting). ABDM is
  consent-federated rather than self-custodial; it is a future boundary adapter,
  and its consent-artifact schema is prior art for the grant model.

## Relay (`crates/relay`)

A zero-knowledge store-and-forward server (planned: axum + tokio). It stores and
forwards encrypted blobs it cannot read, holds no keys, and only verifies client
auth signatures (Ed25519). It is connection-heavy (clients want a "new data"
push), which suits an async Rust server and ships as a single static binary for
trivial self-hosting. It depends on `core` only for the signature-verify
primitives, not the envelope.

## Node (`crates/node`, later release)

A trusted processing client: it holds keys, syncs plaintext locally, and runs the
OCR, extraction, de-identification, and RAG pipeline. It ships no models. Instead
it delegates inference to a user-supplied OpenAI-compatible endpoint (Ollama, LM
Studio, vLLM, or a cloud endpoint the user explicitly chooses). Running inference
inside the user's own trust boundary is how AI features stay compatible with
zero-knowledge.

## Web (`web`)

A Svelte 5 PWA (bun + Vite), local-first, with on-device storage (IndexedDB). It
consumes `core` over WASM, so the browser runs the exact same envelope code as the
servers. Plain Svelte plus a small router, not SvelteKit (no SSR: the server
cannot read the data). `vite-plugin-pwa` provides the offline shell and
installability (added as the PWA work begins).

## Native (later)

The same web bundle wraps in Capacitor or Tauri (Tauri is Rust and composes with
`core`) when native-only capabilities are needed: Bluetooth medical devices,
Apple HealthKit, Android Health Connect, and good on-device OS OCR. The OS
keystore (Keychain, Keystore) then secures the seed in hardware.

## Self-hosting

Two roles with different trust properties:

- **Relay.** Keyless and dumb. Anyone can run the binary and point a client at it.
  A compromised relay leaks nothing but ciphertext and metadata.
- **Processing node.** A trusted device in the key circle (it holds keys and sees
  plaintext), for running local LLMs on your own hardware, for example a Mac mini.
  It reuses the device-enrollment primitive. Reach it over a private mesh
  (Tailscale, WireGuard), not public port-forwarding. A compromised node leaks
  plaintext, so it must be secured accordingly.

Keep these separate so the hosted relay stays truthfully zero-knowledge while
power users can run everything locally, from the same codebase.

## Roadmap

- **v1 (in progress).** Quick-log lifestyle events (vitals, symptoms, meds, food,
  exercise, notes); local-first PWA with IndexedDB storage and a
  passphrase-wrapped seed at rest (custody scheme specified in the Web section as
  that work lands); encrypted relay backup with multi-device restore from the
  mnemonic (client blob layout documented alongside the sync work);
  single-writer, read-only household sharing (relay grants plus a wrapped-key
  mailbox); client-side import of US EHR exports (Epic C-CDA in IHE XDM packages,
  FHIR R4 bundles) keeping verbatim provenance blobs; correlation timeline over a
  thin last-writer-wins curation overlay.
- **v2.** India document ingestion (OCR, handwriting, human-in-the-loop).
- **Later.** Multi-writer sync, filtered grants and terms (family and caregiver
  access beyond the household pair), the research marketplace, ABDM, native
  device and health-app integration.

## Keep in sync

When the core patterns change, update together:

- This file (`docs/ARCHITECTURE.md`).
- `spec/` (the written contract and test vectors) and
  `svastha_core::CONTRACT_VERSION`.
- The `core` types that implement the contract.
