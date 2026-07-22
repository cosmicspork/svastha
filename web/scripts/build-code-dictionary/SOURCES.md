# Code dictionary sources

The offline code dictionary (Settings → Code dictionary) maps clinical codes to
human names for records that were imported without a display label. This
directory holds the generator; the generated JSON lives under
`web/public/dict/` and **is committed** (it ships with the site). Raw source
files go in an uncommitted `sources/` dir (gitignored) — only the generated
output is tracked.

## Regenerating

1. Download the non-LOINC sources below into `sources/` (filenames may be
   dated; the generator matches by substring). LOINC itself is normally
   fetched automatically — see below.
2. From `web/`, run:

   ```
   bun run scripts/build-code-dictionary/build.ts
   ```

3. Review the diff under `web/public/dict/` and commit.

The generator does **no** network I/O except for LOINC's Download API (below):
it fails loudly on a missing or broken download rather than shipping stale
data. It also never fetches per-code — these are whole-file reference sets,
served wholesale from our own origin, so a network request can't reveal which
codes a vault holds.

## Sources

| System | How it's fetched | Auth | License |
|---|---|---|---|
| LOINC | Download API (automatic) or manual CSV (see below) | LOINC account | free redistribution in apps, **mandatory attribution + license text + release version** |
| RxNorm | `RXNCONSO.RRF` in `sources/` (from the prescribable zip) | unauthenticated | no license required |
| ICD-10-CM | `icd10cm-order-2026.txt` in `sources/` | unauthenticated | U.S. public domain |
| CVX | `cvx.txt` in `sources/` | unauthenticated | U.S. CDC, public |

### LOINC — full release table

**Primary path: the Download API.** Set `LOINC_USERNAME` and `LOINC_PASSWORD`
(a free loinc.org account's credentials) in `web/.env` — Bun auto-loads it, and
it's gitignored via the repo's blanket `.env` rule, same as everywhere else —
and just run the build:

```
bun run scripts/build-code-dictionary/build.ts
```

What that does:

- `GET /Loinc` against `https://loinc.regenstrief.org/api/v1` for the current
  release's metadata (`version`, `downloadUrl`, `downloadMD5Hash`, …).
  **Polled at most once a day** (LOINC's own etiquette) — the check timestamp
  and a copy of the extracted CSV are cached under `sources/.loinc-cache/`
  (gitignored along with the rest of `sources/`), so a build within 24h of the
  last check reuses the cache instead of hitting the API again.
- Downloads the release zip only when its `version` is newer than the one
  already baked into the committed `manifest.json`, verifies it against
  `downloadMD5Hash`, and extracts `LoincTable/Loinc.csv` (via `fflate`).
- Maps the **entire table** — `LOINC_NUM` → `LONG_COMMON_NAME`, every status
  including deprecated codes (an append-only vault renders old documents, and a
  named deprecated code beats an "Unnamed entry" row) — stored verbatim (see
  the compliance comment in `parsers.ts` — the license's Section 2 forbids
  changing field contents). ~109k entries, ~7.4 MB serialized, ~1.3 MB on the
  wire gzipped. Pass `--loinc-top2000` to build the 126 KB
  `COMMON_TEST_RANK` 1–2000 subset instead, should size ever matter.
- Missing credentials, or any API/network/hash-verification failure, print a
  warning and fall through to the manual CSV path, then the starter dictionary
  — **this never fails the whole build.**

**Fallback path: a manual CSV**, for offline use or if the API is unavailable.
Download page: <https://loinc.org/downloads/> → "Top 2000+ LOINC Lab
Observations" (SI). Point the build at the downloaded file, and supply the
release version explicitly since it can't be derived from this CSV alone:

```
LOINC_TOP2000_CSV=/path/to/Top2000CommonLOINCLabResults.csv LOINC_RELEASE=2.80 bun run scripts/build-code-dictionary/build.ts
# or
bun run scripts/build-code-dictionary/build.ts --loinc-csv=/path/to/file.csv --loinc-release=2.80
```

or drop the file in `sources/` (matched by the `top2000` substring, e.g. as
`Top2000CommonLOINCLabResults.csv`) with the release still supplied via
`--loinc-release`/`LOINC_RELEASE`. The release is optional here (a warning is
printed if it's missing) but strongly recommended — the LOINC license
(Section 9) requires a version on every copy, which the API path supplies
automatically but this one can't.

**Until either path succeeds, `loinc.json` is a starter** derived from the
app's own curated LOINC codes (vitals + exercise, from `web/src/lib/codes.ts`)
so the file exists and the loader is testable. The manifest marks it
`"starter": true` and carries no `loincRelease`.

**License compliance (LOINC license Section 9 — "each copy"):**

- **Attribution** (shown verbatim under the Settings toggle), with the release
  appended whenever real data is loaded:

  > This material contains content from LOINC (http://loinc.org). LOINC is
  > copyright © Regenstrief Institute, Inc. and the Logical Observation
  > Identifiers Names and Codes (LOINC) Committee and is available at no cost
  > under the license at http://loinc.org/license. LOINC® is a registered
  > United States trademark of Regenstrief Institute, Inc. Top 2000+ release
  > \<X\>.
- **`web/public/dict/LOINC_LICENSE.txt`** — the complete LOINC Copyright Notice
  and License, verbatim (fetched from <https://loinc.org/kb/license/>), shipped
  alongside the data and referenced here as required by the license's own
  redistribution terms.
- **`loincRelease`** in the manifest's LOINC entry — the release/version
  string, from the API automatically or from `--loinc-release`/`LOINC_RELEASE`
  on the manual path.

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
