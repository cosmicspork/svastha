# Roadmap

Pending work only, grouped by area — not sequenced. What shipped is
CHANGELOG.md's job; how the system works today is docs/ARCHITECTURE.md's.
Feature PRs keep this current: remove an item in the PR that ships it, and
harvest a PR's "## Deferred" notes into the list.

## Sync & protocol

- Multi-relay replication — client-driven; relays stay dumb replicas, no
  inter-relay protocol (contract enablers — envelope message ids, mergeable
  epoch ids — land with the protocol wave)

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

## Native (arrives with the wrapper)

- OS keystore custody for the seed
- Bluetooth medical devices; Apple HealthKit; Android Health Connect
- ABDM boundary adapter (consent-federated — a different trust model)
- Research marketplace (the grant primitive at different settings)

## AI on device

Making the node optional. The PWA already holds the decrypted vault, so OCR and
cited Q&A can run where the keys already are; classical OCR plus a text model
replaces the single vision pass and retires the vision-model requirement.

- Move the node's own inference-endpoint field alongside the device one, so the
  two are configured in one place rather than two screens
- Measure on-device OCR accuracy against the tabular fixtures before it can be
  switched on by default — the ship gate is zero cross-row mis-associations, and
  it needs a harness that runs real pages through a configured endpoint
- Runtime-cache the OCR assets in the service worker, so a device that has
  switched on on-device reading can still read a page offline (they are excluded
  from the install precache, so today it depends on the browser's HTTP cache)
- Two-stage extraction in the node with in-process OCR — one extraction path,
  and the vision model goes away

Handwriting is out of scope on device: an honest "couldn't read this page"
rather than a silent miss. Running a node stays the answer for it.

## Processing node

- Narrative-notes extraction — mine imported `doc-` prose for coded-event
  proposals (follow-up to OCR proposals)
- Sender-sealed push notification hints — richer lock-screen text needs a
  service-worker-accessible key custody decision first

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
