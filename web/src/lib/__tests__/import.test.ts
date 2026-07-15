// Pure, wasm-free parts of import.ts: file-type detection, XDM zip
// path-filtering (against the committed fixture), the sha256 helper, and the
// plan-aggregation math. commitImport/analyzeDoc need a wasm backend and a
// real session, so those are exercised by e2e/import.spec.ts instead.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  docsFromFile,
  docsFromZip,
  projectedDocBlobBytes,
  RELAY_MAX_BLOB_BYTES,
  sha256Hex,
  totalsOf,
  type DocPlan,
} from '../import'
// Ambient types for the Node builtins below — see ./node-builtins.d.ts.

const here = dirname(fileURLToPath(import.meta.url))
const xdmZipPath = join(here, '../../../../fixtures/xdm/minimal-xdm.zip')

describe('docsFromFile', () => {
  it('treats a .xml file as one C-CDA document', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const file = new File([bytes], 'DOC0001.XML', { type: 'text/xml' })
    expect(await docsFromFile(file)).toEqual([{ name: 'DOC0001.XML', bytes, kind: 'ccda' }])
  })

  it('treats a .json file as one FHIR bundle document', async () => {
    const bytes = new TextEncoder().encode('{}')
    const file = new File([bytes], 'bundle.json', { type: 'application/json' })
    expect(await docsFromFile(file)).toEqual([{ name: 'bundle.json', bytes, kind: 'fhir' }])
  })

  it('is case-insensitive on extension', async () => {
    const file = new File([new Uint8Array()], 'BUNDLE.JSON')
    const [doc] = await docsFromFile(file)
    expect(doc.kind).toBe('fhir')
  })

  it('treats anything else (no recognized extension) as a C-CDA document', async () => {
    const file = new File([new Uint8Array()], 'summary-of-care')
    const [doc] = await docsFromFile(file)
    expect(doc.kind).toBe('ccda')
  })

  it('unpacks a .zip into its XDM documents', async () => {
    const bytes = readFileSync(xdmZipPath)
    const file = new File([bytes as BlobPart], 'export.zip')
    const docs = await docsFromFile(file)
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({ name: 'IHE_XDM/EXAMPLE1/DOC0001.XML', kind: 'ccda' })
  })
})

describe('docsFromZip (XDM path filtering)', () => {
  it('picks up only DOC*.XML files, not STYLE.XSL/INDEX.HTM/directories', async () => {
    const bytes = readFileSync(xdmZipPath)
    const docs = await docsFromZip(new Uint8Array(bytes))
    expect(docs.map((d) => d.name)).toEqual(['IHE_XDM/EXAMPLE1/DOC0001.XML'])
  })

  it('is case-insensitive on the DOC*.XML match', async () => {
    const { zipSync } = await import('fflate')
    const bytes = zipSync({ 'ihe_xdm/example1/doc0001.xml': new TextEncoder().encode('<a/>') })
    const docs = await docsFromZip(bytes)
    expect(docs.map((d) => d.name)).toEqual(['ihe_xdm/example1/doc0001.xml'])
  })

  it('ignores a zip with no IHE_XDM structure', async () => {
    const { zipSync } = await import('fflate')
    const bytes = zipSync({ 'readme.txt': new TextEncoder().encode('hi') })
    const docs = await docsFromZip(bytes)
    expect(docs).toEqual([])
  })
})

describe('sha256Hex', () => {
  it('matches a known SHA-256 vector', async () => {
    const bytes = new TextEncoder().encode('abc')
    expect(await sha256Hex(bytes)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('is deterministic', async () => {
    const bytes = new TextEncoder().encode('svastha')
    expect(await sha256Hex(bytes)).toBe(await sha256Hex(bytes))
  })
})

describe('projectedDocBlobBytes', () => {
  it('accounts for base64 inflation, the JSON envelope, and the AEAD seal', () => {
    // 3 raw bytes -> 4 base64 chars; envelope `{"name":"d","bytes":""}` is 23
    // bytes; seal overhead is 40. 4 + 23 + 40 = 67.
    expect(projectedDocBlobBytes('d', 3)).toBe(4 + 23 + 40)
  })

  it('flags a document whose projected blob exceeds the relay cap', () => {
    // ~12.1 MiB of raw bytes already blows past 16 MiB once base64'd (~4/3).
    const raw = 13 * 1024 * 1024
    expect(projectedDocBlobBytes('big.xml', raw)).toBeGreaterThan(RELAY_MAX_BLOB_BYTES)
    // A comfortably small document stays under the cap.
    expect(projectedDocBlobBytes('small.xml', 1024)).toBeLessThan(RELAY_MAX_BLOB_BYTES)
  })
})

describe('totalsOf', () => {
  function fakeDoc(partial: Partial<DocPlan>): DocPlan {
    return {
      name: 'doc',
      sha256: 'sha',
      drafts: [],
      draftIds: [],
      warnings: [],
      skipped: [],
      newCount: 0,
      dupCount: 0,
      bytes: new Uint8Array(),
      tooLargeToSync: false,
      ...partial,
    }
  }

  it('sums new/dup counts and warning/skipped list lengths across documents', () => {
    const docs = [
      fakeDoc({ newCount: 2, dupCount: 1, warnings: ['a'], skipped: [{ what: 'x', why: 'y' }] }),
      fakeDoc({ newCount: 3, dupCount: 0, warnings: [], skipped: [] }),
    ]
    expect(totalsOf(docs)).toEqual({ newCount: 5, dupCount: 1, warnings: 1, skipped: 1 })
  })

  it('is all zeros for no documents', () => {
    expect(totalsOf([])).toEqual({ newCount: 0, dupCount: 0, warnings: 0, skipped: 0 })
  })
})
