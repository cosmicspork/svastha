<script lang="ts">
  import { onMount } from 'svelte'
  import { renderSVG } from 'uqr'
  import { get } from '../../lib/db'
  import { navigate } from '../../lib/router.svelte'
  import { session } from '../../lib/session.svelte'
  import { RelayClient, normalizeRelayUrl } from '../../lib/relay'
  import {
    listDoctorShares,
    revokeDoctorShare,
    shareLinkFor,
    shareStatus,
    type DoctorShareRecord,
  } from '../../lib/doctorShare'
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
  let loaded = $state(false)
  let showCreate = $state(false)
  let qrFor = $state<string | null>(null)
  let copied = $state<string | null>(null)
  let error = $state('')

  async function refreshShares() {
    shares = await listDoctorShares()
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
<p class="lede muted">One-time, expiring summaries you hand a clinician for a visit.</p>

{#if !relayUrl}
  <p class="muted" data-testid="share-needs-relay">
    A doctor link is uploaded to a relay under a one-off key. <button
      class="link"
      onclick={() => navigate('#/settings/sync')}
      data-testid="go-connect-relay">Connect one in Settings</button
    > to create a link.
  </p>
{:else}
  <button class="primary" onclick={() => (showCreate = true)} data-testid="new-doctor-link">
    New link
  </button>

  {#if error}
    <p class="error" data-testid="doctor-error">{error}</p>
  {/if}

  {#if loaded && shares.length === 0}
    <div class="empty" data-testid="doctor-empty">
      <p>No doctor links yet.</p>
      <p class="muted">
        Create one to package part of your record under a fresh key and hand over a link (or QR) that
        opens only what you picked — no account needed on their end, and it expires on its own.
      </p>
    </div>
  {:else if shares.length > 0}
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
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <p class="honest" data-testid="doctor-honest">{HONEST_COPY}</p>
{/if}

{#if showCreate && relay}
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
  .status-revoked {
    color: var(--muted);
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
</style>
