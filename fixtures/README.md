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
  section's narrative `<text>`, one dangling (must skip + warn). Medications
  appear in all three mapped section shapes: history (`10160-0`), administered
  (`29549-3`, same plain-substanceAdministration entries), and discharge
  (`10183-2`, act-wrapped, plus one empty act that must skip). Two narrative
  prose sections exercise the note mapping: a Plan of Care (`18776-5`) with
  paragraph + list prose that becomes one `document`/Text note dated by the
  document's `componentOf/encompassingEncounter` visit date, and an Assessment
  (`51848-0`) whose "No data available" placeholder must skip (never an empty
  note). The header `<effectiveTime>` deliberately carries a birth-date-shaped
  value the mapping must ignore in favor of the encounter date. Fictional
  patient "Alex Example", fictional codes and values.
- `fhir/bundle-minimal.json` — a small FHIR R4 `Bundle` with one of each
  resourceType `crates/import/src/fhir.rs` maps, a `Patient` (unmapped) and an
  `Appointment` (unmapped), and a `valueQuantity` of `98.60` — the trailing
  zero must survive the round trip (see the decimal-preservation test in
  `crates/import/tests/fhir.rs`).
- `xdm/minimal-xdm.zip` — an IHE_XDM package: `IHE_XDM/EXAMPLE1/DOC0001.XML`
  (a verbatim copy of `ccda/minimal-ccd.xml`) alongside stub `STYLE.XSL` and
  `INDEX.HTM` files, so the web unzip/path-filtering test has a real package
  shape to exercise (only `DOC*.XML` files are documents; everything else in
  an IHE_XDM package is styling/index noise). `DOC0001.XML` must stay an exact
  copy of the C-CDA fixture; regenerate the zip whenever that fixture changes,
  e.g. `cd fixtures && rm -f xdm/minimal-xdm.zip && mkdir -p /tmp/xdm/IHE_XDM/EXAMPLE1 && cp ccda/minimal-ccd.xml /tmp/xdm/IHE_XDM/EXAMPLE1/DOC0001.XML`
  (add the two stubs) `&& (cd /tmp/xdm && zip -X -r -D "$OLDPWD/xdm/minimal-xdm.zip" IHE_XDM)`.

## `ocr/` — transcribed pages and recorded model answers

Goldens for `crates/import/src/extract.rs`'s text path, so the source-line guard
is tested deterministically with no model and no recognition engine in the loop.

- `cmp-panel.lines.json` — a transcribed two-column metabolic panel, one string
  per numbered line. This is what stage A produces; the numbers are what a
  finding cites.
- `cmp-panel.answer.json` — a correctly cited answer over it. Every finding
  survives.
- `cmp-panel.cross-row.answer.json` — **the adversarial case.** Every finding is
  individually schema-valid and would pass `parse` untouched, and each pairs a
  real analyte with a real value from a different row. It is what a model
  produces when a table has been flattened row-major. `parse_lines` must drop
  all of them; the test asserts the count, not just a sample.

### Rendered pages, for the accuracy harness

Five synthetic **page images** and their answer keys, scored by
`cargo run -p svastha-devtool -- accuracy` (see `crates/devtool/README.md`).
Where the transcripts above test the coding step with no recognizer in the loop,
these test the recognizers themselves.

- `cmp-panel.png` — the `cmp-panel.lines.json` rows typeset as a page. The
  control: no deliberate hazard.
- `tight-rows-panel.png` — rows set solid (no leading) beneath section headers
  several times their height. This is the layout that makes a line-grouper
  anchored to a row's tallest member swallow the rows below it.
- `skewed-panel.png` — the same panel rotated ~2°, enough that a row droops by
  more than its own height from its first cell to its last.
- `handwritten-vitals.png`, `handwritten-meds.png` — **synthetic hand-style**: a
  cursive face with deterministic per-glyph jitter. Clearly *not* real
  handwriting, and labelled that way in their answer keys; a reader that fails
  here would fail on real handwriting, but a reader that passes here has not
  been shown to handle it.

Each has a `<name>.truth.json` answer key listing the result rows actually
printed on the page. Reference ranges are deliberately **excluded** from the
keys even though they are printed: a reader that reports `Sodium 135` has read
the low end of the range as the result, and that must score as a miss, not a hit.

Both the PNG and its key are generated from one spec by
`web/scripts/accuracy/render.ts` (`cd web && bun run scripts/accuracy/render.ts`),
so an edited value changes the pixels and the ground truth together or not at
all. The PNGs are committed rather than rendered on demand because text
rasterization is not reproducible across machines — regenerating them on a
different box will shift pixels, which is fine deliberately and not fine
silently. Regenerating the hand-style pages needs a cursive font installed
(the script names the ones it looks for and refuses rather than quietly
emitting typeset text under a handwriting filename).

### The rule

The synthetic-only rule at the top of this file applies with no exceptions here,
to the transcripts and the rendered pages alike. A photographed or scanned page
of a real lab report, prescription, or discharge summary must never land in this
directory — and the transcript form is if anything easier to leak by accident,
because it looks like plain text rather than a document. Hand-write the lines and
invent the values, as these fixtures do; the patient is always "Synthetic Test".

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
