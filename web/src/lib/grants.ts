// The grant graph as this device sees it: who I've granted (with scope), and the
// enrollment flow that issues a grant. The relay is the source of truth for the
// *edges* (`GET /v0/grants` returns the grantee list), but it returns only public
// keys — the label, the grant kind (household vs node), and the scope I chose are
// local display state, kept here so the devices-and-grants screen can render them.
//
// Pure + IndexedDB only (prefs + the proposers directory), no wasm and no relay
// client, so the graph assembly and enrollment persistence unit-test under node
// vitest; the crypto/relay steps of enrollment ride injected boundaries.
import { get, put } from './db'
import { putProposer } from './proposals'
import { sealKeyHandoff, keyHandoffItemId, type SealingIdentity, type WrappableKeyring } from './keyring'

export type GrantKind = 'household' | 'node'

/** Default blob-id prefix scopes per grant kind (design §4). A household member
 * reads the record and its captured documents; a processing node additionally
 * reads imported source documents and curation, so OCR/RAG summaries respect the
 * owner's status/name overrides. */
export const HOUSEHOLD_PREFIXES = ['ev-', 'att-']
export const NODE_PREFIXES = ['ev-', 'att-', 'doc-', 'cur-']

export function defaultPrefixes(kind: GrantKind): string[] {
  return kind === 'node' ? [...NODE_PREFIXES] : [...HOUSEHOLD_PREFIXES]
}

/** Local record of a grant this device issued — the relay returns only the ed
 * list, so the label, kind, scope, and the grantee's X25519 key (needed to
 * re-key on rotation) live here. Keyed by grantee Ed25519 hex. */
export interface GrantMeta {
  ed: string
  x25519: string
  label: string
  kind: GrantKind
  prefixes: string[]
  /** Expiry in Unix seconds, if the owner set one (design Q4: none by default). */
  expiresAt?: number
  issuedAt: string
}

const GRANT_META_KEY = 'grantMeta'

export async function getGrantMeta(): Promise<Record<string, GrantMeta>> {
  return (await get<Record<string, GrantMeta>>('prefs', GRANT_META_KEY)) ?? {}
}

export async function putGrantMeta(meta: GrantMeta): Promise<void> {
  const all = await getGrantMeta()
  all[meta.ed] = meta
  await put('prefs', all, GRANT_META_KEY)
}

export async function removeGrantMeta(ed: string): Promise<void> {
  const all = await getGrantMeta()
  delete all[ed]
  await put('prefs', all, GRANT_META_KEY)
}

/** One edge in the outgoing grant graph: an identity I've granted, resolved
 * against local metadata. */
export interface OutgoingGrant {
  ed: string
  label: string
  kind: GrantKind
  /** The scope prefixes I set, or `[]` for a legacy (unscoped) grant. */
  prefixes: string[]
  expiresAt?: number
  /** True when there is no local metadata for this edge — a grant issued before
   * scopes (or from another device): it works, but its scope and the grantee's
   * X25519 key are unknown here, so it cannot be auto-re-keyed on rotation. */
  legacy: boolean
}

/**
 * Assemble the outgoing grant graph from the relay's grantee list and this
 * device's local metadata. A grantee with no metadata is a legacy edge (unscoped,
 * un-re-keyable here). Pure — the caller supplies both inputs. Sorted by label
 * then ed so the screen renders stably.
 */
export function buildOutgoing(
  grantees: string[],
  meta: Record<string, GrantMeta>,
): OutgoingGrant[] {
  return grantees
    .map((ed): OutgoingGrant => {
      const m = meta[ed]
      if (!m) return { ed, label: '', kind: 'household', prefixes: [], legacy: true }
      return {
        ed,
        label: m.label,
        kind: m.kind,
        prefixes: m.prefixes,
        expiresAt: m.expiresAt,
        legacy: false,
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label) || (a.ed < b.ed ? -1 : a.ed > b.ed ? 1 : 0))
}

/** The still-trusted grantees to re-key on a rotation: every outgoing grant with
 * a known X25519 key (i.e. non-legacy), minus an optionally-revoked one. A legacy
 * grant cannot be re-keyed (its key is unknown), so it is excluded — the UI warns
 * that such grants must be re-issued to survive a rotation. */
export function granteesToReKey(
  meta: Record<string, GrantMeta>,
  excludeEd: string | null,
): { ed: string; x25519: string; label: string }[] {
  return Object.values(meta)
    .filter((m) => m.ed !== excludeEd)
    .map((m) => ({ ed: m.ed, x25519: m.x25519, label: m.label }))
}

// --- enrollment ---

/** The relay surface enrollment drives — a narrow slice of `RelayClient`. */
export interface EnrollRelay {
  putGrant(granteeHex: string, scope?: { prefixes?: string[]; expires_at?: number }): Promise<void>
  putMailbox(recipientHex: string, id: string, blob: Uint8Array): Promise<void>
}

export interface EnrollParams {
  relay: EnrollRelay
  identity: SealingIdentity
  /** The owner's current vault keyring — wrapped to the grantee in the handoff. */
  keyring: WrappableKeyring
  /** The owner's own display name, shown to the grantee as the inviter (the
   * `key_handoff` body's `label`). */
  ownerLabel: string
  grantee: {
    ed: string
    x25519: string
    /** Local label the owner assigns this grantee. */
    label: string
    kind: GrantKind
    /** Optional expiry in Unix seconds (per-grant opt-in). */
    expiresAt?: number
  }
  now?: number
}

/**
 * Enroll a grantee (design §4/§7): PUT a scoped grant, deposit the vault keyring
 * re-wrapped to them in a signed `key_handoff`, record the grant locally, and —
 * for a node — record its identity in C2's proposer directory so proposal replies
 * can be sealed back to it (the incoming `proposal` envelope carries only the
 * proposer's Ed25519; the reply needs its X25519, which only this out-of-band
 * enrollment knows). Node enrollment is the same primitive with node-default
 * scopes and the directory write.
 */
export async function enrollGrantee(params: EnrollParams): Promise<void> {
  const { relay, identity, keyring, grantee } = params
  const now = params.now ?? Date.now()
  const prefixes = defaultPrefixes(grantee.kind)

  await relay.putGrant(grantee.ed, { prefixes, expires_at: grantee.expiresAt })

  const envelope = sealKeyHandoff(identity, keyring, grantee.x25519, params.ownerLabel, now)
  await relay.putMailbox(grantee.ed, keyHandoffItemId(identity.ed25519_public_hex), envelope)

  await putGrantMeta({
    ed: grantee.ed,
    x25519: grantee.x25519,
    label: grantee.label,
    kind: grantee.kind,
    prefixes,
    expiresAt: grantee.expiresAt,
    issuedAt: new Date(now).toISOString(),
  })

  if (grantee.kind === 'node') {
    await putProposer({ ed: grantee.ed, x25519: grantee.x25519, label: grantee.label })
  }
}
