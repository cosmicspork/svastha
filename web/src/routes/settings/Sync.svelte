<script lang="ts">
  import { onMount } from 'svelte'
  import { session } from '../../lib/session.svelte'
  import { get, put, del } from '../../lib/db'
  import { RelayClient, checkRelayInfo, normalizeRelayUrl } from '../../lib/relay'
  import { connectRelay } from '../../lib/vault'
  import { syncTeardown, syncStatus, pullAll } from '../../lib/sync'
  import { deviceLinkUrl, codeQrSvg } from '../../lib/exchange'

  // --- relay sync ---
  let relayUrlInput = $state('')
  let relayConnected = $state(false)
  let relayError = $state('')
  let relayBusy = $state(false)

  onMount(async () => {
    const stored = await get<string>('prefs', 'relayUrl')
    if (stored) {
      relayUrlInput = stored
      relayConnected = true
    }
  })

  const lastPullText = $derived(
    $syncStatus.lastPullAt ? new Date($syncStatus.lastPullAt).toLocaleTimeString() : 'never',
  )

  async function submitConnect(e: SubmitEvent) {
    e.preventDefault()
    relayError = ''
    if (!session.identity) return

    const url = normalizeRelayUrl(relayUrlInput)
    relayBusy = true
    try {
      await checkRelayInfo(url)
      await put('prefs', url, 'relayUrl')
      relayUrlInput = url
      await connectRelay(new RelayClient(url, session.identity))
      relayConnected = true
    } catch (err) {
      relayError = err instanceof Error ? err.message : 'Could not connect to the relay.'
    } finally {
      relayBusy = false
    }
  }

  async function disconnect() {
    // Stops pushing/pulling and forgets the relay URL; the local event log
    // (and everything already pushed) is untouched.
    syncTeardown()
    await del('prefs', 'relayUrl')
    relayConnected = false
    relayUrlInput = ''
  }

  function syncNow() {
    void pullAll()
  }

  // --- link another device (device → device QR linking) ---
  // The new device's native camera opens this directly — no in-app scanner,
  // no new relay protocol. It lands the new device on Onboard's restore tab
  // with this relay prefilled (see `Onboard.svelte`'s `relay=` handling); the
  // seed phrase itself is entered by hand there, never carried by the QR.
  let showLinkDevice = $state(false)
  const linkDeviceUrl = $derived(deviceLinkUrl(window.location.origin, relayUrlInput))
  const linkDeviceQrSvg = $derived(showLinkDevice ? codeQrSvg(linkDeviceUrl) : '')
</script>

<h1>Sync &amp; devices</h1>

<section class="stack">
  <h2>Sync</h2>
  {#if !relayConnected}
    <form class="stack" onsubmit={submitConnect}>
      <label>
        Relay URL
        <input
          bind:value={relayUrlInput}
          placeholder="https://relay.example.com"
          data-testid="relay-url"
        />
      </label>
      {#if relayError}
        <p class="error" data-testid="relay-error">{relayError}</p>
      {/if}
      <button type="submit" class="primary" disabled={relayBusy} data-testid="relay-connect">
        Connect
      </button>
    </form>
  {:else}
    <dl>
      <dt>Relay</dt>
      <dd class="data" data-testid="relay-connected-url">{relayUrlInput}</dd>
      <dt>Status</dt>
      <dd data-testid="sync-online">{$syncStatus.online ? 'Online' : 'Offline'}</dd>
      <dt>Pending</dt>
      <dd data-testid="sync-pending">{$syncStatus.pendingCount}</dd>
      <dt>Last pull</dt>
      <dd data-testid="sync-last-pull">{lastPullText}</dd>
      {#if $syncStatus.lastError}
        <dt>Last error</dt>
        <dd class="error" data-testid="sync-last-error">{$syncStatus.lastError}</dd>
      {/if}
    </dl>
    <div class="swatches">
      <button onclick={syncNow} data-testid="sync-now">Sync now</button>
      <button onclick={disconnect} data-testid="relay-disconnect">Disconnect</button>
    </div>
    <button
      class="ghost"
      onclick={() => (showLinkDevice = !showLinkDevice)}
      data-testid="link-device"
    >
      Link another device
    </button>
    {#if showLinkDevice}
      <!-- App-generated URL, never user input — see exchange.ts's codeQrSvg doc comment. -->
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      <div class="qr" data-testid="link-device-qr">{@html linkDeviceQrSvg}</div>
      <p class="data" data-testid="link-device-url">{linkDeviceUrl}</p>
      <p class="muted">
        Scan with the new device's camera. You'll enter your seed phrase there — it never travels
        in this code.
      </p>
    {/if}
  {/if}
</section>

<style>
  section {
    margin-top: var(--space-6);
  }

  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--space-1) var(--space-4);
  }

  dt {
    color: var(--muted);
    font-size: var(--text-sm);
  }

  dd {
    margin: 0;
  }

  label {
    display: block;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .swatches {
    display: flex;
    gap: var(--space-3);
  }

  .qr :global(svg) {
    width: 200px;
    height: 200px;
  }
</style>
