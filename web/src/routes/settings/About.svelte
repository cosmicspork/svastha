<script lang="ts">
  import { contract_version } from '../../lib/svastha'
  import { dismissInstallNudge } from '../../lib/install'
  import InstallSheet from '../../components/InstallSheet.svelte'

  const version = contract_version()

  // --- install instructions ---
  let showInstallSheet = $state(false)

  async function closeInstallSheet(): Promise<void> {
    // Idempotent with the first-run nudge's pref write — reopening from here
    // isn't itself a nudge, but writing the same "dismissed" flag again is
    // harmless and keeps this component as dumb as the sheet it wraps.
    await dismissInstallNudge()
    showInstallSheet = false
  }
</script>

<h1>About</h1>

<section class="stack">
  <p class="muted" data-testid="about-app-version">Svastha v{__APP_VERSION__}</p>
  <p class="muted" data-testid="about-version">Trust contract v{version}</p>
  <button
    class="ghost"
    onclick={() => (showInstallSheet = true)}
    data-testid="install-instructions"
  >
    Install instructions
  </button>
</section>

{#if showInstallSheet}
  <InstallSheet onclose={closeInstallSheet} />
{/if}

<style>
  section {
    margin-top: var(--space-6);
  }
</style>
