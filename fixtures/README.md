# Fixtures

Synthetic, PHI-free test data only. Nothing here is a real medical record, and
real EHR exports (Epic IHE_XDM packages, FollowMyHealth FHIR bundles, or
anything else pulled from an actual patient portal) must never enter this
repo — not even temporarily, not even for debugging. If you need to reproduce
a bug from a real export, redact it to the same shape as the fixtures below
before sharing it.

## What's here

- `ccda/minimal-ccd.xml` — a hand-built C-CDA exercising every section
  `crates/import/src/ccda.rs` maps (allergy, problem, medication, immunization,
  result, vital, procedure, encounter), plus one nullFlavor'd entry with no
  usable translation (must be skipped, not silently dropped) and one section
  (`29762-2`, Social History) the mapping deliberately doesn't handle yet. The
  Encounters section also nests three `entryRelationship` candidates — a
  `<procedure>` with its own `effectiveTime`, a Procedure Activity Act that
  falls back to the encounter's, and a Procedure Activity Observation with an
  unusable code (must skip, not drop) — and the Results section carries two ST
  values with no inline text: one resolved via a `<reference>` into the
  section's narrative `<text>`, one dangling (must skip + warn). Fictional
  patient "Alex Example", fictional codes and values.
- `fhir/bundle-minimal.json` — a small FHIR R4 `Bundle` with one of each
  resourceType `crates/import/src/fhir.rs` maps, a `Patient` (unmapped) and an
  `Appointment` (unmapped), and a `valueQuantity` of `98.60` — the trailing
  zero must survive the round trip (see the decimal-preservation test in
  `crates/import/tests/fhir.rs`).
- `xdm/minimal-xdm.zip` — an IHE_XDM package: `IHE_XDM/EXAMPLE1/DOC0001.XML`
  (a copy of `ccda/minimal-ccd.xml`) alongside stub `STYLE.XSL` and
  `INDEX.HTM` files, so the web unzip/path-filtering test has a real package
  shape to exercise (only `DOC*.XML` files are documents; everything else in
  an IHE_XDM package is styling/index noise).

## Golden tests

`crates/import/tests/ccda.rs` and `crates/import/tests/fhir.rs` import these
fixtures and assert exact event counts, a determinism check (importing twice
produces identical drafts), and a handful of pinned content ids — if a date or
value normalization rule changes, one of those ids changes too, and the test
fails loudly instead of the drift going unnoticed.

## Generating more (soak testing)

For larger/messier synthetic data than these hand-built fixtures — closer to
what a 70-document Epic export or a large FHIR bundle actually looks like —
generate synthetic patients locally with
[Synthea](https://github.com/synthetichealth/synthea):

```bash
git clone https://github.com/synthetichealth/synthea.git
cd synthea
# C-CDA output (writes to output/ccda/):
./run_synthea -p 50 --exporter.ccda.export=true --exporter.fhir.export=false
# FHIR R4 Bundle output (writes to output/fhir/):
./run_synthea -p 50 --exporter.fhir.export=true --exporter.fhir.use_us_core_ig=true
```

Point `crates/import`'s tests or the web Import screen at the generated files
directly (they never need to be committed here — Synthea output is synthetic
by construction, but it's still bulk data with no reason to live in the repo).
Public sample C-CDA documents are also published by HL7 and ONC, for
cross-checking against a real vendor's document shape.
