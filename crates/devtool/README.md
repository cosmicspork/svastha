# svastha-devtool

Dev-only tooling. Never published (`publish = false`, absent from
`release-please-config.json`'s `extra-files` and from the publish loop in
`.github/workflows/release.yml`), and nothing in CI runs any of it.

| Subcommand | What it does |
|---|---|
| *(no args)* | Pull this identity's relay blobs and decrypt them locally (`just decrypt`). |
| `import` | Re-derive events from the relay's stored source documents (`just import-derive`). |
| `accuracy` | Score the page readers against the fixture pages (`just accuracy`). |

The rest of this file is about `accuracy`.

## What it measures

The OCR pipeline ships with two page readers that have never been measured, and
three defaults are waiting on numbers that do not exist:

- whether the browser's on-device reader can be **on by default**,
- whether the node can work a **backlog unattended** (the bulk-read feature),
- whether **handwriting** is worth supporting at all.

`accuracy` produces those numbers. **Its results belong in the pull request that
flips any of those defaults** — a default changed without a run pasted into the
PR is a default changed on a guess.

### It scores the pipeline, not the recognizer

A reader that transcribes a page perfectly and a reader that transcribes it into
shuffled rows both produce plausible-looking text. The difference only appears
after the text has been coded. So each reader's transcript goes through the
**real** coding path — `svastha_import::extract::parse_lines`, sent with the
node's own request shape — and the score is over the draft events that come out
of the far end. The reader is the only variable.

### The readers

| Reader | What runs | Notes |
|---|---|---|
| `ocrs` | The node's own `svastha_node::transcribe` | Needs the `.rten` models; see below. |
| `tesseract` | The real `web/src/lib/ocr-engine.ts` in a real Chromium, over the committed assets in `web/public/ocr` | Driven by `web/scripts/accuracy/read-page.ts`. Goes through `enableAssets()`, so the SHA-256 verification is exercised too. |
| `vision` | The pre-#156 single-pass vision prompts, recovered from git history | `--vision` only. Scored through the **unverified** `extract::parse`, because it produces no transcript to cite against — which is the entire argument for the two-stage split. |

Neither reader is reimplemented here. A harness that hand-rolled either would be
measuring the harness.

## Running it

```bash
export SVASTHA_DEVTOOL_ENDPOINT=http://127.0.0.1:11434/v1   # required
export SVASTHA_DEVTOOL_MODEL=qwen2.5:14b                    # optional, default "default"
just accuracy                    # or: cargo run -p svastha-devtool -- accuracy
just accuracy --json             # machine-readable
just accuracy --only tight-rows  # one fixture
just accuracy --vision           # add the retired vision path (needs _VISION_MODEL)
```

`--only` is diagnostic: if its filter omits any committed fixture, the ship
gates report `INCONCLUSIVE` and the command exits non-zero. A partial run is
useful for investigating one page, never for clearing a default.

| Variable | |
|---|---|
| `SVASTHA_DEVTOOL_ENDPOINT` | OpenAI-compatible base URL. **Required** — without it the tool refuses and explains. |
| `SVASTHA_DEVTOOL_MODEL` | Model id for coding transcripts. Defaults to `default`. |
| `SVASTHA_DEVTOOL_VISION_MODEL` | Model id for `--vision`. No default; `--vision` refuses without it. |
| `SVASTHA_DEVTOOL_API_KEY` | Sent as a bearer token when set. |
| `SVASTHA_NODE_OCR_MODELS_DIR` | Where `text-detection.rten` and `text-recognition.rten` live. Without it the `ocrs` rows are skipped with a stated reason. The URLs and their pinned SHA-256s are in `Dockerfile.node`. |

The exit code is non-zero when any gate fails or is inconclusive, so a run cannot
be pasted into a PR as evidence without someone having read the verdict.

### Why this never runs in CI

Every scored run needs a coding model, and the score is a property of that model
as much as of the reader. A CI job would need a pinned endpoint this project does
not have and should not acquire — or it would silently measure nothing. The part
that *can* be tested without a model is: the scoring and gate logic
(`accuracy::score`, `accuracy::report`) is unit-tested against canned
transcripts, and the endpoint plumbing is covered end to end in
`tests/accuracy_endpoint.rs` against a mock HTTP server on loopback.

## The gates

Each gate is per reader, over **every** fixture including the hand-style ones.

- **`browser default-on gate`** — the browser reader must show zero cross-row
  mis-associations before on-device OCR can default to on.
- **`node unattended / bulk-read gate`** — the same for the node's reader, before
  it works a backlog with nobody watching.
- **`handwriting decision`** — informational, never a verdict. Whether to support
  handwriting at all is the owner's call; this only puts numbers under it.

Three outcomes, and the third one matters:

| | |
|---|---|
| `PASS` | Zero cross-row, and the reader actually proposed something on every typeset fixture. |
| `FAIL` | At least one cross-row mis-association, named with its fixture. |
| `INCONCLUSIVE` | The reader never ran, or ran and proposed nothing. |

`INCONCLUSIVE` exists because **zero cross-row is trivially true of a reader that
reads nothing**, and the first real run of this harness hit exactly that: the
node's `ocrs` reader transcribed a lab panel column-major, no finding could
verify against its cited line, and it proposed nothing at all. Reported as a
`PASS`, that would have read as "the node is safe to run unattended". Silence
does not clear a safety gate.

### Why cross-row is the gate

A missed row leaves the record incomplete, which the owner can see. A cross-row
mis-association — a real analyte from one row wearing a real value from another —
leaves it *confidently wrong*, and `Potassium 139 mmol/L` is not a value a human
reviewer reads as a typo. It survives every schema check; see
`fixtures/ocr/cmp-panel.cross-row.answer.json`. Precision and recall are reported
alongside it precisely because a reader can reach zero cross-row by declining to
read.

## The fixtures

Five synthetic pages under `fixtures/ocr/`, each with a `.truth.json` answer key
beside it. Both halves are generated from one spec by
`web/scripts/accuracy/render.ts`, so the key cannot drift from the page.

| Fixture | Hazard |
|---|---|
| `cmp-panel` | None — the control, and the same rows as the existing `cmp-panel.lines.json`. |
| `tight-rows-panel` | Rows set solid beneath a section header several times their height. |
| `skewed-panel` | ~2° of rotation, enough to droop a row by more than its own height across the panel. |
| `handwritten-vitals`, `handwritten-meds` | **Synthetic hand-style** — a cursive face with per-glyph jitter. |

The rendered PNGs are **committed, and the harness does not re-render them**:
text rasterization is not reproducible across machines, so a harness that
rendered its own inputs would score a slightly different page everywhere and
quietly stop being a comparison. `render.ts` is how they were made and how to
remake them deliberately.

A caution on the handwriting pages: a cursive typeface with jitter is a *proxy*
for handwriting, not a sample of it. A reader that fails here would certainly
fail on real handwriting; a reader that passes here has **not** been shown to
handle it. Treat a failure as informative and a pass as inconclusive.

Everything is invented — synthetic names, synthetic values. See
`fixtures/README.md`; that rule has no exceptions.
