<script lang="ts">
  import { onMount } from 'svelte'
  import { renderSVG } from 'uqr'
  import { get } from '../../lib/db'
  import { navigate } from '../../lib/router.svelte'
  import { session } from '../../lib/session.svelte'
  import { RelayClient, normalizeRelayUrl, type RelayShareInfo } from '../../lib/relay'
  import {
    listDoctorShares,
    revokeDoctorShare,
    shareLinkFor,
    shareStatus,
    type DoctorShareRecord,
  } from '../../lib/doctorShare'
  import { listFileShares, type FileShareRecord } from '../../lib/fileShare'
  import {
    clearDoctorShareRecord,
    clearFileShareRecord,
    clearGateFor,
    clearInactiveDoctorShares,
    clearableInactiveShares,
    mergeRemoteOnlyShares,
  } from '../../lib/shareManagement'
  import DoctorShareSheet from '../../components/DoctorShareSheet.svelte'

  // Verbatim on every screen that mints or manages a link: revocation and
  // expiry are honest about what they can and can't take back.
  const HONEST_COPY =
    "Revoking stops anyone from opening a link again. It can't take back what " +
    "they've already seen, saved, or printed. For anything highly sensitive, share " +
    'it in person.'

  const appOrigin = window.location.origin

  let relayUrl = $state('')
  let relay = $state<RelayClient | null>(null)
  let relayOrigin = $state('')
  let shares = $state<DoctorShareRecord[]>([])
  let fileShares = $state<FileShareRecord[]>([])
  let loaded = $state(false)
  let showCreate = $state(false)
  let qrFor = $state<string | null>(null)
  let copied = $state<string | null>(null)
  let error = $state('')

  // The relay's own live-share listing (`GET /v0/shares`) — null means it
  // hasn't been fetched yet or the relay was unreachable this refresh; the
  // merge and clearing logic below both treat null as "we don't know",
  // never as "there is nothing else". `crossDeviceError` distinguishes a
  // configured-but-unreachable relay from simply having none configured, for
  // an honest degrade note (see `refreshRelayShares`).
  let relayShares = $state<RelayShareInfo[] | null>(null)
  let crossDeviceError = $state(false)
  let clearBusy = $state(false)
  let confirmingFileDelete = $state<FileShareRecord | null>(null)

  const liveTokens = $derived(relayShares ? new Set(relayShares.map((s) => s.token)) : null)
  const merge = $derived(mergeRemoteOnlyShares(new Set(shares.map((s) => s.token)), relayShares))
  const clearable = $derived(clearableInactiveShares(shares, liveTokens))
  const inactiveCount = $derived(shares.filter((s) => statusLabel(s) !== 'active').length)

  async function refreshRelayShares() {
    if (!relay) {
      relayShares = null
      crossDeviceError = false
      return
    }
    try {
      relayShares = await relay.listShares()
      crossDeviceError = false
    } catch {
      relayShares = null
      crossDeviceError = true
    }
  }

  async function refreshShares() {
    ;[shares, fileShares] = await Promise.all([listDoctorShares(), listFileShares()])
    await refreshRelayShares()
  }

  function statusLabel(record: DoctorShareRecord) {
    return shareStatus(record)
  }

  function linkFor(record: DoctorShareRecord): string | null {
    return shareLinkFor(record, appOrigin, relayOrigin)
  }

  async function copy(token: string, link: string) {
    await navigator.clipboard.writeText(link)
    copied = token
    setTimeout(() => (copied = null), 2000)
  }

  async function revoke(token: string) {
    if (!relay) return
    try {
      await revokeDoctorShare(relay, token)
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not revoke the share.'
    }
    if (qrFor === token) qrFor = null
    await refreshShares()
  }

  /** Revoke a share known only from the relay (made on another device): the
   * same tombstone DELETE, but there is no local record to mark revoked — the
   * listing refresh above simply drops it once the relay stops serving it. */
  async function revokeRemote(token: string) {
    if (!relay) return
    try {
      await relay.deleteShare(token)
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not revoke the share.'
    }
    await refreshShares()
  }

  async function clearOne(token: string) {
    if (!clearGateFor(token, liveTokens).canClear) return
    await clearDoctorShareRecord(token)
    await refreshShares()
  }

  async function clearAllInactive() {
    clearBusy = true
    try {
      await clearInactiveDoctorShares(liveTokens)
      await refreshShares()
    } finally {
      clearBusy = false
    }
  }

  async function deleteFileShare() {
    if (!confirmingFileDelete) return
    await clearFileShareRecord(confirmingFileDelete.id)
    confirmingFileDelete = null
    await refreshShares()
  }

  onMount(async () => {
    relayUrl = (await get<string>('prefs', 'relayUrl')) ?? ''
    relayOrigin = relayUrl ? normalizeRelayUrl(relayUrl) : ''
    if (relayUrl && session.identity) {
      relay = new RelayClient(relayUrl, session.identity)
    }
    await refreshShares()
    loaded = true
  })
</script>

<h1>Doctor links</h1>
<p class="lede muted">
  One-time summaries you hand a clinician — a relay link that expires, or a file you hand over
  yourself.
</p>

<button class="primary" onclick={() => (showCreate = true)} data-testid="new-doctor-link">
  New share
</button>

{#if !relayUrl}
  <p class="muted needs-relay" data-testid="share-needs-relay">
    Without a relay you can still save a share file to hand over yourself. <button
      class="link"
      onclick={() => navigate('#/settings/sync')}
      data-testid="go-connect-relay">Connect a relay in Settings</button
    > to also send expiring links.
  </p>
{/if}

{#if error}
  <p class="error" data-testid="doctor-error">{error}</p>
{/if}

{#if loaded && shares.length === 0 && fileShares.length === 0}
  <div class="empty" data-testid="doctor-empty">
    <p>No doctor shares yet.</p>
    <p class="muted">
      Create one to package part of your record under a fresh key — a link that opens only what you
      picked and expires on its own, or a file you hand over yourself. No account needed on their
      end.
    </p>
  </div>
{/if}

{#if shares.length > 0}
  <ul class="share-list">
    {#each shares as record (record.token)}
      {@const status = statusLabel(record)}
      {@const link = linkFor(record)}
      <li>
        <div class="share-head">
          <span class="scope">{record.scopeDescription}</span>
          <span class="status status-{status}" data-testid="share-status-{record.token}">
            {status}
          </span>
        </div>
        <p class="hint muted">
          Created {record.createdAt.slice(0, 10)} · expires {record.expiresAt.slice(0, 10)}
        </p>
        {#if status === 'active'}
          <div class="row">
            {#if link}
              <button
                class="ghost"
                onclick={() => copy(record.token, link)}
                data-testid="reshow-copy-{record.token}"
              >
                {copied === record.token ? 'Copied' : 'Copy link'}
              </button>
              <button
                class="ghost"
                onclick={() => (qrFor = qrFor === record.token ? null : record.token)}
                data-testid="reshow-qr-{record.token}"
              >
                {qrFor === record.token ? 'Hide QR' : 'Show QR'}
              </button>
            {/if}
            <button
              class="danger-outline"
              onclick={() => revoke(record.token)}
              data-testid="revoke-{record.token}"
            >
              Revoke
            </button>
          </div>
          {#if qrFor === record.token && link}
            <!-- App-generated link, never user input — safe to inject. -->
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            <div class="qr small" data-testid="reshow-qr-svg-{record.token}">
              {@html renderSVG(link, { border: 2 })}
            </div>
          {/if}
        {:else}
          {@const gate = clearGateFor(record.token, liveTokens)}
          <div class="row">
            <button
              class="ghost"
              onclick={() => clearOne(record.token)}
              disabled={!gate.canClear}
              title={gate.canClear ? undefined : gate.reason}
              data-testid="clear-{record.token}"
            >
              Clear
            </button>
          </div>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

{#if inactiveCount > 0}
  <div class="clear-history">
    <button
      class="ghost"
      onclick={clearAllInactive}
      disabled={clearBusy || clearable.length === 0}
      data-testid="clear-inactive-history"
    >
      Clear inactive history{clearable.length > 0 ? ` (${clearable.length})` : ''}
    </button>
    {#if relayShares === null}
      <p class="muted hint" data-testid="clear-history-unavailable">
        Reconnect to a relay to confirm these links are really gone before clearing them.
      </p>
    {/if}
  </div>
{/if}

{#if crossDeviceError}
  <p class="muted hint" data-testid="cross-device-unavailable">
    Could not check for shares made on other devices — showing local links only.
  </p>
{/if}

{#if merge.crossDeviceAvailable && merge.remoteOnly.length > 0}
  <h2 class="list-head">Shared from another device</h2>
  <ul class="share-list" data-testid="remote-share-list">
    {#each merge.remoteOnly as s (s.token)}
      <li>
        <div class="share-head">
          <span class="scope data" data-testid="remote-fingerprint-{s.token}">{s.fingerprint}</span>
          <span class="status status-active">active</span>
        </div>
        <p class="hint muted">
          Created {s.createdAt.slice(0, 10)} · expires {s.expiresAt.slice(0, 10)} · made on another device,
          scope not shown here
        </p>
        <div class="row">
          <button
            class="danger-outline"
            onclick={() => revokeRemote(s.token)}
            data-testid="revoke-remote-{s.token}"
          >
            Revoke
          </button>
        </div>
      </li>
    {/each}
  </ul>
{/if}

{#if fileShares.length > 0}
  <h2 class="list-head">Files handed over</h2>
  <ul class="share-list" data-testid="file-share-list">
    {#each fileShares as f (f.id)}
      <li>
        <div class="share-head">
          <span class="scope">{f.scopeDescription}</span>
          <span class="status status-file" data-testid="file-share-status-{f.id}">unrevocable</span>
        </div>
        <p class="hint muted">
          Saved {f.createdAt.slice(0, 10)} · {f.mode === 'passphrase'
            ? 'passphrase-protected'
            : 'key embedded'} · never expires, cannot be revoked
        </p>
        <div class="row">
          <button
            class="ghost"
            onclick={() => (confirmingFileDelete = f)}
            data-testid="delete-file-share-{f.id}"
          >
            Delete entry
          </button>
        </div>
      </li>
    {/each}
  </ul>
{/if}

<p class="honest" data-testid="doctor-honest">{HONEST_COPY}</p>

{#if showCreate}
  <DoctorShareSheet
    {relay}
    {relayUrl}
    oncreated={refreshShares}
    onclose={() => {
      showCreate = false
      refreshShares()
    }}
  />
{/if}

{#if confirmingFileDelete}
  <div class="scrim" data-testid="file-delete-confirm">
    <div class="dialog">
      <h2>Delete this entry?</h2>
      <p class="muted">
        This only deletes the local record that a copy of your record was handed over — it doesn't
        un-hand-over the file. The recipient's copy still exists and this app has no way to revoke it.
      </p>
      <div class="dialog-actions">
        <button onclick={() => (confirmingFileDelete = null)} data-testid="file-delete-cancel">
          Cancel
        </button>
        <button class="danger-outline" onclick={deleteFileShare} data-testid="file-delete-confirm-yes">
          Delete
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .lede {
    margin: 0 0 var(--space-4);
    font-size: var(--text-sm);
  }

  .empty {
    margin-top: var(--space-5);
  }

  .empty p {
    margin: 0 0 var(--space-2);
  }

  .link {
    display: inline;
    padding: 0;
    border: none;
    background: none;
    color: var(--action);
    text-decoration: underline;
    font: inherit;
  }

  .share-list {
    list-style: none;
    padding: 0;
    margin: var(--space-4) 0 0;
  }

  .share-list li {
    padding: var(--space-3) 0;
    border-top: 1px solid var(--border);
  }

  .share-head {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }

  .scope {
    flex: 1;
    font-size: var(--text-sm);
  }

  .status {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .status-active {
    color: var(--action);
  }

  .status-expired,
  .status-revoked,
  .status-file {
    color: var(--muted);
  }

  .list-head {
    font-size: var(--text-sm);
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin: var(--space-5) 0 0;
  }

  .needs-relay {
    margin-top: var(--space-3);
  }

  .hint {
    font-size: var(--text-xs);
    margin: var(--space-1) 0 0;
  }

  .row {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin-top: var(--space-3);
  }

  .qr.small :global(svg) {
    display: block;
    width: 100%;
    max-width: 11rem;
    height: auto;
    margin: var(--space-3) auto;
    background: #fff;
    padding: var(--space-2);
    border-radius: var(--radius-sm);
  }

  .honest {
    font-size: var(--text-xs);
    line-height: 1.5;
    color: var(--muted);
    margin: var(--space-5) 0 0;
  }

  .clear-history {
    margin-top: var(--space-4);
  }

  .scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-4);
    background: rgba(0, 0, 0, 0.5);
  }

  .dialog {
    width: 100%;
    max-width: 26rem;
    padding: var(--space-4);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-2);
  }

  .dialog h2 {
    margin: 0 0 var(--space-2);
  }

  .dialog-actions {
    display: flex;
    gap: var(--space-2);
    justify-content: flex-end;
    margin-top: var(--space-4);
  }
</style>
