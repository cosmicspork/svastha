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
- Prefer a *named* coding in a known terminology when a `CodeableConcept`
  carries several — `fhir.rs` `best_coding` ranks LOINC → SNOMED → *first
  coding in the array*, and `ccda.rs` `extract_code` takes the root `<code>`
  even when it has no `displayName` and a `<translation>` does. A medication
  concept that lists NDC first therefore imports as a display-less NDC code
  while the sibling RxNorm coding carrying the name is discarded, and the row
  can only ever render "Unnamed entry · NDC 8627007701". Fixes future imports
  only: `code` is signed content, so a re-import under a corrected preference
  produces new events beside the old ones rather than replacing them
- Decide how *dispensed* medications enter the record — a portal FHIR export
  frequently carries no `MedicationStatement` at all, only `MedicationRequest`
  (an order — the same thing the Ordered Prescriptions exclusion refuses, see
  below) and `MedicationDispense`. Dispensed is stronger evidence than ordered
  and weaker than taken; whether either may become a `medication_statement`,
  and under what provenance, is an owner decision, not an implementation gap.
  Until it is made both stay in the "not mapped (v1)" skip and those
  medications are simply absent from the vault
- Canonicalize code system URIs at import — a C-CDA/FHIR source may code a
  concept by its HL7 OID (`urn:oid:2.16.840.1.113883.6.88`) rather than the
  canonical URL, so stored events resolve labels/dictionary only because the
  PWA now folds known OIDs at render time (`codes.ts` `canonicalSystem`). Doing
  it once at import would make stored events self-describing.

## Web

- NDC in the offline dictionary — `public/dict` ships LOINC, RxNorm, ICD-10-CM,
  CVX and SNOMED, so an NDC-coded event resolves a name at no layer: `codes.ts`
  knows the system well enough to print "NDC", and nothing anywhere knows the
  code. The openFDA NDC directory is public domain. This is the only fix that
  names *already-imported* NDC rows, since signed content is never rewritten —
  the alternative for existing events is the per-concept `name:` override
- Full RxNorm rather than Current Prescribable Content — `rxnorm.json` is built
  from the unauthenticated prescribable subset (74,934 RXCUIs), which omits
  concepts that real exports carry: of four RXCUIs sampled from one vault,
  861004 and 29046 resolve and 1719647 and 1665039 do not. The full release
  needs a UMLS licence and login, which is why the subset was chosen — a
  licensing decision before it is a build one
- Coded pickers for manual entry — search-as-you-type over the offline
  dictionary (RxNorm meds, SNOMED/ICD-10-CM conditions, CVX immunizations,
  LOINC labs + values), free text always allowed; subsumes "RxNorm coding for
  manually logged medications". Codes attach only at entry — signed content is
  never rewritten, so this is forward-only. CPT-coded procedures stay excluded
  (licensing); RxNorm coverage is the prescribable subset until the UMLS-licence
  decision
- Visit-card nesting — extend C2 so a manually recorded visit's same-timestamp
  vitals/meds/clinical rows can render inside the encounter entry as one card
- Provider recents on the visit form — chip suggestions from previously logged
  providers; a provider entity is deliberately out of scope
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
  a real backlog yet; the same zero-cross-row-mis-association gate applies. Run
  `just accuracy` (`crates/devtool`) and put the result in the PR. Its first run
  against the synthetic fixtures did not clear the gate: on a tabular panel the
  reader produced one cell per line rather than one row, so no finding could
  verify against its cited line and the page proposed nothing at all
- Measure on-device OCR accuracy against the tabular fixtures before it can be
  switched on by default — the ship gate is zero cross-row mis-associations.
  Run `just accuracy` (`crates/devtool`) and put the result in the PR; the
  fixtures still need a run against real pages, not only the synthetic ones
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

## Intentionally not doing

- **Multi-writer vaults** — capable-of-owning and capable-of-approving are
  the same threshold: a capable owner approves proposals from granted
  identities; below that threshold the record has honestly changed hands
  (custody transfer via the social-recovery seed). One custodian identity
  per vault; seeds are never co-held between adults (a seed co-holder is
  unrevocable forever). Caregivers are revocable grantee-proposers.
- **Ordered-prescriptions import** — ordered is not taken; importing orders
  would fabricate a medication history. Test-locked exclusion (C-CDA section
  66149-6). FHIR `MedicationRequest` is the same claim in the other format and
  falls into the generic "not mapped (v1)" skip today; making that exclusion
  explicit — or lifting it — is the open decision noted under Import.
- **CPT names in the offline dictionary** — the AMA licenses codes and
  descriptors for royalties with no free tier and no equivalent of SNOMED's
  Global Patient Set; CPT falls through to the earlier display layers.
- **Code-less negative statements** ("No known drug allergies") — the app
  says "None recorded", never a clinical negative the vault can't back.
- **Handwriting recognition** — out of scope for both readers; the node
  transcribes in-process too, so no vision model is left to fall back on. A
  handwritten page answers "couldn't read this page" rather than guessing;
  entering it by hand is the remaining route.
