// HTTP client for the zero-knowledge relay. Every request is authenticated by an
// Ed25519 signature over a canonical descriptor; the signing bytes are defined
// once in `core` and produced here via the wasm `sign_request` binding, so the
// browser and relay agree exactly. The relay stores opaque ciphertext — seal
// before uploading and open after downloading (see `WasmDataKey`).
import type { WasmIdentity } from './svastha'
import { contract_version } from './svastha'
import { toHex } from './hex'

/** Strip a trailing slash so `${url}/v0/...` never double-slashes. */
export function normalizeRelayUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/** One entry in a `GET /v0/mailbox` listing: an id and the depositor's hex
 * Ed25519 public key. */
export interface MailboxItem {
  id: string
  from: string
}

/**
 * Version-negotiate with a relay before trusting it with anything: fetch its
 * unauthenticated `/v0/info` and compare `contract_version`. Throws a
 * user-facing message either way (network failure vs. version mismatch), so
 * Settings and Onboard can show the error directly.
 */
export async function checkRelayInfo(baseUrl: string): Promise<void> {
  let res: Response
  try {
    res = await fetch(`${baseUrl}/v0/info`)
  } catch {
    throw new Error('Could not reach the relay — check the address and your connection.')
  }
  if (!res.ok) {
    throw new Error('Could not reach the relay — check the address and your connection.')
  }
  const body = (await res.json()) as { contract_version: number }
  const ours = contract_version()
  if (body.contract_version !== ours) {
    throw new Error(
      `This relay speaks contract v${body.contract_version}, this app v${ours} — update the older one.`,
    )
  }
}

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

  // --- grants: relay-level read authorization for household sharing ---

  /** Authorize `granteeHex` (an Ed25519 public key, hex) to read this
   * identity's shared blobs. Idempotent. */
  async putGrant(granteeHex: string): Promise<void> {
    const res = await this.fetch('PUT', `/v0/grants/${granteeHex}`)
    if (!res.ok) throw new Error(`putGrant ${granteeHex}: ${res.status}`)
  }

  /** Revoke a grant; resolves to whether one existed. */
  async deleteGrant(granteeHex: string): Promise<boolean> {
    const res = await this.fetch('DELETE', `/v0/grants/${granteeHex}`)
    if (res.status === 404) return false
    if (!res.ok) throw new Error(`deleteGrant ${granteeHex}: ${res.status}`)
    return true
  }

  /** Everyone this identity has granted read access to (hex Ed25519 keys). */
  async listGrants(): Promise<string[]> {
    const res = await this.fetch('GET', '/v0/grants')
    if (!res.ok) throw new Error(`listGrants: ${res.status}`)
    const body = (await res.json()) as { grantees: string[] }
    return body.grantees
  }

  // --- shared: reading a vault someone else granted this identity ---

  /** Everyone who has granted this identity read access to their vault. */
  async listShared(): Promise<string[]> {
    const res = await this.fetch('GET', '/v0/shared')
    if (!res.ok) throw new Error(`listShared: ${res.status}`)
    const body = (await res.json()) as { owners: string[] }
    return body.owners
  }

  /** List `ownerHex`'s blob ids, or `null` if there is no live grant (the
   * grant was revoked, or never existed) — the relay answers the same `404`
   * either way, so this can't distinguish "revoked" from "never shared". */
  async listSharedBlobs(ownerHex: string): Promise<string[] | null> {
    const res = await this.fetch('GET', `/v0/shared/${ownerHex}/blobs`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`listSharedBlobs ${ownerHex}: ${res.status}`)
    const body = (await res.json()) as { ids: string[] }
    return body.ids
  }

  /** Fetch one of `ownerHex`'s blobs, or `null` if there is no live grant or
   * no such blob (see {@link listSharedBlobs}'s note on the shared `404`). */
  async getSharedBlob(ownerHex: string, id: string): Promise<Uint8Array | null> {
    const res = await this.fetch('GET', `/v0/shared/${ownerHex}/blobs/${id}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`getSharedBlob ${ownerHex}/${id}: ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  // --- mailbox: a store-and-forward drop box for wrapped vault keys ---

  /** Deposit an item for `recipientHex`. Any authed identity may deposit into
   * any mailbox — see `spec/README.md`'s "Mailbox" section. */
  async putMailbox(recipientHex: string, id: string, blob: Uint8Array): Promise<void> {
    const res = await this.fetch('PUT', `/v0/mailbox/${recipientHex}/${id}`, blob)
    if (!res.ok) throw new Error(`putMailbox ${recipientHex}/${id}: ${res.status}`)
  }

  /** List this identity's mailbox items (no bodies). */
  async listMailbox(): Promise<MailboxItem[]> {
    const res = await this.fetch('GET', '/v0/mailbox')
    if (!res.ok) throw new Error(`listMailbox: ${res.status}`)
    const body = (await res.json()) as { items: MailboxItem[] }
    return body.items
  }

  /** Fetch one mailbox item, or `null` if it doesn't exist. `from` is the
   * relay's attestation of the depositor's identity (the `svastha-from`
   * response header), not a claim the payload makes about itself. */
  async getMailbox(id: string): Promise<{ blob: Uint8Array; from: string } | null> {
    const res = await this.fetch('GET', `/v0/mailbox/${id}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`getMailbox ${id}: ${res.status}`)
    const from = res.headers.get('svastha-from') ?? ''
    return { blob: new Uint8Array(await res.arrayBuffer()), from }
  }

  /** Delete a mailbox item; resolves to whether one existed. */
  async deleteMailbox(id: string): Promise<boolean> {
    const res = await this.fetch('DELETE', `/v0/mailbox/${id}`)
    if (res.status === 404) return false
    if (!res.ok) throw new Error(`deleteMailbox ${id}: ${res.status}`)
    return true
  }

  // --- shares: sealed bundles a doctor fetches by an unguessable bearer token ---

  /** Upload (or replace) a sealed share bundle under `token`, tagged with the
   * owner's desired expiry (Unix seconds) in the `svastha-share-expires` header.
   * The relay clamps the expiry and never sees the per-share key that decrypts
   * the bundle — it rides the link's URL fragment. The expiry header is advisory
   * metadata, deliberately outside the signed request preimage (see
   * `spec/README.md`'s "Shares"), so it is added after signing. */
  async putShare(token: string, sealed: Uint8Array, expiresAt: number): Promise<void> {
    const res = await this.fetch('PUT', `/v0/share/${token}`, sealed, {
      'svastha-share-expires': String(expiresAt),
    })
    if (!res.ok) throw new Error(`putShare ${token}: ${res.status}`)
  }

  /** Revoke a share; resolves to whether one existed for this owner. A `404`
   * (never existed, or not this identity's share) resolves `false`. */
  async deleteShare(token: string): Promise<boolean> {
    const res = await this.fetch('DELETE', `/v0/share/${token}`)
    if (res.status === 404) return false
    if (!res.ok) throw new Error(`deleteShare ${token}: ${res.status}`)
    return true
  }

  private fetch(
    method: string,
    path: string,
    body?: Uint8Array,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const payload = body ?? new Uint8Array()
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = this.identity.sign_request(method, path, payload, BigInt(timestamp))
    const init: RequestInit = {
      method,
      headers: {
        'svastha-public-key': this.identity.ed25519_public_hex,
        'svastha-timestamp': String(timestamp),
        'svastha-signature': toHex(signature),
        ...extraHeaders,
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
