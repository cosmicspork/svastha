# Roadmap

Pending work only, grouped by area — not sequenced. What shipped is
CHANGELOG.md's job; how the system works today is docs/ARCHITECTURE.md's.
Feature PRs keep this current: remove an item in the PR that ships it, and
harvest a PR's "## Deferred" notes into the list.

## Sync & protocol

- Multi-relay replication — client-driven; relays stay dumb replicas, no
  inter-relay protocol (contract enablers — envelope message ids, mergeable
  epoch ids — land with the protocol wave)
- Relay reachability / CORS preflight in production — authenticated calls send
  custom `svastha-*` headers, so every non-`/v0/info` request is CORS
  *preflighted*. A deployment whose edge (proxy/CDN/TLS terminator) doesn't
  answer the `OPTIONS` preflight makes connect succeed (header-less
  `GET /v0/info`) while sync fails with a bare `TypeError: Load failed`. The
  relay's own `CorsLayer::permissive()` is correct — the fix is in front of it.
  The PWA now surfaces this honestly (Sync shows "Unreachable", not "Online").

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
  it once at import would make stored events self-describing (SNOMED names still
  fall through — see "Intentionally not doing").

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

- RAG answers — the AI half of Search seals a question to the enrolled node's
  mailbox, but the node does not yet retrieve-and-answer, so a sent question
  stays "waiting". Ship the cited-answer path so the Search AI toggle has a
  backend to light up.
- Narrative-notes extraction — mine imported `doc-` prose for coded-event
  proposals (follow-up to OCR proposals)
- Sender-sealed push notification hints — richer lock-screen text needs a
  service-worker-accessible key custody decision first

## Relay operations

- Web Push (VAPID) on the deployment — `GET /v0/push/key` answers `503` until
  the operator configures VAPID keys, so the PWA correctly reports "This relay
  doesn't offer push notifications". Configure it to enable lock-screen alerts.

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
