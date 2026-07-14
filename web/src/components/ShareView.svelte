<script lang="ts">
  // The cold-load share view: what a doctor sees when they open a share link in
  // a browser that has never run Svastha (or the owner's own browser, without
  // disturbing their vault). Everything here lives in memory for the tab's
  // life — App.svelte routes to this before any onboarding/unlock/IndexedDB
  // path runs. See shareRecipient.ts for the parse/fetch/open/verify pipeline.
  import { onMount } from 'svelte'
  import { initSvastha } from '../lib/svastha'
  import { loadShare, type ShareLoadResult } from '../lib/shareRecipient'
  import { fingerprint } from '../lib/exchange'
  import ClinicianSummary from './ClinicianSummary.svelte'

  // null = still loading; the pipeline is wasm-gated, so nothing is shown until
  // initSvastha resolves.
  let result = $state<ShareLoadResult | null>(null)

  async function load() {
    result = null
    await initSvastha()
    result = await loadShare(window.location.hash)
  }

  onMount(load)

  const ERROR_COPY: Record<string, string> = {
    expired:
      'This shared record has expired or was withdrawn by the sender. Ask them for a new link.',
    invalid: 'This link is invalid or incomplete.',
    damaged: 'This link is damaged — ask the sender to resend it.',
    network: "Can't reach the record right now. Check your connection and try again.",
  }

  function sharedOn(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
  }
</script>

<div class="share">
  {#if result === null}
    <p class="muted" data-testid="share-loading">Opening shared record…</p>
  {:else if result.status === 'error'}
    <div class="state" data-testid="share-error" data-error={result.error}>
      <h1>Shared record</h1>
      <p class="error-msg">{ERROR_COPY[result.error]}</p>
      {#if result.error === 'network'}
        <button onclick={load} data-testid="share-retry">Try again</button>
      {/if}
    </div>
  {:else}
    {@const bundle = result.bundle}
    <header class="share-head">
      <h1>Shared medical record</h1>
      <p class="muted meta" data-testid="share-meta">Shared on {sharedOn(bundle.createdAt)}</p>
      <p class="verify" data-testid="share-verify">
        {bundle.verified}
        {bundle.verified === 1 ? 'record' : 'records'} verified · key
        <span class="fp">{fingerprint(bundle.signerHex)}</span>
      </p>
      {#if bundle.dropped > 0}
        <p class="warn" data-testid="share-warning">
          {bundle.dropped}
          {bundle.dropped === 1 ? 'entry' : 'entries'} could not be verified and {bundle.dropped === 1
            ? 'was'
            : 'were'} left out.
        </p>
      {/if}
    </header>

    <ClinicianSummary events={bundle.events} readonly />
  {/if}
</div>

<style>
  .share {
    max-width: 40rem;
    margin: 0 auto;
  }

  .share-head {
    margin-bottom: var(--space-5);
  }

  .share-head h1 {
    margin-bottom: var(--space-2);
  }

  .meta {
    font-size: var(--text-sm);
    margin-bottom: var(--space-2);
  }

  .verify {
    font-size: var(--text-sm);
    color: var(--muted);
    margin: 0;
  }

  /* The fingerprint is the out-of-band anchor a reader confirms with the
     sender, so it wants to be legible and copyable, not chrome. */
  .fp {
    font-family: var(--font-data);
    color: var(--text);
    white-space: nowrap;
  }

  .warn {
    margin: var(--space-3) 0 0;
    font-size: var(--text-sm);
    color: var(--danger);
  }

  .state {
    padding: var(--space-6) 0;
  }

  .error-msg {
    font-size: var(--text-base);
    margin-bottom: var(--space-4);
  }
</style>
