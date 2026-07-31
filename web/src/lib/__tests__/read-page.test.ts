import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const wasm = vi.hoisted(() => ({
  initSvastha: vi.fn(async () => {}),
  extract_system_prompt: vi.fn(() => 'SYSTEM'),
  extract_user_prompt: vi.fn(() => 'SCHEMA'),
  code_from_lines: vi.fn(),
  event_id: vi.fn(() => 'deadbeef'),
}))
vi.mock('../svastha', () => wasm)

const engines = vi.hoisted(() => ({
  pdf: vi.fn(async () => [] as unknown[]),
  image: vi.fn(async () => [] as unknown[]),
}))
vi.mock('../pdf', () => ({ pdfTextEngine: { recognizePages: engines.pdf } }))
vi.mock('../ocr-engine', () => ({ imageOcrEngine: { recognize: engines.image } }))

const inference = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  chatComplete: vi.fn(),
}))
vi.mock('../inference', async () => {
  class InferenceError extends Error {}
  return { ...inference, InferenceError, normalizeEndpoint: (s: string) => s }
})

// A faithful stand-in for the store: it answers whether a proposal exists and
// replaces it on upsert, the parts of the real store readAndPropose needs.
const stored = vi.hoisted(() => ({ records: [] as { id: string; drafts: unknown[] }[] }))
vi.mock('../proposals', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../proposals')
  return {
    ...actual,
    getProposal: vi.fn(async (id: string) => stored.records.find((record) => record.id === id)),
    upsertProposal: vi.fn(async (r: { id: string; drafts: unknown[] }) => {
      const index = stored.records.findIndex((seen) => seen.id === r.id)
      if (index >= 0) {
        stored.records[index] = r
        return false
      }
      stored.records.push(r)
      return true
    }),
  }
})
const ocr = vi.hoisted(() => ({
  assetsEnabled: vi.fn(async () => true),
  pageReadingEnabled: vi.fn(async () => true),
}))
vi.mock('../ocr-assets', () => ocr)
vi.mock('../session.svelte', () => ({
  session: { identity: { ed25519_public_hex: 'owner-ed' } },
}))
vi.mock('../db', () => ({ get: vi.fn(), put: vi.fn(), del: vi.fn(), getAll: vi.fn(async () => []) }))

// The Answers preference, which page reading follows too. Only the stored value
// is faked; the rule itself (`answersHere`) is the real one.
const where = vi.hoisted(() => ({ value: 'auto' as 'auto' | 'device' | 'node' }))
vi.mock('../answerWhere', async () => {
  const actual = await vi.importActual<typeof import('../answerWhere')>('../answerWhere')
  return { ...actual, loadAnswerWhere: vi.fn(async () => where.value) }
})

import {
  readAndPropose,
  transcribe,
  buildExtractionPrompt,
  UnreadablePageError,
  UnreadableAnswerError,
  ReadingOffError,
  PAGES_PER_PASS,
} from '../read-page'
import { renderColumns } from '../ocr-layout'
import { InferenceError } from '../inference'
import type { OcrLine, OcrWord } from '../ocr'

const line = (index: number, text: string) => ({
  index,
  words: [{ text, x0: 0, x1: 10, y0: index * 10, y1: index * 10 + 8, conf: 1 }],
  text,
  y: index * 10,
})

const PANEL = [line(1, 'Sodium 139 mmol/L 135-145'), line(2, 'Potassium 4.1 mmol/L 3.5-5.1')]

const word = (text: string, x0: number, x1: number): OcrWord => ({
  text,
  x0,
  x1,
  y0: 0,
  y1: 8,
  conf: 1,
})
const row = (index: number, words: OcrWord[]): OcrLine => ({
  index,
  words,
  text: words.map((w) => w.text).join(' '),
  y: 0,
})

/** `count` single-line pages, each naming its own page number. */
const longDocument = (count: number): OcrLine[][] =>
  Array.from({ length: count }, (_, i) => [row(1, [word(`page`, 0, 30), word(`${i + 1}`, 40, 60)])])

beforeEach(() => {
  stored.records = []
  ocr.assetsEnabled.mockResolvedValue(true)
  ocr.pageReadingEnabled.mockResolvedValue(true)
  for (const fn of [...Object.values(wasm), ...Object.values(engines), ...Object.values(inference)]) {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as { mockReset: () => void }).mockReset()
  }
  wasm.extract_system_prompt.mockReturnValue('SYSTEM')
  wasm.extract_user_prompt.mockReturnValue('SCHEMA')
  wasm.event_id.mockReturnValue('deadbeef')
  engines.pdf.mockResolvedValue([])
  engines.image.mockResolvedValue([])
  inference.loadConfig.mockResolvedValue({ endpoint: 'https://x/v1', model: 'm', apiKey: 'sk' })
})
afterEach(() => vi.restoreAllMocks())

describe('transcribe', () => {
  it('prefers the exact PDF text layer over the recognizer', async () => {
    engines.pdf.mockResolvedValue([PANEL])
    expect(await transcribe(new Uint8Array(), 'application/pdf')).toEqual([PANEL])
    expect(engines.image).not.toHaveBeenCalled()
  })

  it('falls back to the recognizer for images', async () => {
    engines.image.mockResolvedValue(PANEL)
    expect(await transcribe(new Uint8Array(), 'image/jpeg')).toEqual([PANEL])
  })

  // "No text" and "not read" are indistinguishable from here, and only one of
  // them is safe to assume about a medical document.
  it('refuses rather than reporting an unreadable page as empty', async () => {
    await expect(transcribe(new Uint8Array(), 'image/jpeg')).rejects.toBeInstanceOf(
      UnreadablePageError,
    )
  })

  it('names lazy preparation when a default-enabled reader has not verified its assets', async () => {
    ocr.assetsEnabled.mockResolvedValue(false)

    const err = await transcribe(new Uint8Array(), 'image/jpeg').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ReadingOffError)
    expect((err as Error).message).toBe(
      'Reading pages needs its one-time download before it can read this page.',
    )
  })

  // A PDF with no text layer is a scan. Whether the recognizer is switched on
  // is the one thing about that the owner can change, so it is what the error
  // has to say — and only when it is true.
  it('names the switch when a scan meets a reader that is off', async () => {
    ocr.pageReadingEnabled.mockResolvedValue(false)
    ocr.assetsEnabled.mockResolvedValue(false)
    const err = await transcribe(new Uint8Array(), 'application/pdf').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ReadingOffError)
    expect((err as Error).message).toBe(
      "This PDF is a scan, and reading scans on this device isn't switched on.",
    )
  })

  it('does not offer the switch for a scan when the reader is already on', async () => {
    ocr.assetsEnabled.mockResolvedValue(true)
    const err = await transcribe(new Uint8Array(), 'application/pdf').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UnreadablePageError)
    expect(err).not.toBeInstanceOf(ReadingOffError)
    expect((err as Error).message).not.toContain('switched on')
  })
})

describe('buildExtractionPrompt', () => {
  it('sends the page both column-aligned and numbered', () => {
    const prompt = buildExtractionPrompt([PANEL])
    expect(prompt).toContain('SCHEMA')
    expect(prompt).toContain('[1] Sodium 139 mmol/L 135-145')
    expect(prompt).toContain('[2] Potassium 4.1 mmol/L 3.5-5.1')
    expect(prompt).toContain('columns preserved')
  })

  // A column scale shared across the whole document lets one page's full-bleed
  // element squash another page's table flat — which is the row-major collapse
  // the column view exists to prevent.
  it("scales columns per page, so one page's outlier cannot flatten another's", () => {
    const page1 = [row(1, [word('Potassium', 0, 60), word('4.1', 70, 90)])]
    const page2 = [row(2, [word('Ordered by', 0, 60), word('| page 2 of 2', 5000, 5100)])]

    const prompt = buildExtractionPrompt([page1, page2])

    expect(prompt).toContain(renderColumns(page1))
    // Analyte and value stay in separate columns rather than colliding.
    expect(prompt).toMatch(/Potassium {5,}4\.1/)
  })

  it('numbers lines continuously across pages', () => {
    const page1 = [row(1, [word('one', 0, 30)])]
    const page2 = [row(2, [word('two', 0, 30)])]
    const prompt = buildExtractionPrompt([page1, page2])
    expect(prompt).toContain('[1] one')
    expect(prompt).toContain('[2] two')
  })
})

describe('readAndPropose', () => {
  beforeEach(() => {
    where.value = 'auto'
    engines.image.mockResolvedValue(PANEL)
    inference.chatComplete.mockResolvedValue('{"findings":[]}')
    wasm.code_from_lines.mockReturnValue('{"drafts":[],"dropped":0}')
  })

  // Reading a page is inference over the same record as answering, so it obeys
  // the same choice. An owner who sent their AI work to the node did not exempt
  // this one path — and it is the path that would quietly send a page to an
  // endpoint they had just routed away from.
  it('does not read here when the owner sends AI work to the node', async () => {
    where.value = 'node'
    await expect(readAndPropose('sha1', new Uint8Array(), 'image/jpeg')).rejects.toThrow(
      /your node/i,
    )
    expect(inference.chatComplete).not.toHaveBeenCalled()
  })

  it('reads here when the owner chose this device', async () => {
    where.value = 'device'
    await readAndPropose('sha1', new Uint8Array(), 'image/jpeg')
    expect(inference.chatComplete).toHaveBeenCalled()
  })

  // The page image stays on the device: only the transcript is sent for coding.
  it('sends the transcript and never the page bytes', async () => {
    await readAndPropose('sha1', new Uint8Array([1, 2, 3]), 'image/jpeg')
    const [, system, user] = inference.chatComplete.mock.calls[0]
    expect(system).toBe('SYSTEM')
    expect(user).toContain('[1] Sodium 139 mmol/L 135-145')
    expect(JSON.stringify(inference.chatComplete.mock.calls[0])).not.toContain('Uint8Array')
  })

  // The guard runs against the transcript, in wasm, on the way back.
  it('hands the model reply and the exact lines to the verifier', async () => {
    await readAndPropose('sha1', new Uint8Array(), 'image/jpeg')
    const [answer, linesJson] = wasm.code_from_lines.mock.calls[0]
    expect(answer).toBe('{"findings":[]}')
    expect(JSON.parse(linesJson as string)).toEqual([
      'Sodium 139 mmol/L 135-145',
      'Potassium 4.1 mmol/L 3.5-5.1',
    ])
  })

  it('files verified drafts as a local proposal under the owner', async () => {
    wasm.code_from_lines.mockReturnValue(
      '{"drafts":[{"kind":"observation","code":null,"effective_at":null,"value":{"text":"x"}}],"dropped":2}',
    )
    const result = await readAndPropose('sha1', new Uint8Array(), 'image/jpeg')

    expect(result).toEqual({
      proposed: 1,
      dropped: 2,
      proposalId: 'local-sha1',
      updated: false,
      fromPage: 1,
      toPage: 1,
      totalPages: 1,
    })
    const record = stored.records[0] as {
      id: string
      fromEd: string
      local: boolean
      mailboxItemId: string
      drafts: { status: string; source_blob: string; method: string; model: string }[]
    }
    expect(record.id).toBe('local-sha1')
    expect(record.fromEd).toBe('owner-ed')
    expect(record.local).toBe(true)
    // No envelope, so no mailbox item to delete on resolution.
    expect(record.mailboxItemId).toBe('')
    // Still pending: reading proposes, approving signs.
    expect(record.drafts[0].status).toBe('pending')
    expect(record.drafts[0].source_blob).toBe('sha1')
    expect(record.drafts[0].method).toBe('ocr')
    expect(record.drafts[0].model).toBe('m')
  })

  // Re-reading the same page must update the pending record, not stack a second
  // — and must say which of the two it did.
  it('keys the record on the source page so a re-read dedupes, and reports it', async () => {
    wasm.code_from_lines.mockReturnValue(
      '{"drafts":[{"kind":"observation","code":null,"effective_at":null,"value":{"text":"x"}}],"dropped":0}',
    )
    const a = await readAndPropose('sha1', new Uint8Array(), 'image/jpeg')
    const b = await readAndPropose('sha1', new Uint8Array(), 'image/jpeg')
    expect(a.proposalId).toBe(b.proposalId)
    expect(a.updated).toBe(false)
    expect(b.updated).toBe(true)
  })

  it('proposes nothing when every finding was dropped', async () => {
    wasm.code_from_lines.mockReturnValue('{"drafts":[],"dropped":3}')
    expect(await readAndPropose('sha1', new Uint8Array(), 'image/jpeg')).toEqual({
      proposed: 0,
      dropped: 3,
      updated: false,
      fromPage: 1,
      toPage: 1,
      totalPages: 1,
    })
    expect(stored.records).toHaveLength(0)
  })

  it('clears pending proposals when a re-read finds no entries', async () => {
    wasm.code_from_lines.mockReturnValue(
      '{"drafts":[{"kind":"observation","code":null,"effective_at":null,"value":{"text":"x"}}],"dropped":0}',
    )
    await readAndPropose('sha1', new Uint8Array(), 'image/jpeg')

    wasm.code_from_lines.mockReturnValue('{"drafts":[],"dropped":0,"unparseable":false}')
    expect(await readAndPropose('sha1', new Uint8Array(), 'image/jpeg')).toMatchObject({
      proposed: 0,
      updated: true,
    })
    expect(stored.records[0].drafts).toEqual([])
  })

  // "I could not parse this reply" is a formatting failure worth retrying;
  // "this page has nothing on it" is a conclusion about the page. Reporting the
  // first as the second tells the owner a readable page was blank.
  it('raises an unparseable answer instead of calling the page empty', async () => {
    wasm.code_from_lines.mockReturnValue('{"drafts":[],"dropped":0,"unparseable":true}')
    await expect(readAndPropose('sha1', new Uint8Array(), 'image/jpeg')).rejects.toBeInstanceOf(
      UnreadableAnswerError,
    )
    expect(stored.records).toHaveLength(0)
  })

  it('treats an empty findings list as a statement about the page', async () => {
    wasm.code_from_lines.mockReturnValue('{"drafts":[],"dropped":0,"unparseable":false}')
    expect(await readAndPropose('sha1', new Uint8Array(), 'image/jpeg')).toMatchObject({
      proposed: 0,
      dropped: 0,
    })
  })

  it('refuses without a configured endpoint', async () => {
    inference.loadConfig.mockResolvedValue(null)
    await expect(readAndPropose('sha1', new Uint8Array(), 'image/jpeg')).rejects.toBeInstanceOf(
      InferenceError,
    )
  })
})

describe('readAndPropose over a long document', () => {
  beforeEach(() => {
    engines.pdf.mockResolvedValue(longDocument(32))
    inference.chatComplete.mockResolvedValue('{"findings":[]}')
    wasm.code_from_lines.mockReturnValue('{"drafts":[],"dropped":0,"unparseable":false}')
  })

  // A whole report in one prompt is silently truncated past the context window,
  // and the guard can only check what it was sent.
  it('sends one capped chunk and reports the span it covered', async () => {
    const result = await readAndPropose('sha1', new Uint8Array(), 'application/pdf')

    expect(result).toMatchObject({ fromPage: 1, toPage: PAGES_PER_PASS, totalPages: 32 })
    const user = inference.chatComplete.mock.calls[0][2] as string
    expect(user).toContain(`[${PAGES_PER_PASS}] page ${PAGES_PER_PASS}`)
    expect(user).not.toContain(`page ${PAGES_PER_PASS + 1}`)
  })

  // The guard resolves a cited number against the list that was sent, so a
  // later chunk's numbering has to be that list's — not the document's.
  it('numbers a later chunk from one, matching what the guard checks against', async () => {
    const result = await readAndPropose('sha1', new Uint8Array(), 'application/pdf', 11)

    expect(result).toMatchObject({ fromPage: 11, toPage: 20, totalPages: 32 })
    const user = inference.chatComplete.mock.calls[0][2] as string
    expect(user).toContain('[1] page 11')
    expect(user).not.toContain('page 10')
    const lines = JSON.parse(wasm.code_from_lines.mock.calls[0][1] as string) as string[]
    expect(lines[0]).toBe('page 11')
    expect(lines).toHaveLength(PAGES_PER_PASS)
  })

  it('reads the short last chunk without running past the end', async () => {
    const result = await readAndPropose('sha1', new Uint8Array(), 'application/pdf', 31)
    expect(result).toMatchObject({ fromPage: 31, toPage: 32, totalPages: 32 })
    expect(JSON.parse(wasm.code_from_lines.mock.calls[0][1] as string)).toHaveLength(2)
  })

  // Each chunk is its own pending group: continuing a long document adds to the
  // queue rather than replacing the chunk before it.
  it('files each chunk under its own record', async () => {
    wasm.code_from_lines.mockReturnValue(
      '{"drafts":[{"kind":"observation","code":null,"effective_at":null,"value":{"text":"x"}}],"dropped":0}',
    )
    const first = await readAndPropose('sha1', new Uint8Array(), 'application/pdf', 1)
    const second = await readAndPropose('sha1', new Uint8Array(), 'application/pdf', 11)
    expect(first.proposalId).toBe('local-sha1')
    expect(second.proposalId).toBe('local-sha1-p11')
    expect(second.updated).toBe(false)
  })
})
