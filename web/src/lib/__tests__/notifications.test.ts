import { beforeEach, describe, expect, it } from 'vitest'
import { get as storeValue } from 'svelte/store'
import { deleteDb } from '../db'
import {
  notifications,
  unreadCount,
  addNotification,
  markRead,
  loadNotifications,
  clearNotifications,
  dedupeAndCap,
  markReadIn,
  countUnread,
  sortNewestFirst,
  deriveInviteNotifications,
  deriveExpiringShareNotifications,
  NOTIFICATION_CAP,
  type Notification,
} from '../notifications'
import type { PendingInvite } from '../shared'
import type { DoctorShareRecord } from '../doctorShare'

function note(id: string, createdAt: string, readAt?: string): Notification {
  return { id, kind: 'app-update', title: id, createdAt, ...(readAt ? { readAt } : {}) }
}

describe('sortNewestFirst', () => {
  it('orders by createdAt descending', () => {
    const list = [
      note('a', '2026-07-01T00:00:00Z'),
      note('c', '2026-07-03T00:00:00Z'),
      note('b', '2026-07-02T00:00:00Z'),
    ]
    expect(sortNewestFirst(list).map((n) => n.id)).toEqual(['c', 'b', 'a'])
  })
})

describe('dedupeAndCap', () => {
  it('replaces an existing id rather than duplicating', () => {
    const list = [note('a', '2026-07-01T00:00:00Z', '2026-07-01T01:00:00Z')]
    const next = dedupeAndCap(list, note('a', '2026-07-05T00:00:00Z'))
    expect(next).toHaveLength(1)
    expect(next[0].createdAt).toBe('2026-07-05T00:00:00Z')
    expect(next[0].readAt).toBeUndefined()
  })

  it('keeps only the newest NOTIFICATION_CAP items', () => {
    let list: Notification[] = []
    for (let i = 0; i < NOTIFICATION_CAP + 10; i++) {
      // i ascending → later ids are newer.
      list = dedupeAndCap(list, note(`n${i}`, `2026-07-01T00:${String(i).padStart(2, '0')}:00Z`))
    }
    expect(list).toHaveLength(NOTIFICATION_CAP)
    // The oldest (n0..n9) fell off; the newest survives at the head.
    expect(list[0].id).toBe(`n${NOTIFICATION_CAP + 9}`)
    expect(list.some((n) => n.id === 'n0')).toBe(false)
  })
})

describe('markReadIn / countUnread', () => {
  it('stamps readAt only on the matching, still-unread item', () => {
    const list = [note('a', '2026-07-01T00:00:00Z'), note('b', '2026-07-02T00:00:00Z')]
    const next = markReadIn(list, 'a', '2026-07-03T00:00:00Z')
    expect(next.find((n) => n.id === 'a')!.readAt).toBe('2026-07-03T00:00:00Z')
    expect(next.find((n) => n.id === 'b')!.readAt).toBeUndefined()
  })

  it('does not overwrite an already-read timestamp', () => {
    const list = [note('a', '2026-07-01T00:00:00Z', '2026-07-01T05:00:00Z')]
    expect(markReadIn(list, 'a', '2026-07-09T00:00:00Z')[0].readAt).toBe('2026-07-01T05:00:00Z')
  })

  it('counts unread items', () => {
    expect(
      countUnread([
        note('a', '2026-07-01T00:00:00Z'),
        note('b', '2026-07-02T00:00:00Z', '2026-07-02T01:00:00Z'),
        note('c', '2026-07-03T00:00:00Z'),
      ]),
    ).toBe(2)
  })
})

describe('deriveInviteNotifications', () => {
  const invite: PendingInvite = {
    mailboxId: 'vaultkey-1',
    fromEd: 'a'.repeat(64),
    fromX: 'b'.repeat(64),
    label: 'Sam',
    wrappedKeyHex: 'cc',
  }

  it('makes one stable-id notification per invite with the fingerprint as body', () => {
    const [n] = deriveInviteNotifications([invite])
    expect(n.id).toBe(`share-invite:${invite.fromEd}`)
    expect(n.title).toContain('Sam')
    expect(n.body).toBe('aaaa aaaa aaaa aaaa')
    expect(n.data?.href).toBe('#/share')
  })

  it('re-deriving yields the same id (idempotent by construction)', () => {
    expect(deriveInviteNotifications([invite])[0].id).toBe(deriveInviteNotifications([invite])[0].id)
  })
})

describe('deriveExpiringShareNotifications', () => {
  const now = new Date('2026-07-22T12:00:00Z').getTime()
  const day = 24 * 60 * 60 * 1000
  function share(token: string, expiresInMs: number, revoked = false): DoctorShareRecord {
    return {
      token,
      key: 'k',
      scopeDescription: `scope-${token}`,
      createdAt: new Date(now - 10 * day).toISOString(),
      expiresAt: new Date(now + expiresInMs).toISOString(),
      ...(revoked ? { revokedAt: new Date(now).toISOString() } : {}),
    }
  }

  it('flags an active share inside the 3-day window with a rounded day count', () => {
    const out = deriveExpiringShareNotifications([share('t1', 2.4 * day)], now)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('doctor-share-expiring:t1:3')
    expect(out[0].title).toBe('"scope-t1" expires in 3 days')
    expect(out[0].data?.href).toBe('#/share')
  })

  it('singularizes one day', () => {
    expect(deriveExpiringShareNotifications([share('t1', 0.5 * day)], now)[0].title).toContain(
      'expires in 1 day',
    )
  })

  it('ignores shares outside the window, already expired, or revoked', () => {
    const shares = [
      share('far', 10 * day), // beyond threshold
      share('past', -day), // already expired
      share('revoked', day, true), // revoked wins over expiry
    ]
    expect(deriveExpiringShareNotifications(shares, now)).toEqual([])
  })
})

describe('store ops (IndexedDB-backed)', () => {
  beforeEach(async () => {
    await deleteDb()
    notifications.set([])
  })

  it('addNotification persists, de-dupes by id, and drives unreadCount', async () => {
    await addNotification(note('a', '2026-07-01T00:00:00Z'))
    await addNotification(note('a', '2026-07-09T00:00:00Z')) // same id: ignored
    await addNotification(note('b', '2026-07-02T00:00:00Z'))

    expect(storeValue(notifications).map((n) => n.id)).toEqual(['b', 'a'])
    // The re-add was a no-op: the first createdAt stands.
    expect(storeValue(notifications).find((n) => n.id === 'a')!.createdAt).toBe('2026-07-01T00:00:00Z')
    expect(storeValue(unreadCount)).toBe(2)

    // Survives a reload from IndexedDB.
    notifications.set([])
    await loadNotifications()
    expect(storeValue(notifications).map((n) => n.id)).toEqual(['b', 'a'])
  })

  it('caps the persisted store and prunes overflow from IndexedDB', async () => {
    for (let i = 0; i < NOTIFICATION_CAP + 5; i++) {
      await addNotification(note(`n${i}`, `2026-07-01T00:${String(i).padStart(2, '0')}:00Z`))
    }
    expect(storeValue(notifications)).toHaveLength(NOTIFICATION_CAP)
    notifications.set([])
    await loadNotifications()
    expect(storeValue(notifications)).toHaveLength(NOTIFICATION_CAP)
    expect(storeValue(notifications).some((n) => n.id === 'n0')).toBe(false)
  })

  it('markRead stamps and persists, lowering the unread count', async () => {
    await addNotification(note('a', '2026-07-01T00:00:00Z'))
    expect(storeValue(unreadCount)).toBe(1)
    await markRead('a')
    expect(storeValue(unreadCount)).toBe(0)

    notifications.set([])
    await loadNotifications()
    expect(storeValue(notifications)[0].readAt).toBeDefined()
  })

  it('clearNotifications empties store and IndexedDB', async () => {
    await addNotification(note('a', '2026-07-01T00:00:00Z'))
    await clearNotifications()
    expect(storeValue(notifications)).toEqual([])
    await loadNotifications()
    expect(storeValue(notifications)).toEqual([])
  })
})
