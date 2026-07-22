# Roadmap

Forward-looking plans only. What shipped is CHANGELOG.md's job; how the system
works today is docs/ARCHITECTURE.md's. Feature PRs keep this current the way
they keep ARCHITECTURE.md current: pull work into **Now** when it starts, drop
it on merge (the changelog records it), and harvest a PR's "## Deferred" notes
into the sections below.

## Now

- **Full LOINC Top-2000 dictionary** — build pipeline now fetches LOINC
  automatically via the Download API given a maintainer's account credentials
  (`LOINC_USERNAME`/`LOINC_PASSWORD` in `web/.env`), with a manual-CSV fallback
  (`LOINC_TOP2000_CSV=…`/`--loinc-csv=…`); ships the required license text
  (`LOINC_LICENSE.txt`) and release version alongside the data. `loinc.json`
  still ships as the starter dictionary until the maintainer runs the build
  with real credentials or a manual file (an agent/CI cannot supply either).

## Next

- **OCR for captured documents** — native OS OCR via the wrapper, or the
  processing node; human-in-the-loop for handwriting.
- **PDF attachments** — paper-record capture is photos-only today.
- **Imported source documents in the viewer** — render `doc-` provenance
  blobs through the same attachment viewer captured records use.

## Later

**Sync & protocol**

- Relay push channel (clients poll today)
- Key rotation for real revocation
- Blob-list pagination and manifests; curation etags
- Relay nonce store (auth replay hardening)
- Signed curation records — core contract landed (sign/verify/merge); web
  adoption (signing on write, migration, share-bundle inclusion) next;
  prerequisite for multi-writer
- Multi-writer sync (needs new conflict machinery; ends the single-writer
  assumption)

**Sharing**

- Device list and revoke UI
- QR seed handoff (auto-provision a new device); in-app QR scanning
- Relay-less file share; cross-device doctor-share management
- `doc-` blobs in doctor-share bundles
- Share-history clearing after the tombstone sweep
- Richer grant terms (family/caregiver beyond the household pair)

**Import**

- Deeper NOTE sections (H&P, ED, Consult, Nursing, OR, Discharge)
- Goals, Care Teams, Functional Status, Medical Devices, Patient Instructions
- FHIR DiagnosticReport / DocumentReference / CarePlan
- RxNorm coding for manually logged medications

**Web**

- Web Worker for large-document parse (if UI jank appears)
- Per-item curation on grouped spine entries
- Long-press bloom shortcut
- Friendly provenance source names

**Native (arrives with the wrapper)**

- OS keystore custody for the seed
- Bluetooth medical devices; Apple HealthKit; Android Health Connect
- ABDM boundary adapter (consent-federated — a different trust model)
- Research marketplace (the grant primitive at different settings)
- Processing node (`crates/node`): OCR, extraction, de-identification,
  local RAG — delegating inference to a user-supplied OpenAI-compatible
  endpoint

## Intentionally not doing

- **Ordered-prescriptions import** — ordered is not taken; importing orders
  would fabricate a medication history. Test-locked exclusion.
- **SNOMED CT / CPT names in the offline dictionary** — licensing; those
  systems fall through to the earlier display layers.
- **Code-less negative statements** ("No known drug allergies") — the app
  says "None recorded", never a clinical negative the vault can't back.
