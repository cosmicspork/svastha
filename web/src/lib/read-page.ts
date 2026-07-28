// Reading a captured page on this device and proposing what it says.
//
// The whole path is local except one call: transcribe here, send only the text
// for coding, validate the reply here. The page image never leaves the device —
// which is a stronger property than the node ever had, since the node uploads
// the page itself to a vision endpoint.
//
// **Local drafts skip the mailbox entirely.** The proposal mechanism exists
// because a node cannot sign as the owner, so its suggestions have to travel as
// sealed envelopes and be approved. This device *is* the owner: it holds the
// seed. So a page read here writes straight into the same review queue, and the
// existing approve/reject path signs it exactly as it signs a node's. Nothing
// about the review changes — only the round-trip disappears.
import {
  initSvastha,
  extract_system_prompt,
  extract_user_prompt,
  code_from_lines,
  event_id,
} from './svastha'
import { pdfTextEngine } from './pdf'
import { imageOcrEngine } from './ocr-engine'
import { numberedLines, renderColumns } from './ocr-layout'
import { UnreadablePageError, type OcrLine } from './ocr'
import { loadConfig, chatComplete, InferenceError } from './inference'
import { buildProposalRecord, upsertProposal, type DraftEvent } from './proposals'
import { session } from './session.svelte'
import type { EventKind, EventValue } from './drafts'
import type { Code } from './codes'

/** How the extraction is recorded on every approved event's provenance. Kept as
 * `"ocr"` — the same value the node writes — so a provenance query does not have
 * to know which reader produced a fact. `model` carries the difference. */
const METHOD = 'ocr'

/** What the model returns, after validation in wasm. */
interface CodedDraft {
  kind: EventKind
  code: Code | null
  effective_at: string | null
  value: EventValue | null
}

interface Coded {
  drafts: CodedDraft[]
  dropped: number
}

export { UnreadablePageError }

/**
 * Transcribe a page into its pages of lines. Tries the exact path first (a
 * PDF's embedded text layer), then the recognizer for images — which reads one
 * image, so it is a single page.
 *
 * Throws rather than returning empty when nothing could be read: "no text" and
 * "not read" are the same from here, and only one of them is safe to assume
 * about a medical document.
 */
export async function transcribe(bytes: Uint8Array, mime: string): Promise<OcrLine[][]> {
  const pages = await pdfTextEngine.recognizePages(bytes, mime)
  if (pages.some((page) => page.length > 0)) return pages

  const recognized = await imageOcrEngine.recognize(bytes, mime)
  if (recognized.length > 0) return [recognized]

  throw new UnreadablePageError(
    "Couldn't read this page. Scanned PDFs and photographs need on-device reading switched on (Settings → AI), and handwriting isn't supported.",
  )
}

/**
 * The prompt body: the schema, then the page in both renderings.
 *
 * Both are sent because they fail differently. The column view keeps a lab
 * panel's rows visually intact, which is what stops a value being paired with
 * the analyte above or below it; the numbered view is what a finding cites, and
 * what the source-line guard checks against. Neither alone does both jobs.
 *
 * Columns are rendered a page at a time: their character scale spans the widest
 * run in what they are given, so a single page-wide rule or footer would
 * otherwise squash every other page's table into collisions. The numbering runs
 * across the whole document, because that is what a cited line number means.
 */
export function buildExtractionPrompt(pages: OcrLine[][]): string {
  return [
    extract_user_prompt(),
    '',
    'The page, with columns preserved:',
    pages.map((page) => renderColumns(page)).join('\n\n'),
    '',
    'The same page, one numbered line per row — cite these numbers:',
    numberedLines(pages.flat()),
  ].join('\n')
}

/** Stamp provenance and the content-addressed id onto a validated draft. */
function toDraftEvent(draft: CodedDraft, sourceSha: string): DraftEvent {
  const provenance = { source: METHOD, source_doc: sourceSha }
  const content = {
    kind: draft.kind,
    code: draft.code,
    effective_at: draft.effective_at,
    value: draft.value,
    provenance,
  }
  return { ...content, id: event_id(JSON.stringify(content)) }
}

export interface ReadResult {
  /** How many drafts reached the review queue. */
  proposed: number
  /** Findings the model produced that failed validation or the source-line
   * check. Surfaced rather than hidden — a page where most findings were
   * dropped is worth looking at yourself. */
  dropped: number
  /** The proposal record id, when anything was proposed. */
  proposalId?: string
}

/**
 * Read one captured page and file what it says into the review queue.
 *
 * `sourceSha` is the attachment's content hash, which rides onto every draft's
 * provenance so an approved event points back at the page it was read from.
 */
export async function readAndPropose(
  sourceSha: string,
  bytes: Uint8Array,
  mime: string,
): Promise<ReadResult> {
  const config = await loadConfig()
  if (!config?.endpoint || !config.model) {
    throw new InferenceError(
      'No inference endpoint is configured on this device (Settings → AI).',
    )
  }
  if (!session.identity) throw new Error('Unlock the vault before reading a page.')

  await initSvastha()
  const pages = await transcribe(bytes, mime)
  const lines = pages.flat()

  const answer = await chatComplete(config, extract_system_prompt(), buildExtractionPrompt(pages))
  const coded = JSON.parse(
    code_from_lines(answer, JSON.stringify(lines.map((l) => l.text))),
  ) as Coded

  if (coded.drafts.length === 0) {
    return { proposed: 0, dropped: coded.dropped }
  }

  const record = buildProposalRecord({
    // `local-` keeps it clear of the envelope message ids node proposals use,
    // and hashing the source means re-reading the same page updates the pending
    // record through the existing dedupe rather than stacking a second one.
    id: `local-${sourceSha}`,
    fromEd: session.identity.ed25519_public_hex,
    mailboxItemId: '',
    sentAt: Date.now(),
    local: true,
    drafts: coded.drafts.map((draft) => ({
      event: toDraftEvent(draft, sourceSha),
      source_blob: sourceSha,
      method: METHOD,
      model: config.model,
    })),
  })
  await upsertProposal(record)

  return { proposed: record.drafts.length, dropped: coded.dropped, proposalId: record.id }
}
