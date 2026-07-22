<script lang="ts">
  import { onMount } from 'svelte'
  import { initSvastha } from './lib/svastha'
  import { hasVault } from './lib/keyvault'
  import { locked, session } from './lib/session.svelte'
  import { get } from './lib/db'
  import { RelayClient } from './lib/relay'
  import { connectRelay } from './lib/vault'
  import { syncTeardown } from './lib/sync'
  import { ensureCurationSigned } from './lib/curation'
  import { route } from './lib/router.svelte'
  import { loadTheme, applyTheme } from './lib/theme'
  import Onboard from './routes/Onboard.svelte'
  import Unlock from './routes/Unlock.svelte'
  import Home from './routes/Home.svelte'
  import Log from './routes/Log.svelte'
  import Settings from './routes/Settings.svelte'
  import SettingsAppearance from './routes/settings/Appearance.svelte'
  import SettingsSecurity from './routes/settings/Security.svelte'
  import SettingsSync from './routes/settings/Sync.svelte'
  import SettingsData from './routes/settings/Data.svelte'
  import SettingsAbout from './routes/settings/About.svelte'
  import Share from './routes/Share.svelte'
  import SharePeople from './routes/share/People.svelte'
  import ShareDoctor from './routes/share/Doctor.svelte'
  import Person from './routes/Person.svelte'
  import Import from './routes/Import.svelte'
  import Correlate from './routes/Correlate.svelte'
  import Bloom from './components/Bloom.svelte'
  import ShareView from './components/ShareView.svelte'
  import AppHeader from './components/AppHeader.svelte'
  import { loadNotifications } from './lib/notifications'
  import { startInviteNotifications, scanForNotifications } from './lib/notification-sources'

  let ready = $state(false)
  let vaultExists = $state(false)

  // A share link (`#/s/…`) is a cold, account-less entry point: it must NOT
  // touch the vault at all — no `hasVault` read, no onboarding, no unlock, no
  // sync — so the normal boot is gated behind this. ShareView keeps everything
  // in memory for the tab's life. Read once at mount: a share is a fresh tab.
  const isShare = route.path === '/s/:frag'

  onMount(async () => {
    applyTheme(await loadTheme())
    await initSvastha()
    if (!isShare) vaultExists = await hasVault()
    ready = true
  })

  // Re-check after onboarding completes (initVault runs, then navigates here).
  $effect(() => {
    if (ready && route.path === '/' && !vaultExists) {
      hasVault().then((v) => (vaultExists = v))
    }
  })

  // Bring sync up whenever a session unlocks with a relay already configured
  // (Onboard's restore-with-relay flow starts it itself), and tear it down on
  // lock/logout — reads `locked()` reactively, so this reruns on exactly
  // those transitions.
  $effect(() => {
    if (isShare) return
    if (!ready || locked()) {
      syncTeardown()
      return
    }
    const identity = session.identity
    // One-time on first unlock after this version: re-sign any pre-signing
    // curation records in place (see curation.ts's `migrateCurationToSigned`).
    // Idempotent and relay-independent, so it runs here regardless of whether a
    // relay is configured; a configured relay picks up the re-pushed blobs on
    // the next drain.
    void ensureCurationSigned()
    get<string>('prefs', 'relayUrl').then((url) => {
      if (url && identity) {
        connectRelay(new RelayClient(url, identity))
      }
    })
  })

  // Local notification inbox: hydrate it and light up its client-local sources
  // once a session is unlocked, tearing the invite subscription down on lock.
  // Same gating as the sync effect above (never during the cold share path).
  let inviteUnsub: (() => void) | null = null
  $effect(() => {
    if (isShare || !ready || locked() || !vaultExists) {
      inviteUnsub?.()
      inviteUnsub = null
      return
    }
    loadNotifications()
    inviteUnsub ??= startInviteNotifications()
    scanForNotifications()
  })
</script>

<main>
  {#if isShare}
    {#if ready}
      <ShareView />
    {:else}
      <p class="muted" data-testid="loading">Loading…</p>
    {/if}
  {:else if !ready}
    <p class="muted" data-testid="loading">Loading…</p>
  {:else if !vaultExists}
    <Onboard onCreated={() => (vaultExists = true)} />
  {:else if locked()}
    <Unlock />
  {:else}
    {#if route.path !== '/log/:kind'}
      <AppHeader showBack={route.path !== '/'} />
    {/if}

    {#if route.path === '/log/:kind'}
      <Log kind={route.params.kind} />
    {:else if route.path === '/settings'}
      <Settings />
    {:else if route.path === '/settings/appearance'}
      <SettingsAppearance />
    {:else if route.path === '/settings/security'}
      <SettingsSecurity />
    {:else if route.path === '/settings/sync'}
      <SettingsSync />
    {:else if route.path === '/settings/data'}
      <SettingsData />
    {:else if route.path === '/settings/about'}
      <SettingsAbout />
    {:else if route.path === '/share'}
      <Share />
    {:else if route.path === '/share/people'}
      <SharePeople />
    {:else if route.path === '/share/doctor'}
      <ShareDoctor />
    {:else if route.path === '/person/:ed'}
      <Person ed={route.params.ed} />
    {:else if route.path === '/import'}
      <Import />
    {:else if route.path === '/correlate'}
      <Correlate />
    {:else}
      <Home />
    {/if}
  {/if}

  {#if ready && vaultExists && !locked() && route.path !== '/person/:ed' && route.path !== '/log/:kind'}
    <Bloom />
  {/if}
</main>

<style>
  main {
    max-width: 40rem;
    margin: 0 auto;
    /* Offset the top for the status bar/notch (viewport-fit=cover extends
       content under it in standalone PWA mode; the inset is 0 in Safari, so
       this is harmless there). Horizontal insets guard the landscape notch;
       the bottom already reserved its inset. */
    padding-top: calc(var(--space-5) + env(safe-area-inset-top));
    padding-bottom: calc(var(--space-7) + env(safe-area-inset-bottom));
    padding-left: max(var(--space-4), env(safe-area-inset-left));
    padding-right: max(var(--space-4), env(safe-area-inset-right));
    /* dvh tracks the visible viewport; 100vh on iOS Safari is the taller
       URL-bar-hidden height, which rendered the page taller than the screen and
       let it stick scrolled to the bottom (cutting off the top). vh is the
       fallback for browsers without dvh. */
    min-height: 100vh;
    min-height: 100dvh;
  }

</style>
