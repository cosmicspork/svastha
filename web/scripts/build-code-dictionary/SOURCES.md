# Code dictionary sources

The offline code dictionary (Settings → Code dictionary) maps clinical codes to
human names for records that were imported without a display label. This
directory holds the generator; the generated JSON lives under
`web/public/dict/` and **is committed** (it ships with the site). Raw source
files go in an uncommitted `sources/` dir (gitignored) — only the generated
output is tracked.

## Regenerating

1. Download the sources below into `sources/` (filenames may be dated; the
   generator matches by substring).
2. From `web/`, run:

   ```
   bun run scripts/build-code-dictionary/build.ts
   ```

3. Review the diff under `web/public/dict/` and commit.

The generator does **no** network I/O: it fails loudly on a missing or broken
download rather than shipping stale data. It also never fetches per-code —
these are whole-file reference sets, served wholesale from our own origin, so a
network request can't reveal which codes a vault holds.

## Sources

| System | File in `sources/` | Download | License |
|---|---|---|---|
| LOINC | `*top2000*.csv` (see below) | account-gated | free redistribution in apps, **mandatory attribution** |
| RxNorm | `RXNCONSO.RRF` (from the prescribable zip) | unauthenticated | no license required |
| ICD-10-CM | `icd10cm-order-2026.txt` | unauthenticated | U.S. public domain |
| CVX | `cvx.txt` | unauthenticated | U.S. CDC, public |

### LOINC — Top 2000+ Lab Observations (account-gated; currently a STARTER)

- Download page: <https://loinc.org/downloads/> → "Top 2000+ LOINC Lab
  Observations" (SI). Requires a **free** LOINC account, so this step can't be
  automated — download the CSV by hand and drop it in `sources/` as e.g.
  `Top2000CommonLOINCLabResults.csv`.
- The parser (`parseLoincCsv`) finds the `LOINC_NUM` and `LONG_COMMON_NAME`
  columns by header, so minor release-to-release schema drift is tolerated.
- **Until that file is added, `loinc.json` is a starter** derived from the
  app's own curated LOINC codes (vitals + exercise, from `web/src/lib/codes.ts`)
  so the file exists and the loader is testable. The manifest marks it
  `"starter": true`. Regenerating the full Top-2000 set is a follow-up that
  needs the account download.
- **Mandatory attribution** (shown verbatim under the Settings toggle):

  > This material contains content from LOINC (http://loinc.org). LOINC is
  > copyright © Regenstrief Institute, Inc. and the Logical Observation
  > Identifiers Names and Codes (LOINC) Committee and is available at no cost
  > under the license at http://loinc.org/license. LOINC® is a registered
  > United States trademark of Regenstrief Institute, Inc.

### RxNorm — Current Prescribable Content (unauthenticated)

- Files page: <https://www.nlm.nih.gov/research/umls/rxnorm/docs/rxnormfiles.html>
- Download the current `RxNorm_full_prescribe_MMDDYYYY.zip` (e.g.
  `https://download.nlm.nih.gov/rxnorm/RxNorm_full_prescribe_07062026.zip`) —
  explicitly **no license/login required**, unlike the full RxNorm release.
- Unzip and copy `rrf/RXNCONSO.RRF` into `sources/`.
- `parseRxnormConso` keeps `SAB=RXNORM`, non-suppressed atoms and picks one
  canonical name per RXCUI, preferring SCD/SBD term types.
- Courtesy attribution: U.S. National Library of Medicine (NLM/NIH).

### ICD-10-CM — Code Descriptions (public domain)

- Directory:
  <https://ftp.cdc.gov/pub/health_statistics/nchs/publications/ICD10CM/2026/>
- Download `icd10cm-Code Descriptions-2026.zip`, unzip, copy
  `icd10cm-order-2026.txt` into `sources/`.
- The order file is used (not the codes-only file) so category/header codes are
  included too. Codes are stored **dotted** (`A00.0`), matching FHIR/C-CDA
  imports.
- Courtesy attribution: CMS / CDC-NCHS.

### CVX — CDC vaccine codes (public)

- `https://www2.cdc.gov/vaccines/iis/iisstandards/downloads/cvx.txt` (pipe-
  delimited despite older docs calling it tab-delimited; no header row). Copy
  into `sources/` as `cvx.txt`.
- PHIN VADS sunsets 2026-11-30; if this CDC IIS endpoint disappears, the CVX
  republication on <https://terminology.hl7.org> is the fallback source (adjust
  `parseCvx`'s delimiter if the format differs).
- Courtesy attribution: U.S. CDC.

## Excluded on purpose

- **SNOMED CT** — affiliate licensing with per-territory reporting; not viable
  to bundle. SNOMED-coded events fall through to the existing raw-code fallback.
- **CPT** — AMA paid license (even short descriptions). Excluded.
