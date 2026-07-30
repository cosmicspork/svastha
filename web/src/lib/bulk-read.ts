import { attachmentBytes, getAttachment } from './attachments'
import { allEvents, type StoredEvent } from './events'
import { UnreadablePageError } from './ocr'
import { listProposals, type ProposalRecord } from './proposals'
import { readAndPropose, UnreadableAnswerError, type ReadResult } from './read-page'
import { buildTimeline } from './timeline'

/** One attachment the owner can still ask this device to read. */
export interface BulkPage {
  sha256: string
  mime: string
  label: string
}

export interface BulkReadSummary {
  read: number
  nothingFound: number
  unreadable: number
  completed: number
  total: number
  stopped: boolean
}

export interface BulkReadProgress extends BulkReadSummary {
  current: BulkPage | null
}

type EventWithProposal = StoredEvent['event'] & { proposed?: { source_blob?: string } }

function proposalSources(events: StoredEvent[], records: ProposalRecord[]): Set<string> {
  const sources = new Set<string>()
  for (const record of records) {
    for (const draft of record.drafts) {
      if (draft.source_blob) sources.add(draft.source_blob)
      if (draft.event.provenance.source === 'ocr' && draft.event.provenance.source_doc) {
        sources.add(draft.event.provenance.source_doc)
      }
    }
  }
  for (const { event } of events) {
    const proposed = (event as EventWithProposal).proposed
    if (proposed?.source_blob) sources.add(proposed.source_blob)
    if (event.provenance.source === 'ocr' && event.provenance.source_doc) {
      sources.add(event.provenance.source_doc)
    }
  }
  return sources
}

/**
 * The captured attachment pages that still have no draft in Proposals.
 *
 * A page has to be both referenced by the record and present in this device's
 * attachment store. This avoids offering a stale synced event whose bytes have
 * not arrived yet, and uses proposal provenance rather than a second read
 * ledger to make a later run naturally resume at the remaining pages.
 */
export async function unreadAttachmentPages(): Promise<BulkPage[]> {
  const [events, records] = await Promise.all([allEvents(), listProposals()])
  const sources = proposalSources(events, records)
  const pages: BulkPage[] = []
  const seen = new Set<string>()

  for (const entry of buildTimeline(events, 'all').flatMap((day) => day.entries)) {
    for (const page of entry.attachments ?? []) {
      if (seen.has(page.sha256) || sources.has(page.sha256)) continue
      seen.add(page.sha256)
      if (await getAttachment(page.sha256)) {
        pages.push({ sha256: page.sha256, mime: page.mime, label: entry.label })
      }
    }
  }

  return pages
}

/** Read one stored attachment through the existing per-page pipeline. */
export async function readAttachmentPage(page: BulkPage): Promise<ReadResult> {
  const bytes = await attachmentBytes(page.sha256)
  if (!bytes) throw new Error('This attachment is no longer available on this device.')
  return readAndPropose(page.sha256, bytes, page.mime)
}

/**
 * Run the supplied unread pages one at a time. The stop predicate is examined
 * only after a page settles, so a stop preserves that page's written proposal
 * and leaves every later page for the next discovery pass.
 */
export async function runBulkRead(
  pages: BulkPage[],
  readPage: (page: BulkPage) => Promise<ReadResult>,
  options: {
    shouldStop?: () => boolean
    onProgress?: (progress: BulkReadProgress) => void
  } = {},
): Promise<BulkReadSummary> {
  const summary: BulkReadSummary = {
    read: 0,
    nothingFound: 0,
    unreadable: 0,
    completed: 0,
    total: pages.length,
    stopped: false,
  }
  const report = (current: BulkPage | null) => options.onProgress?.({ ...summary, current })

  for (const page of pages) {
    if (options.shouldStop?.()) {
      summary.stopped = true
      break
    }
    report(page)
    try {
      const result = await readPage(page)
      if (result.proposed > 0) summary.read++
      else summary.nothingFound++
    } catch (err) {
      if (err instanceof UnreadablePageError || err instanceof UnreadableAnswerError) {
        summary.unreadable++
      } else {
        throw err
      }
    }
    summary.completed++
    report(null)
    if (options.shouldStop?.()) {
      summary.stopped = true
      break
    }
  }

  return summary
}
