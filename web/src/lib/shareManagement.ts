// Cross-device doctor-share management and history clearing. A share's local
// record (token, key until purge, scope summary) lives only in the IndexedDB
// of the device that created it, but the relay already knows every live
// share's token and timing for its owner — pure routing metadata it already
// held (see `spec/README.md`'s "Cross-device listing" and `GET /v0/shares`
// in relay.ts). This module merges that listing against the local
// `doctor_shares` records instead of syncing share records through the vault:
// operational metadata (who made a link, when it lapses) is not a medical
// fact and does not belong in an append-only clinical log, and a new synced
// namespace would be a contract change for no payoff over asking the relay
// what it already knows.
//
// The pure merge/gate logic below is separated from the db/relay
// orchestration exactly like doctorShare.ts and fileShare.ts, so it
// unit-tests without a browser or a network — the boundaries a caller injects
// (`relayShares: T[] | null`, `liveRelayTokens: Set | null`) are what let a
// test exercise "relay reachable, empty", "relay reachable, has entries", and
// "relay unreachable" without a fetch mock.
import type { RelayShareInfo } from './relay'
import { type DoctorShareRecord, shareStatus, listDoctorShares } from './doctorShare'
import { del } from './db'

// --- cross-device listing: shares the relay knows about with no local record ---

/** A live share the relay reports that this device has no local record for —
 * created (and only fully knowable) on another device. The honest reduced
 * view: a token fingerprint and timing only, never a scope summary this
 * device was never told. */
export interface RemoteOnlyShare {
  token: string
  fingerprint: string
  createdAt: string
  expiresAt: string
}

/** Same short-grouped-characters idiom as an identity fingerprint
 * (`exchange.ts`'s `fingerprint`, over an Ed25519 hex key): 4 groups of 4,
 * here over the token's own characters rather than a fresh hash, so it is
 * stable and derivable from the token alone. */
export function shareTokenFingerprint(token: string): string {
  return (token.match(/.{4}/g) ?? []).slice(0, 4).join(' ')
}

export interface ShareListingMerge {
  /** Live relay shares absent from the local record set, newest first. */
  remoteOnly: RemoteOnlyShare[]
  /** False when the relay listing could not be fetched this refresh —
   * distinct from an empty `remoteOnly`, so the caller can honestly hide the
   * cross-device section ("we don't know") instead of implying there is
   * nothing else out there. */
  crossDeviceAvailable: boolean
}

/**
 * Merge the relay's live-share listing (`GET /v0/shares`) against this
 * device's local `doctor_shares` tokens. `relayShares` is `null` when the
 * relay was unreachable this refresh. A token this device already holds a
 * local record for is skipped here — its full record renders through the
 * existing local-share list, unchanged; this only surfaces what's genuinely
 * new.
 */
export function mergeRemoteOnlyShares(
  localTokens: ReadonlySet<string>,
  relayShares: RelayShareInfo[] | null,
): ShareListingMerge {
  if (relayShares === null) return { remoteOnly: [], crossDeviceAvailable: false }
  const remoteOnly = relayShares
    .filter((s) => !localTokens.has(s.token))
    .map((s) => ({
      token: s.token,
      fingerprint: shareTokenFingerprint(s.token),
      createdAt: new Date(s.created_at * 1000).toISOString(),
      expiresAt: new Date(s.expires_at * 1000).toISOString(),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return { remoteOnly, crossDeviceAvailable: true }
}

// --- history clearing: an inactive local record clears only once the relay
// confirms it no longer serves the token ---

export type ClearGate = { canClear: true } | { canClear: false; reason: string }

const RELAY_UNREACHABLE_REASON =
  'Reconnect to a relay to confirm this link is really gone before clearing its history.'
const STILL_LIVE_REASON = 'This link is still live at the relay — revoke it before clearing its history.'

/**
 * Whether a doctor-share token's local history entry may be deleted right
 * now. `liveRelayTokens` is the token set from the same `GET /v0/shares`
 * fetch {@link mergeRemoteOnlyShares} uses — `null` when the relay was
 * unreachable. A token still present there blocks clearing rather than
 * deleting blind (it should not normally happen for a locally-inactive
 * record, but a stale local status is never trusted over what the relay
 * reports right now). Revocation and expiry both answer instantly here: a
 * revoked token drops from the relay's live listing the moment the tombstone
 * lands, and an expired one was never counted as live by the listing's own
 * `expires_at` filter — so this is a cheap membership check, never a wait.
 */
export function clearGateFor(token: string, liveRelayTokens: ReadonlySet<string> | null): ClearGate {
  if (liveRelayTokens === null) return { canClear: false, reason: RELAY_UNREACHABLE_REASON }
  if (liveRelayTokens.has(token)) return { canClear: false, reason: STILL_LIVE_REASON }
  return { canClear: true }
}

/** The inactive (expired or revoked) local doctor-share records eligible for
 * "Clear inactive history" right now — everything {@link clearGateFor}
 * admits. Pure over an already-loaded record list so the bulk action's
 * confirmation count can be computed without a fresh db read. */
export function clearableInactiveShares(
  records: DoctorShareRecord[],
  liveRelayTokens: ReadonlySet<string> | null,
  now: number = Date.now(),
): DoctorShareRecord[] {
  return records.filter(
    (r) => shareStatus(r, now) !== 'active' && clearGateFor(r.token, liveRelayTokens).canClear,
  )
}

/** Delete one doctor-share history entry. Callers check {@link clearGateFor}
 * first — the UI never offers the control otherwise. */
export async function clearDoctorShareRecord(token: string): Promise<void> {
  await del('doctor_shares', token)
}

/** Clear every eligible inactive doctor-share record ("Clear inactive
 * history"). Returns how many were cleared. */
export async function clearInactiveDoctorShares(
  liveRelayTokens: ReadonlySet<string> | null,
): Promise<number> {
  const records = await listDoctorShares()
  const clearable = clearableInactiveShares(records, liveRelayTokens)
  for (const r of clearable) await clearDoctorShareRecord(r.token)
  return clearable.length
}

/** Delete one file-share history entry. Unlike a doctor share there is no
 * relay to gate against — a file share is unrevocable and never expires by
 * construction (see fileShare.ts) — so the caller's confirmation copy must
 * say what this really removes: the only local trace that a copy of the
 * record was ever handed over, not the copy itself. */
export async function clearFileShareRecord(id: string): Promise<void> {
  await del('file_shares', id)
}
