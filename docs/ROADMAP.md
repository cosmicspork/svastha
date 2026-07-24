# Roadmap

Pending work only, grouped by area — not sequenced. What shipped is
CHANGELOG.md's job; how the system works today is docs/ARCHITECTURE.md's.
Feature PRs keep this current: remove an item in the PR that ships it, and
harvest a PR's "## Deferred" notes into the list.

## Sync & protocol

- Blob-list pagination and manifests; curation etags
- Multi-relay replication — client-driven; relays stay dumb replicas, no
  inter-relay protocol (contract enablers — envelope message ids, mergeable
  epoch ids — land with the protocol wave)

## Sharing

- QR seed handoff (auto-provision a new device)
- Cross-device doctor-share management
- Share-history clearing after the tombstone sweep
- Caregiver proposals — a granted identity suggests events, the owner
  approves and signs (rides the proposer-agnostic proposal mechanism)
- Cryptographic grant scoping (per-scope data keys) — relay-blind namespace
  enforcement; the true-ZK version of prefix-scoped grants

## Import

- Deeper NOTE sections (H&P, ED, Consult, Nursing, OR, Discharge)
- Goals, Care Teams, Functional Status, Medical Devices, Patient Instructions
- FHIR DiagnosticReport / DocumentReference / CarePlan
- RxNorm coding for manually logged medications

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

## Processing node

- extraction, de-identification, local RAG (`crates/node`) — delegates
  inference to a user-supplied OpenAI-compatible endpoint; not tied to the
  native wrapper
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
- **SNOMED CT / CPT names in the offline dictionary** — licensing; those
  systems fall through to the earlier display layers.
- **Code-less negative statements** ("No known drug allergies") — the app
  says "None recorded", never a clinical negative the vault can't back.
