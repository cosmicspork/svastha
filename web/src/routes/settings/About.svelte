<script lang="ts">
  import { contract_version, contract_major } from '../../lib/svastha'
  import { dismissInstallNudge } from '../../lib/install'
  import InstallSheet from '../../components/InstallSheet.svelte'

  // Two distinct numbers, deliberately both shown (see crates/core: the wire
  // version negotiated with the relay vs. the cryptographic era). The app
  // version is a build-time define from the release-please manifest.
  const wire = contract_version()
  const major = contract_major()

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
  <div class="card">
    <div class="hero">
      <span class="mark">Svastha</span>
      <div>
        <p class="tagline">Your health record, in your hands.</p>
        <p class="creed muted">self-custodial · end-to-end encrypted · local-first</p>
      </div>
    </div>
    <dl>
      <div class="row">
        <dt>App version</dt>
        <dd class="data" data-testid="about-app-version">{__APP_VERSION__}</dd>
      </div>
      <div class="row">
        <dt>Wire contract <small>negotiated with your relay</small></dt>
        <dd class="data" data-testid="about-version">v{wire}</dd>
      </div>
      <div class="row">
        <dt>Crypto era <small>key-rotation generation</small></dt>
        <dd class="data" data-testid="about-crypto-major">v{major}</dd>
      </div>
    </dl>
  </div>

  <button class="ghost" onclick={() => (showInstallSheet = true)} data-testid="install-instructions">
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

  .card {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    overflow: hidden;
  }

  .hero {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4);
    border-bottom: 1px solid var(--border);
  }

  .mark {
    font-family: var(--font-display);
    font-size: var(--text-xl);
    line-height: 1;
  }

  .tagline {
    margin: 0 0 var(--space-1);
  }

  .creed {
    margin: 0;
    font-size: var(--text-xs);
  }

  dl {
    margin: 0;
  }

  .row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border);
  }

  .row:last-child {
    border-bottom: none;
  }

  dt {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  dt small {
    display: block;
    font-size: var(--text-xs);
    opacity: 0.85;
  }

  dd {
    margin: 0;
  }
</style>
