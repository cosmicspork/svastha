<script lang="ts">
  import { onMount } from 'svelte'
  import { initSvastha } from './lib/svastha'
  import { hasVault } from './lib/keyvault'
  import { locked } from './lib/session.svelte'
  import { route, navigate } from './lib/router.svelte'
  import Onboard from './routes/Onboard.svelte'
  import Unlock from './routes/Unlock.svelte'
  import Home from './routes/Home.svelte'
  import Log from './routes/Log.svelte'
  import Settings from './routes/Settings.svelte'
  import BottomBar from './components/BottomBar.svelte'

  let ready = $state(false)
  let vaultExists = $state(false)

  onMount(async () => {
    await initSvastha()
    vaultExists = await hasVault()
    ready = true
  })

  // Re-check after onboarding completes (initVault runs, then navigates here).
  $effect(() => {
    if (ready && route.path === '/' && !vaultExists) {
      hasVault().then((v) => (vaultExists = v))
    }
  })
</script>

<main>
  {#if !ready}
    <p class="muted" data-testid="loading">Loading…</p>
  {:else if !vaultExists}
    <Onboard onCreated={() => (vaultExists = true)} />
  {:else if locked()}
    <Unlock />
  {:else}
    {#if route.path === '/settings'}
      <button class="settings-nav" onclick={() => navigate('#/')} data-testid="nav-back">
        ← Back
      </button>
    {:else}
      <button class="settings-nav" onclick={() => navigate('#/settings')} data-testid="nav-settings">
        Settings
      </button>
    {/if}

    {#if route.path === '/log/:kind'}
      <Log kind={route.params.kind} />
    {:else if route.path === '/settings'}
      <Settings />
    {:else}
      <Home />
    {/if}
  {/if}

  {#if ready && vaultExists && !locked()}
    <BottomBar />
  {/if}
</main>

<style>
  main {
    max-width: 40rem;
    margin: 0 auto;
    padding: var(--space-5) var(--space-4) calc(var(--space-7) + 64px);
    min-height: 100vh;
  }

  .settings-nav {
    float: right;
    border: none;
    background: none;
    color: var(--muted);
    min-height: auto;
    min-width: auto;
    padding: var(--space-1) 0;
  }
</style>
