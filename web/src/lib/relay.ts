// HTTP client for the zero-knowledge relay. Every request is authenticated by an
// Ed25519 signature over a canonical descriptor; the signing bytes are defined
// once in `core` and produced here via the wasm `sign_request` binding, so the
// browser and relay agree exactly. The relay stores opaque ciphertext — seal
// before uploading and open after downloading (see `WasmDataKey`).
import type { WasmIdentity } from './svastha'
import { toHex } from './hex'

export class RelayClient {
  /**
   * @param baseUrl relay origin, e.g. `http://127.0.0.1:8787` (no trailing slash)
   * @param identity signs each request and is the owner blobs are scoped to
   */
  constructor(
    private readonly baseUrl: string,
    private readonly identity: WasmIdentity,
  ) {}

  /** Store (or replace) a blob under `id` for this identity. */
  async putBlob(id: string, blob: Uint8Array): Promise<void> {
    const res = await this.fetch('PUT', `/v0/blobs/${id}`, blob)
    if (!res.ok) throw new Error(`putBlob ${id}: ${res.status}`)
  }

  /** Fetch a blob, or `null` if this identity has none under `id`. */
  async getBlob(id: string): Promise<Uint8Array | null> {
    const res = await this.fetch('GET', `/v0/blobs/${id}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`getBlob ${id}: ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  /** List the blob ids this identity has stored. */
  async listBlobs(): Promise<string[]> {
    const res = await this.fetch('GET', '/v0/blobs')
    if (!res.ok) throw new Error(`listBlobs: ${res.status}`)
    const body = (await res.json()) as { ids: string[] }
    return body.ids
  }

  /** Delete a blob; resolves to whether one existed. */
  async deleteBlob(id: string): Promise<boolean> {
    const res = await this.fetch('DELETE', `/v0/blobs/${id}`)
    if (res.status === 404) return false
    if (!res.ok) throw new Error(`deleteBlob ${id}: ${res.status}`)
    return true
  }

  private fetch(method: string, path: string, body?: Uint8Array): Promise<Response> {
    const payload = body ?? new Uint8Array()
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = this.identity.sign_request(method, path, payload, BigInt(timestamp))
    const init: RequestInit = {
      method,
      headers: {
        'svastha-public-key': this.identity.ed25519_public_hex,
        'svastha-timestamp': String(timestamp),
        'svastha-signature': toHex(signature),
      },
    }
    // GET/DELETE carry no body; fetch rejects a body on those methods. The cast
    // bridges TS's generic Uint8Array and the DOM BodyInit union — a Uint8Array
    // is a valid fetch body at runtime.
    if (body && method !== 'GET' && method !== 'DELETE') {
      init.body = body as BodyInit
    }
    return fetch(this.baseUrl + path, init)
  }
}
