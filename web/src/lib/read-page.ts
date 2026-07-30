// Reading a captured page on this device and proposing what it says.
//
// The whole path is local except one call: transcribe here, send only the text
// for coding, validate the reply here. The page image never leaves the device.
//
// **Local drafts skip the mailbox entirely.** The proposal mechanism exists
// because a node cannot sign as the owner, so its suggestions have to travel as
// sealed envelopes and be approved. This device *is* the owner: it holds the
// seed. So a page read here writes straight into the same review queue, and the
// existing approve/reject path signs it exactly as it signs a node's.
import {
  initSvastha,
  extract_system_prompt,
  extract_user_prompt,
  code_from_lines,
  event_id,
} from './svastha'
import { pdfTextEngine } from './pdf'
import { imageOcrEngine } from './ocr-engine'
import { assetsEnabled, pageReadingEnabled } from './ocr-assets'
import { numberedLines, renderColumns } from './ocr-layout'
import { UnreadablePageError, type OcrLine } from './ocr'
import { loadConfig, chatComplete, InferenceError } from './inference'
import { answersHere, loadAnswerWhere } from './answerWhere'
import { buildProposalRecord, getProposal, upsertProposal, type DraftEvent } from './proposals'
import { session } from './session.svelte'
import type { EventKind, EventValue } from './drafts'
import type { Code } from './codes'

/** How the extraction is recorded on every approved event's provenance. Kept as
 * `"ocr"` — the same value the node writes — so a provenance query does not have
 * to know which reader produced a fact. `model` carries the difference. */
const METHOD = 'ocr'

/**
 * How many pages one pass reads.
 *
 * A long report sent as a single prompt is slow, expensive, and — past the
 * endpoint's context window — silently truncated, which is the failure that
 * matters here: the source-line guard can only check a citation against the
 * lines it was given, so a prompt that lost its tail takes the model's word for
 * the pages nobody sent. The owner continues chunk by chunk instead.
 */
export const PAGES_PER_PASS = 10

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
  /** The answer was not a findings object at all — see `crates/import`'s
   * `Extraction::unparseable`. A formatting failure, not a verdict on the page. */
  unparseable: boolean
}

export { UnreadablePageError }

/** Nothing exact could be read and the on-device recognizer is switched off.
 * Its own type because it is the one reading failure the owner can fix from
 * where they hit it, so the UI can offer that instead of only naming it. */
export class ReadingOffError extends UnreadablePageError {}

/** The endpoint answered with something that was not a findings object. Kept
 * apart from "nothing on this page": one is worth retrying, and the other is a
 * conclusion about the page. */
export class UnreadableAnswerError extends Error {}

/**
 * Transcribe a document into its pages of lines. Tries the exact path first (a
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

  // Past here nothing exact was available: a scanned PDF, or a photograph.
  // Both need the on-device recognizer, so whether it is switched on is
  // answered before anything else — it is the only part of this the owner can
  // act on, and saying so once it is already on would be advice to nowhere.
  const needsRecognizer = mime === 'application/pdf' || mime.startsWith('image/')
  if (needsRecognizer && !(await assetsEnabled())) {
    const enabled = await pageReadingEnabled()
    throw new ReadingOffError(
      enabled
        ? 'Reading pages needs its one-time download before it can read this page.'
        : mime === 'application/pdf'
          ? "This PDF is a scan, and reading scans on this device isn't switched on."
          : "Reading pages on this device isn't switched on.",
    )
  }

  // The recognizer reads images, not PDFs: rasterizing a scanned PDF's pages
  // through it is not built yet, and claiming otherwise would send the owner
  // back to a switch that changes nothing.
  if (mime === 'application/pdf') {
    throw new UnreadablePageError(
      "This PDF is a scan, and this device can't read scanned PDFs yet. A photo of the page can be read.",
    )
  }

  const recognized = await imageOcrEngine.recognize(bytes, mime)
  if (recognized.length > 0) return [recognized]

  throw new UnreadablePageError(
    "Couldn't read this page — nothing legible was found on it, and handwriting isn't supported.",
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
 * across everything it is handed, because a cited line number is resolved
 * against exactly that — the lines the guard is later given to check.
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
  /** This chunk had already been read, and the pass replaced its pending
   * drafts rather than filing a new group. */
  updated: boolean
  /** The pages this pass covered, 1-based and inclusive, and how many the
   * document has — what tells a caller whether there is more to read. */
  fromPage: number
  toPage: number
  totalPages: number
}

/**
 * The pending group a pass files into.
 *
 * `local-` keeps it clear of the envelope message ids node proposals use, and
 * hashing the source is what makes re-reading a page update its group instead
 * of stacking a second one. Chunks past the first get their own group, so
 * continuing a long document adds to the queue rather than replacing the chunk
 * before it — and the first keeps the bare form that records written before
 * chunking existed are already stored under.
 */
function proposalIdFor(sourceSha: string, fromPage: number): string {
  return fromPage === 1 ? `local-${sourceSha}` : `local-${sourceSha}-p${fromPage}`
}

/**
 * Read one captured page — or one {@link PAGES_PER_PASS}-page chunk of a longer
 * document, starting at `fromPage` — and file what it says into the review
 * queue.
 *
 * `sourceSha` is the attachment's content hash, which rides onto every draft's
 * provenance so an approved event points back at the page it was read from.
 */
export async function readAndPropose(
  sourceSha: string,
  bytes: Uint8Array,
  mime: string,
  fromPage = 1,
): Promise<ReadResult> {
  const config = await loadConfig()
  // Reading a page is inference over the same record, so it follows the same
  // choice answering does (Settings → AI): an owner who sent their AI work to
  // the node did not exempt this one path from that.
  if (!answersHere(await loadAnswerWhere(), !!config?.endpoint && !!config.model)) {
    throw new InferenceError(
      'Your Answers setting sends AI work to your node, so this page is not read here (Settings → AI).',
    )
  }
  if (!config?.endpoint || !config.model) {
    throw new InferenceError(
      'No inference endpoint is configured on this device (Settings → AI).',
    )
  }
  if (!session.identity) throw new Error('Unlock the vault before reading a page.')

  await initSvastha()
  const document = await transcribe(bytes, mime)
  const totalPages = document.length
  const start = Math.min(Math.max(fromPage, 1), totalPages)
  const toPage = Math.min(start + PAGES_PER_PASS - 1, totalPages)
  // Numbering restarts at 1 for the chunk. The guard resolves a cited number
  // against the list of lines it is handed, which is this chunk's — numbers
  // carried over from the whole document would point past the end of it.
  let numbered = 0
  const chunk = document
    .slice(start - 1, toPage)
    .map((page) => page.map((line) => ({ ...line, index: ++numbered })))
  const lines = chunk.flat()
  const span = { fromPage: start, toPage, totalPages }

  const answer = await chatComplete(config, extract_system_prompt(), buildExtractionPrompt(chunk))
  const coded = JSON.parse(
    code_from_lines(answer, JSON.stringify(lines.map((l) => l.text))),
  ) as Coded

  if (coded.unparseable) {
    throw new UnreadableAnswerError("Your endpoint's answer couldn't be read. Try again.")
  }

  const record = buildProposalRecord({
    id: proposalIdFor(sourceSha, start),
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

  if (record.drafts.length === 0) {
    // A fresh empty read needs no persistent group. On a re-read, however, an
    // empty incoming set is what replaces the old pending drafts; decisions
    // remain because upsertProposal merges them back.
    if (await getProposal(record.id)) {
      await upsertProposal(record)
      return { proposed: 0, dropped: coded.dropped, updated: true, ...span }
    }
    return { proposed: 0, dropped: coded.dropped, updated: false, ...span }
  }

  const created = await upsertProposal(record)

  return {
    proposed: record.drafts.length,
    dropped: coded.dropped,
    proposalId: record.id,
    updated: !created,
    ...span,
  }
}

/** What the viewer draws over the page after a read: the outcome, and what the
 * owner can do about it. Carries the page's content hash so paging away in the
 * viewer hides it without a dismissal handshake. */
export interface ReadNotice {
  sha256: string
  tone: 'ok' | 'error'
  text: string
  /** A second line — which pages the pass covered, when more remain. */
  detail?: string
  actions: ReadNoticeAction[]
}

export interface ReadNoticeAction {
  label: string
  /** Styled with the app's own button classes (see `styles/base.css`). */
  kind: 'primary' | 'tonal' | 'ghost'
  onclick: () => void | Promise<void>
}
