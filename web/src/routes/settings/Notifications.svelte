<script lang="ts">
  import { onMount } from 'svelte'
  import { navigate } from '../../lib/router.svelte'
  import { session } from '../../lib/session.svelte'
  import { get } from '../../lib/db'
  import { RelayClient } from '../../lib/relay'
  import {
    enablePush,
    disablePush,
    isPushEnabledPref,
    pushAvailability,
    type PushAvailability,
    type PushRelayClient,
  } from '../../lib/push'
  import { isIos } from '../../lib/install'

  // Feature-detected, never user-agent-sniffed (Safari on iOS only exposes
  // PushManager once the PWA is added to the Home Screen — that gate falls
  // naturally out of the check below rather than a UA test). `isIos()` is
  // used only to phrase the "not available" hint, never to decide
  // availability itself.
  let availability = $state<'checking' | PushAvailability>('checking')
  let relayUrl = $state<string | null>(null)
  let enabled = $state(false)
  let busy = $state(false)
  let error = $state('')
  let notice = $state('')

  function relayClient(): PushRelayClient | null {
    if (!session.identity || !relayUrl) return null
    return new RelayClient(relayUrl, session.identity)
  }

  onMount(async () => {
    relayUrl = (await get<string>('prefs', 'relayUrl')) ?? null
    enabled = await isPushEnabledPref()
    availability = await pushAvailability()
  })

  async function onEnable(): Promise<void> {
    error = ''
    notice = ''
    const relay = relayClient()
    if (!relay) return
    busy = true
    try {
      const registration = await navigator.serviceWorker.ready
      const result = await enablePush(registration.pushManager, relay, () => Notification.requestPermission())
      if (result.ok) {
        enabled = true
      } else if (result.reason === 'relay-unsupported') {
        // Honest feature-off state, not an error toast — the operator simply
        // hasn't configured Web Push on this relay.
        notice = result.message
      } else {
        error = result.message
      }
    } finally {
      busy = false
    }
  }

  async function onDisable(): Promise<void> {
    error = ''
    notice = ''
    const relay = relayClient()
    busy = true
    try {
      const registration = await navigator.serviceWorker.getRegistration()
      if (registration && relay) {
        await disablePush(registration.pushManager, relay)
      }
      enabled = false
    } finally {
      busy = false
    }
  }
</script>

<h1>Notifications</h1>

<section class="stack">
  <p class="muted">
    Turn this on to get a lock-screen alert when something new is waiting — a proposal to review, a
    device syncing. The alert never says what changed: this device can't read your record while it's
    locked, so it shows the same neutral line every time.
  </p>

  {#if availability === 'checking'}
    <p class="muted" data-testid="push-checking">Checking…</p>
  {:else if availability === 'native'}
    <p class="muted" data-testid="push-native">Notifications aren't available in the app yet.</p>
  {:else if availability === 'unsupported'}
    <p class="muted" data-testid="push-unsupported">
      Push notifications aren't available in this browser.
      {#if isIos()}
        On iPhone or iPad, add Svastha to your Home Screen first (Share &rarr; Add to Home Screen),
        then come back here.
      {/if}
    </p>
  {:else if availability === 'not-ready'}
    <p class="muted" data-testid="push-not-ready">
      Push notifications need the installed app to be fully loaded. Reload and try again.
    </p>
  {:else if !relayUrl}
    <div class="empty" data-testid="push-no-relay">
      <p>Connect a relay before turning on notifications — there's nothing to be notified about yet.</p>
      <button type="button" class="primary" onclick={() => navigate('#/settings/sync')} data-testid="push-go-sync">
        Sync &amp; devices
      </button>
    </div>
  {:else if enabled}
    <p data-testid="push-status">Notifications are on for this device.</p>
    <button onclick={onDisable} disabled={busy} data-testid="push-disable">Turn off</button>
  {:else}
    <button class="primary" onclick={onEnable} disabled={busy} data-testid="push-enable">
      Turn on notifications
    </button>
  {/if}

  {#if notice}
    <p class="muted" data-testid="push-notice">{notice}</p>
  {/if}
  {#if error}
    <p class="error" data-testid="push-error">{error}</p>
  {/if}
</section>

<style>
  section {
    margin-top: var(--space-6);
  }

  .empty {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    align-items: flex-start;
  }
</style>
