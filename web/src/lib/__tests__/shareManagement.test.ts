import { describe, expect, it } from 'vitest'

// shareManagement.ts pulls in doctorShare.ts, which imports the wasm
// `WasmDataKey` at module load; stub it exactly as doctorShare.test.ts does —
// nothing under test here calls the seal path.
import { vi } from 'vitest'
vi.mock('../svastha', () => ({ WasmDataKey: class {} }))

import {
  clearGateFor,
  clearableInactiveShares,
  mergeRemoteOnlyShares,
  shareTokenFingerprint,
} from '../shareManagement'
import type { RelayShareInfo } from '../relay'
import type { DoctorShareRecord } from '../doctorShare'

const NOW = Date.parse('2026-07-24T12:00:00Z')
const secs = (isoOffsetDays: number) => Math.floor(NOW / 1000) + isoOffsetDays * 24 * 60 * 60
const iso = (isoOffsetDays: number) => new Date(NOW + isoOffsetDays * 24 * 60 * 60 * 1000).toISOString()

function relayShare(token: string, createdDaysAgo: number, expiresInDays: number): RelayShareInfo {
  return { token, created_at: secs(-createdDaysAgo), expires_at: secs(expiresInDays) }
}

function localRecord(
  token: string,
  opts: { expiresInDays: number; revoked?: boolean },
): DoctorShareRecord {
  return {
    token,
    key: opts.revoked ? '' : 'k',
    scopeDescription: 'everything',
    createdAt: iso(-1),
    expiresAt: iso(opts.expiresInDays),
    revokedAt: opts.revoked ? iso(-0.1) : undefined,
  }
}

describe('shareTokenFingerprint', () => {
  it('groups the first 16 chars into 4 groups of 4, mirroring the identity fingerprint idiom', () => {
    expect(shareTokenFingerprint('abcdefghijklmnopqrstuvwxyz')).toBe('abcd efgh ijkl mnop')
  })

  it('is stable and derivable from the token alone (no randomness)', () => {
    const t = 'share-abcdefghijklmnopqrstuvwxyz012345'
    expect(shareTokenFingerprint(t)).toBe(shareTokenFingerprint(t))
  })
})

describe('mergeRemoteOnlyShares', () => {
  it('is unreachable-honest: null relay listing hides the cross-device section entirely', () => {
    const result = mergeRemoteOnlyShares(new Set(['a']), null)
    expect(result.crossDeviceAvailable).toBe(false)
    expect(result.remoteOnly).toEqual([])
  })

  it('an empty (but reachable) listing is a real, distinguishable "nothing else out there"', () => {
    const result = mergeRemoteOnlyShares(new Set(), [])
    expect(result.crossDeviceAvailable).toBe(true)
    expect(result.remoteOnly).toEqual([])
  })

  it('excludes tokens this device already has a local record for', () => {
    const relayShares = [relayShare('local-tok', 1, 6), relayShare('other-tok', 2, 5)]
    const result = mergeRemoteOnlyShares(new Set(['local-tok']), relayShares)
    expect(result.remoteOnly.map((s) => s.token)).toEqual(['other-tok'])
  })

  it('carries fingerprint and ISO timing for a remote-only share', () => {
    const relayShares = [relayShare('other-tok-abcdefgh', 1, 6)]
    const result = mergeRemoteOnlyShares(new Set(), relayShares)
    expect(result.remoteOnly).toHaveLength(1)
    const s = result.remoteOnly[0]
    expect(s.token).toBe('other-tok-abcdefgh')
    expect(s.fingerprint).toBe(shareTokenFingerprint('other-tok-abcdefgh'))
    expect(new Date(s.createdAt).getTime()).toBe(secs(-1) * 1000)
    expect(new Date(s.expiresAt).getTime()).toBe(secs(6) * 1000)
  })

  it('never surfaces a token this device has no local record for from another owner as anything but remote', () => {
    // Two remote-only shares sort newest-created first.
    const relayShares = [relayShare('older', 5, 5), relayShare('newer', 1, 5)]
    const result = mergeRemoteOnlyShares(new Set(), relayShares)
    expect(result.remoteOnly.map((s) => s.token)).toEqual(['newer', 'older'])
  })
})

describe('clearGateFor', () => {
  it('blocks with an honest reason when the relay is unreachable (null)', () => {
    const gate = clearGateFor('tok', null)
    expect(gate.canClear).toBe(false)
    if (!gate.canClear) expect(gate.reason).toMatch(/reconnect/i)
  })

  it('blocks (never deletes blind) when the relay still lists the token as live', () => {
    const gate = clearGateFor('tok', new Set(['tok']))
    expect(gate.canClear).toBe(false)
    if (!gate.canClear) expect(gate.reason).toMatch(/still live/i)
  })

  it('allows clearing once the token is absent from the relay live listing', () => {
    expect(clearGateFor('tok', new Set(['other']))).toEqual({ canClear: true })
    expect(clearGateFor('tok', new Set())).toEqual({ canClear: true })
  })
})

describe('clearableInactiveShares', () => {
  it('never offers an active share for clearing, gate or no gate', () => {
    const active = localRecord('active-tok', { expiresInDays: 5 })
    const result = clearableInactiveShares([active], new Set(), NOW)
    expect(result).toEqual([])
  })

  it('excludes an inactive share still gated by relay-unreachable', () => {
    const revoked = localRecord('revoked-tok', { expiresInDays: 5, revoked: true })
    expect(clearableInactiveShares([revoked], null, NOW)).toEqual([])
  })

  it('excludes an inactive share the relay still (surprisingly) lists as live', () => {
    const expired = localRecord('expired-tok', { expiresInDays: -1 })
    expect(clearableInactiveShares([expired], new Set(['expired-tok']), NOW)).toEqual([])
  })

  it('includes an expired or revoked share once the relay confirms the token is gone', () => {
    const expired = localRecord('expired-tok', { expiresInDays: -1 })
    const revoked = localRecord('revoked-tok', { expiresInDays: 5, revoked: true })
    const active = localRecord('active-tok', { expiresInDays: 5 })
    const result = clearableInactiveShares([expired, revoked, active], new Set(), NOW)
    expect(result.map((r) => r.token).sort()).toEqual(['expired-tok', 'revoked-tok'])
  })
})
