# Roadmap

Pending work only, grouped by area — not sequenced. What shipped is
CHANGELOG.md's job; how the system works today is docs/ARCHITECTURE.md's.
Feature PRs keep this current: remove an item in the PR that ships it, and
harvest a PR's "## Deferred" notes into the list.

## Sync & protocol

- Multi-relay replication — client-driven; relays stay dumb replicas, no
  inter-relay protocol (contract enablers — envelope message ids, mergeable
  epoch ids — land with the protocol wave)
- Ordered transition token + per-owner node-side high-water mark for admin
  commands (cross-pass replay/reorder; trust-contract design)

## Sharing

- QR seed handoff (auto-provision a new device)
- Caregiver proposals — a granted identity suggests events, the owner
  approves and signs (rides the proposer-agnostic proposal mechanism)
- Cryptographic grant scoping (per-scope data keys) — relay-blind namespace
  enforcement; the true-ZK version of prefix-scoped grants

## Import

- Deeper NOTE sections (H&P, ED, Consult, Nursing, OR, Discharge)
- Goals, Care Teams, Functional Status, Medical Devices, Patient Instructions
- FHIR DiagnosticReport / DocumentReference / CarePlan
- RxNorm coding for manually logged medications
- Canonicalize code system URIs at import — a C-CDA/FHIR source may code a
  concept by its HL7 OID (`urn:oid:2.16.840.1.113883.6.88`) rather than the
  canonical URL, so stored events resolve labels/dictionary only because the
  PWA now folds known OIDs at render time (`codes.ts` `canonicalSystem`). Doing
  it once at import would make stored events self-describing.

## Web

- Web Worker for large-document parse (if UI jank appears)
- Per-item curation on grouped spine entries
- Long-press bloom shortcut
- Friendly provenance source names
- Compare-and-update for `applyAdminReply` and `noteNodeSeen`
  (two-transaction read-modify-write races)

## Native (arrives with the wrapper)

- OS keystore custody for the seed
- Bluetooth medical devices; Apple HealthKit; Android Health Connect
- ABDM boundary adapter (consent-federated — a different trust model)
- Research marketplace (the grant primitive at different settings)

## AI on device

- Measure the node's in-process page reader against real pages before trusting
  it unattended — it replaced a working vision path and has not been run against
  a real backlog yet; the same zero-cross-row-mis-association gate applies
- Move the node's own inference-endpoint field alongside the device one, so the
  two are configured in one place rather than two screens
- Measure on-device OCR accuracy against the tabular fixtures before it can be
  switched on by default — the ship gate is zero cross-row mis-associations, and
  it needs a harness that runs real pages through a configured endpoint
- Runtime-cache the OCR assets in the service worker, so a device that has
  switched on on-device reading can still read a page offline (they are excluded
  from the install precache, so today it depends on the browser's HTTP cache)
- UCUM-aware unit validation for extraction claims (claimed unit is currently
  unvalidated)
- Decide unit-vocabulary handling for integer+attached one-part units ("10mg"
  currently drops by design)
- Read-page message distinguishes unparseable model output from an empty page
  (web; wasm already carries the flag)

## Processing node

- Narrative-notes extraction — mine imported `doc-` prose for coded-event
  proposals (follow-up to OCR proposals)
- Sender-sealed push notification hints — richer lock-screen text needs a
  service-worker-accessible key custody decision first
- Active node must derive from live grant state — a revoked node's proposer
  row still selects it and its messages stay accepted (trust boundary;
  predates the AI arc, PR #115 lineage)
- Fail-closed node Q&A enrollment handshake — send and confirm an empty
  answer scope before enabling the node branch
- Attempt cap for pages whose model output is persistently unusable (journal
  retries on backoff indefinitely)
- Within-pass `sent_at` ordering for `pause_ocr`/`resume_ocr` like
  `set_answer_scope` (a reversed pair leaves reading on)
- Decide: node inference endpoint as owner command vs. host-operator config
  (any enrolled owner can currently repoint it for all)

## Intentionally not doing

- **Multi-writer vaults** — capable-of-owning and capable-of-approving are
  the same threshold: a capable owner approves proposals from granted
  identities; below that threshold the record has honestly changed hands
  (custody transfer via the social-recovery seed). One custodian identity
  per vault; seeds are never co-held between adults (a seed co-holder is
  unrevocable forever). Caregivers are revocable grantee-proposers.
- **Ordered-prescriptions import** — ordered is not taken; importing orders
  would fabricate a medication history. Test-locked exclusion.
- **CPT names in the offline dictionary** — the AMA licenses codes and
  descriptors for royalties with no free tier and no equivalent of SNOMED's
  Global Patient Set; CPT falls through to the earlier display layers.
- **Code-less negative statements** ("No known drug allergies") — the app
  says "None recorded", never a clinical negative the vault can't back.
- **Handwriting recognition** — out of scope for both readers; the node
  transcribes in-process too, so no vision model is left to fall back on. A
  handwritten page answers "couldn't read this page" rather than guessing;
  entering it by hand is the remaining route.
