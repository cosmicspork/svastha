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
  is for backup, sync, and sharing.
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
through a store-and-forward mailbox. Richer grant terms and the research
marketplace remain later work, and revocation is still key rotation with the same
caveat: it cannot retract already-decrypted data, and the UI must say so. (The
relay's grant and mailbox endpoints are specified in the Relay section below;
the wire contract is in `spec/README.md`.)

The second shipped slice is the **doctor share**: a *scoped, point-in-time*
share for a recipient with no Svastha identity — the person across the desk at
an appointment. The owner filters the record client-side (categories and a date
range), re-seals the subset under a fresh per-share key, and uploads it as one
sealed bundle the recipient fetches with an unguessable bearer token; the
per-share key travels only in the link's URL fragment (rendered as a QR
client-side), which browsers never send to any server. The vault key never
moves, and the relay holds only opaque ciphertext either way. Shares expire (7
days by default; the relay clamps and eventually sweeps them) and can be revoked
early, with the standard caveat that revocation cannot retract what was already
opened. Grants and shares are different trust shapes on the same zero-knowledge
relay: a grant is an ongoing feed to a *keyed* identity, a share is a bounded
handoff to a *keyless* one. The wire contract is `spec/README.md`'s "Shares"
section.

A share bundle also carries the owner's per-concept **curation** — the `status:`
(current/past, active/resolved) and `name:` overrides for the concepts its
events fold into — as signed records alongside the events, so the recipient's
clinician summary shows the owner's real current-vs-past list and display-name
overrides, not a flat all-active guess. Only those two namespaces cross the
boundary (never tags, hides, notes, or favorites), and only for concepts
actually in the bundle. The recipient **verifies each record against the same
signer that signed the events and drops any that fail** — the point of signing
curation: a keyless recipient holds the per-share key but is not the author, so
only a signature, not the AEAD seal, can attest a record wasn't tampered with in
transit. The create side excludes past-medication events by default (a
current-only list), with an opt-in to include them; resolved problems always
ride along, since a resolved problem is informative history.

Identity exchange for this slice is a single self-describing code —
`svastha1:{ed25519_hex}:{x25519_hex}:{label}` — shown as a QR and as
selectable text, exchanged out of band (in person, or over a channel both
people already trust) and pasted into the other person's Share screen. Neither
key is secret; what the code saves is transcription, and a short fingerprint
(derived from the Ed25519 key) lets both sides confirm they exchanged the
right code before granting anything.

## Event model

Most clinical history is immutable history. The store is an append-only log of
typed, signed, stably-identified events, plus a thin mutable curation overlay
(tags, "current medication", corrections).

- Imported facts merge by union and de-duplication. Stable, content-addressed ids
  let the same immunization reported by two providers collapse to one.
- Self-tracked lifestyle data lives in the same log: symptoms, vitals, and
  exercise are observations, food is a `nutrition_intake` event, and a
  multi-part entry (a blood pressure reading, a several-item meal) is one event
  per component sharing an `effective_at` — grouping is presentational.
- Only the small curation overlay needs conflict resolution (last-writer-wins or
  similar).

This keeps conflict handling light even with multiple concurrent writers (for
example a caregiver and the patient), so a heavyweight CRDT framework is not
required; an encrypted multi-writer event log carries the load.

### Curation overlay

The event log above is append-only by design (immutable clinical history), but
the whole point of logging lifestyle data is to look back and spot a pattern —
which needs a little bit of mutable state layered on top: tags, hides, and
notes on individual events, plus favorite quick-log templates. Unlike the
immutable event log, this overlay is mutable and merged last-writer-wins — but,
like an event, each record is now **signed** by the owner identity, so the
record type, its canonical serialization, signing, verification, and the merge
rule live in the trust contract (`crates/core`, `curation.rs`), shared by every
client through WASM. The web client (`web/src/lib/curation.ts`) still owns the
app-level conventions: which key namespaces exist, the mutable `cur-*` blob
mapping, on-device storage, and the sync scope.

A `SignedCurationRecord` is a `CurationRecord` — `{ key, value, updated_at,
author }` — plus a `signature`:

- `key` namespaces what's being curated: `tag:{event_id}` (`{ tags: string[]
  }`), `note:{event_id}` (`{ text }`), `hide:{event_id}` (`{ hidden: true }`),
  and `fav:{category}:{hash}` (a favorited draft template, keyed on a hash of
  its label — see below). The web client also curates folded *clinical
  concepts* (every event sharing a `{kind}|{system}|{code}`, the summary's
  grouping key): `status:{kind}|{system}|{code}` (`{ status: 'active' |
  'inactive' }` — a medication's current/past or a problem's active/resolved,
  defaulting to active) and `name:{kind}|{system}|{code}` (`{ display }` — the
  owner's display-name override, the top of the render-time name chain above
  the event's own display, the vault name index, and the dictionary; a cleared
  override is an empty display, not a delete, since the sync model has none).
  `core` is namespace-agnostic — the key is an opaque string to the contract,
  so new namespaces need no contract change.
- `value` is namespace-defined and opaque to both the signature and the merge
  rule below. For signing it is reduced to canonical JSON (compact, object keys
  sorted), so the same logical value always signs identically.
- `updated_at` is a plain client clock (unix milliseconds), not a signed or
  server-attested timestamp; it is the merge ordering key.
- `author` is the writer's Ed25519 hex identity — both the key the signature
  verifies against and the merge tiebreaker.

**Merge rule: last-writer-wins.** Whichever record has the higher `updated_at`
wins; a tie breaks on the lexicographically greater `author` hex. This is
deterministic (every device that sees the same two records computes the same
winner) without a shared clock, a negotiation round trip, or CRDT machinery —
appropriate for a field this small (a tag list, a boolean, a short note). The
merge is a pure function in `core`, shared by every client, and it does **not**
verify signatures — a caller receiving records from outside its own vault
verifies-or-drops first, then merges only what verified.

**Now signed.** Every other record in this system is signed, and curation
records now are too, for two reasons the earlier single-writer design could
defer. First, curation **crosses the vault boundary**: a doctor-share
bundle optionally carries a `curation` array so a share can include the owner's
per-concept status and name overrides (see the doctor-share paragraph above),
and the recipient — who holds the per-share key but is not the author — must be
able to reject a record the bundle-builder tampered with. The AEAD seal that authenticated a `cur-*` blob inside the owner's
own vault says nothing to a recipient outside it; only a signature does.
Second, **multi-writer vaults** are on the roadmap, where two writers sharing one
vault key can no longer be told apart by `author` alone — the exact assumption
the old "deliberately unsigned" design flagged to revisit. This wave is that
revisit: signing by the same owner identity that signs events settles both,
and puts the record type, its canonical bytes, sign, verify, and merge in the
trust contract so web and any future client share one implementation.

**Adoption and migration.** The web client signs every curation write and, on
pull, **verifies-or-drops**: a record bearing a signature that fails
verification is dropped (the point of signing — a share recipient or a second
writer can no longer trust the AEAD seal alone), while a record with no
signature is **grandfathered** through the LWW merge (a device that predates
signing may still be pushing unsigned records) and re-signed on its next local
write. A one-time migration, run on first unlock after the update, re-signs
every pre-signing local record **in place**: because `sign_curation` stamps
`author` from the identity, only a record the owner already authored is
touched, and its `updated_at` and `author` are preserved exactly — content
identical, a signature added. That preservation is what makes the migration
LWW-safe: when the re-signed blob is re-pushed over its existing `cur-` id, a
concurrent device sees an exact merge tie (same `updated_at`, same `author`),
so the migration can never be read as a newer write nor override a genuinely
newer edit made elsewhere. The merge itself stays a pure function shared with
`core` (the web client keeps a TS twin rather than calling the wasm binding
per-merge, so it can also merge a still-unsigned record during the transition,
which the signature-requiring binding cannot).

**Sync.** Curation records use the `cur-{sha256_hex(key)}` blob id (see the
namespace table below) and, unlike `ev-`/`doc-` blobs, are **mutable**: a
write `PUT`s over the existing blob rather than minting a new id. Pull fetches
every `cur-*` id and LWW-merges each into the local `curation` store; if the
remote record loses the merge, the local (winning) record is re-enqueued for
push so the relay converges on the true winner instead of serving a stale
value forever. Curation is scoped at hundreds of records even for a
years-long, heavily-tagged log, so a full-listing pull (no pagination, no
per-blob etag) is adequate for v1; both are natural future hardening as the
"no manifest" section below already flags for the `ev-`/`doc-` namespaces.

**Owner-only in v1.** Shared (read-only household) pulls fetch only `ev-*` and
`att-*` blobs (the record and the captured documents its events point at) — a
household grant never touches `cur-*`. The owner's tags, hides, and notes are
their own working state, not something to project onto someone reading their
shared record. The one exception is the *doctor share*, which bundles the
owner's `status:`/`name:` records for the shared concepts inside the sealed
bundle (not via a `cur-*` pull) so the clinician summary reads correctly; tags,
hides, notes, and favorites still never leave the vault.

**Favorites migration.** Favorited quick-log templates used to live in a
single device-local `prefs` key; they now live under `fav:` curation records
so they follow the person to a second device the same way tags do. A one-time
migration copies any pre-existing favorites over the first time curation
loads; the old `prefs` key is left in place afterward (harmless dead data)
rather than deleted, since deleting it buys nothing and risks a data-loss bug
for no benefit.

## Data model and interop

FHIR and C-CDA are interface formats, used only at the boundary. They are too
heavy and nested to be the internal model for a local-first event log. Internally
Svastha keeps a lean, FHIR-informed shape and reuses the standard code systems
(LOINC, RxNorm, SNOMED, CVX).

**Code display names are resolved at render time, never written back.** A
`Code`'s `display` string is part of the signed canonical content, so touching
it on a stored event would mint a new id — and most imported codes arrive with
no display at all. The web client therefore layers name resolution entirely in
presentation: the event's own display → the same code named elsewhere in the
vault → an **optional, opt-in offline dictionary** → the raw `system code`
fallback. The dictionary is downloaded wholesale from the app's own origin and
consulted only in memory — there is never a per-code or third-party lookup,
because which codes a vault holds is itself health data. It bundles only
freely-redistributable terminologies (LOINC, RxNorm's prescribable subset,
ICD-10-CM, CVX); SNOMED CT and CPT names are excluded on licensing grounds and
fall through to the earlier layers.

- **Import.** US EHR exports arrive as Epic C-CDA (in IHE XDM packages, one
  Continuity of Care Document plus many per-encounter Summary of Care documents)
  or as FHIR R4 bundles (e.g. FollowMyHealth). Import runs entirely client-side,
  so the previously-imagined server-side converters (Microsoft FHIR-Converter,
  `srdc/cda2fhir` — both .NET/JVM, neither runs in-browser) aren't the shape:
  instead `crates/import` maps C-CDA and FHIR directly into the internal event
  model in Rust, compiled to WASM alongside the rest of the trust contract
  (`crates/wasm`). Content-addressed event ids mean re-import and cross-org
  overlap (the same fact reported by several per-encounter documents) collapse
  by union automatically, no separate reconciliation step needed. The verbatim
  source document is still kept, as an encrypted provenance blob (`doc-*`, see
  "Sync and backup" below) — the mapping will keep improving, and the blob is
  what lets a fact be re-derived later without the original export. An
  imported entry's detail panel can open that blob in the same viewer captured
  paper records use, so the original C-CDA/FHIR document stays one tap away.

  Import is not only structured facts: the narrative sections a clinician
  actually writes (plan of care, assessment, reason for visit, physical
  findings, progress notes) map to `document` events with text values, dated to
  the visit they describe, so the prose context travels with the coded record.

  `crates/import` is deliberately its own crate, not part of `core`: EHR mapping
  is churny domain logic (new section quirks, evolving code-system tables) that
  will keep changing long after the trust contract is frozen, and `core` stays
  the frozen audit surface — the canonical encoding and content-id rules never
  move to accommodate a parser fix.
- **Paper records.** A handed-over paper document (a specialist's notes, a
  printed med list — the common case in India) is photographed in the app and
  downscaled on-device, or a PDF the user was sent is attached raw; either is
  stored as a `document` event whose `attachment` value content-addresses the
  encrypted blob (`att-*`, see "Sync and backup" below); a caption rides as a
  sibling text event. The photo or PDF is a first-class record — synced,
  exported, viewable in-app (PDFs render via a lazy-loaded pdf.js), and
  includable in doctor shares. **OCR stays out of the web app by design**: reading the
  photo's contents belongs to native OS OCR through the wrapper or the
  processing node (human-in-the-loop for handwriting), inside the user's trust
  boundary.
- **India (later).** ABDM is consent-federated rather than self-custodial; it is
  a future boundary adapter, and its consent-artifact schema is prior art for
  the grant model.

## Relay (`crates/relay`)

A zero-knowledge store-and-forward server (axum + tokio). It stores and
forwards encrypted blobs it cannot read, holds no keys, and only verifies client
auth signatures (Ed25519). It is connection-heavy (clients want a "new data"
push), which suits an async Rust server and ships as a single static binary for
trivial self-hosting. It depends on `core` only for the signature-verify
primitives, not the envelope.

**Grants and mailbox.** Household sharing adds two more stores alongside blobs,
both still pure routing metadata: a grant store (owner authorizes grantee to
read, queried in both directions so a device can list who it shares with and
who shares with it) and a mailbox store (a store-and-forward drop box any
authed identity may deposit into, used to hand a grantee the wrapped vault key
a grant alone doesn't carry). `GET /v0/shared/{owner}/blobs...` answers `404`
identically for "no such blob" and "no grant," so probing never leaks the
sharing graph. See `spec/README.md`'s "Grants" and "Mailbox" subsections for
the endpoint contract.

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
installability.

**Seed custody.** The mnemonic is passphrase-wrapped at rest, not stored in the
clear: a passphrase runs through PBKDF2-SHA256 (600,000 iterations, a random
16-byte salt) to derive a 32-byte key, which seals the mnemonic as a `core`
envelope (`DataKey::seal`). The vault data key is sealed the same way, under the
same derived key, so unlocking recovers both in one KDF pass. A third sealed
record — a fixed check sentinel — lets the app tell "wrong passphrase" apart
from any other failure without touching the mnemonic or vault key. The BIP39
mnemonic passphrase itself is deliberately left empty: the unlock passphrase is
a local wrapping secret for this device's keyvault, not part of the seed →
identity derivation, so changing or forgetting it never changes the identity.
The local event store is plaintext by design — origin isolation and OS disk
encryption are the boundary for now; OS-keystore hardening (Keychain, Keystore)
arrives with the native wrapper. The mnemonic remains the sole recovery root: it
is the only material that reconstructs the identity if the passphrase and this
device are both lost.

The unlock secret is just an opaque 32 bytes, so an alternative source of those
bytes is a drop-in — this is what lets a **passkey** unlock the vault without any
change to the trust contract (the envelope, event schema, and relay protocol are
untouched; passkeys touch only local at-rest wrapping). A platform passkey
derives a stable 32-byte secret via the WebAuthn **PRF extension** (user
verification required — the PRF output is UV-scoped, so relaxing it would change
the secret), HKDF'd for domain separation. A passkey is always an *alternative*,
never a replacement: the passphrase remains a valid unlock and the mnemonic
remains the sole recovery root.

Adding a passkey needs more than a second wrapping of the vault key, because the
vault key is periodically resealed when a device adopts a relay-won key (see
"Vault-key reconciliation" below) — a second independent copy would drift stale
and could seal events under a discarded key. So a device with any passkey moves
to a **master-key (MK) indirection** (an on-disk `format` marker, `v1` → `v2`): a
random per-device MK seals one canonical copy of the mnemonic/vault-key/check
records, and every unlock method (the passphrase, each passkey) stores MK wrapped
under its own secret. Adopting a relay-won key reseals the single canonical copy,
so no method ever drifts. New vaults are born `v1`; a device migrates to `v2` the
first time it enrolls a passkey.

The migration is strictly additive until one commit point so a crash can never
brick the vault: write the MK-sealed canonicals at *new* store keys plus the
`mk:*` wraps, flip the `format` marker (the commit), then delete the `v1`
records. A crash before the flip leaves `v1` intact and re-derivable from the
passphrase; a crash after leaves a working `v2` vault plus stale `v1` records the
`v2` path ignores and clears on the next unlock. This additive-then-commit-then-
delete pattern is the required shape for any future keyvault format bump. Every
record carries its own AEAD associated data, and the passkey wraps bind the
credential id into theirs. The at-rest keyvault format lives entirely in the web
client (`web/src/lib/keyvault.ts`); it is below the wire contract, so it needs no
`spec/` or `CONTRACT_VERSION` change.

## Sync and backup (web)

Every signed event is sealed under the vault data key and pushed to the relay,
so a second device (or a wiped one) restores the whole record from the mnemonic
plus a relay URL. The relay's wire contract (`spec/README.md`) is unchanged by
all of this: the conventions below are app-level agreements about what blob ids
mean, invisible to the relay itself.

**Blob namespaces.** Blob ids are client-chosen; the web client partitions them
by prefix:

| Blob id | Contents |
|---|---|
| `ev-{event_id_hex}` | one sealed `SignedEvent` (JSON) |
| `vault.key` | the vault data key, wrapped to the owner's own X25519 key |
| `doc-{sha256_hex}` | one imported source document's verbatim bytes (name + base64 bytes, JSON), keyed by its own content hash |
| `att-{sha256_hex}` | one captured document's bytes (mime + base64 bytes, JSON — a photographed paper record or an attached PDF), keyed by the plaintext content hash the event's `attachment` value carries |
| `cur-{sha256_hex(key)}` | one sealed `SignedCurationRecord` (JSON — tag/note/hide/favorite, see the Event model's "Curation overlay" subsection), keyed by the hash of its own app-level `key`. Unlike `ev-`/`doc-`/`att-`, this blob is **mutable**: a write `PUT`s over the existing id rather than minting a new one. |

**AAD = blob id.** Every blob sealed under the vault key uses the UTF-8 bytes
of its own blob id as the AEAD associated data. The relay stores opaque
ciphertext under ids it controls the routing of, so without this binding it
could serve blob A's ciphertext under blob B's id undetected; with it, any such
swap fails authentication at open time. For `ev-` blobs the embedded event id
is additionally checked against the blob-id suffix after opening, and the event
signature must verify — a malicious relay cannot inject or substitute events.

**Self-wrapped vault key.** `vault.key` is the vault data key wrapped to the
owner's own X25519 public key with the envelope's standard `wrap_key` — the
same ECIES construction used for sharing, with the owner as recipient. A
wrapped key is already end-to-end protected, so it is stored as-is with no
extra sealing (it could not be sealed under the vault key anyway: it *is* how
a restoring device obtains that key).

**No manifest.** The log is append-only and events are content-addressed, so
`GET /v0/blobs` plus a local diff converges on its own: anything remote and
unknown locally is pulled; any local event absent from the remote list is
pushed. A manifest would add nothing except a mutable thing to keep consistent.
Listing is unpaginated today; pagination is a future hardening as logs grow.

**Push and pull triggers.** Push happens on write: logging events enqueues
their blobs in a local outbox (the IndexedDB `sync` store) and drains it
immediately, with capped exponential backoff on failure and a pause while
offline. Pull happens on unlock, every five minutes while unlocked, and when
the tab becomes visible again; each pull also runs the reconcile diff above,
which is what makes two devices restored from the same mnemonic converge after
logging on both.

**Vault-key reconciliation is first, always.** Connecting a relay runs the
`vault.key` handshake before the sync engine starts: if the relay already holds
one for this identity, the device unwraps and adopts it (re-sealing its local
keyvault record under the adopted key); if not, the device publishes its own.
Effectively first-writer-wins: whichever device publishes first is the key
every later device adopts. If two fresh devices race the publish itself, the
last `PUT` sticks (blobs are replace-on-put; there is no compare-and-swap) and
the other adopts it on its next connect — acceptable for v1 because the
enforced ordering (no event push before this handshake) guarantees no events
are ever sealed under the discarded key.

**Export files.** The encrypted export is a single JSON container of the same
sealed blobs the relay stores — same namespaces, same AAD = blob id binding —
plus the self-wrapped vault key. Importing it therefore runs the identical
open/verify/LWW path as a relay pull and dedupes by content id automatically:
`ev-`/`doc-`/`att-` blobs land as new or are skipped as duplicates, `cur-` blobs
merge by LWW. Import requires the same seed — the wrapped vault key must unwrap, which
only the owning identity can do — and blobs open under the file's own key, so a
backup made before a relay-won key adoption still restores (a differing session
key is reported, never a rejection). The plaintext export is one-way out and can
never be imported (it carries no sealed bytes). The container is app-level
packaging of bytes the wire contract already defines, sitting below it like the
`vault.key` blob does, so it needs no `spec/` or `CONTRACT_VERSION` change.

## Native (later)

The same web bundle wraps in Capacitor or Tauri (Tauri is Rust and composes with
`core`) when native-only capabilities are needed: Bluetooth medical devices,
Apple HealthKit, Android Health Connect, and good on-device OS OCR. The OS
keystore (Keychain, Keystore) then secures the seed in hardware.

## Self-hosting

Two roles with different trust properties:

- **Relay.** Keyless and dumb. Anyone can run the binary and point a client at it.
  A compromised relay leaks nothing but ciphertext and metadata.
- **Processing node.** A trusted client in the key circle (it holds keys and
  sees plaintext), running the processing pipeline on infrastructure you trust.
  Wherever it runs — a machine at home, a VPS, a cluster — its host sits inside
  the trust boundary: a compromised node leaks plaintext, so the host must be
  secured accordingly. The node needs no inbound connections (it reaches the
  relay outbound), so a deployment stays secure regardless of network topology.

Keep these separate so the hosted relay stays truthfully zero-knowledge while
power users can run everything locally, from the same codebase.

## Roadmap

Since v0.1.0 the vault has grown passkey unlock, the doctor share and its
clinician summary view, narrative-notes import, paper-record capture with
encrypted attachment blobs and an in-app viewer, and render-time code display
names with the opt-in offline dictionary.

Forward-looking plans live in `docs/ROADMAP.md`.

## Keep in sync

When the core patterns change, update together:

- This file (`docs/ARCHITECTURE.md`).
- `spec/` (the written contract and test vectors) and
  `svastha_core::CONTRACT_VERSION`.
- The `core` types that implement the contract.
- `docs/ROADMAP.md`.
