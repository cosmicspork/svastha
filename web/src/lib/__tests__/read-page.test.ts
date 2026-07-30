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

const stored = vi.hoisted(() => ({ records: [] as unknown[] }))
vi.mock('../proposals', async () => {
  const actual = await vi.importActual<typeof import('../proposals')>('../proposals')
  return {
    ...actual,
    upsertProposal: vi.fn(async (r: unknown) => {
      stored.records.push(r)
    }),
  }
})
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

import { readAndPropose, transcribe, buildExtractionPrompt, UnreadablePageError } from '../read-page'
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

beforeEach(() => {
  stored.records = []
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

    expect(result).toEqual({ proposed: 1, dropped: 2, proposalId: 'local-sha1' })
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

  // Re-reading the same page must update the pending record, not stack a second.
  it('keys the record on the source page so a re-read dedupes', async () => {
    wasm.code_from_lines.mockReturnValue(
      '{"drafts":[{"kind":"observation","code":null,"effective_at":null,"value":{"text":"x"}}],"dropped":0}',
    )
    const a = await readAndPropose('sha1', new Uint8Array(), 'image/jpeg')
    const b = await readAndPropose('sha1', new Uint8Array(), 'image/jpeg')
    expect(a.proposalId).toBe(b.proposalId)
  })

  it('proposes nothing when every finding was dropped', async () => {
    wasm.code_from_lines.mockReturnValue('{"drafts":[],"dropped":3}')
    expect(await readAndPropose('sha1', new Uint8Array(), 'image/jpeg')).toEqual({
      proposed: 0,
      dropped: 3,
    })
    expect(stored.records).toHaveLength(0)
  })

  it('refuses without a configured endpoint', async () => {
    inference.loadConfig.mockResolvedValue(null)
    await expect(readAndPropose('sha1', new Uint8Array(), 'image/jpeg')).rejects.toBeInstanceOf(
      InferenceError,
    )
  })
})
