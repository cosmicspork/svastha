<script lang="ts">
  import { navigate } from '../lib/router.svelte'
</script>

<h1>Settings</h1>

<div class="hub" data-testid="settings-hub">
  <button
    class="hub-row"
    onclick={() => navigate('#/settings/appearance')}
    data-testid="settings-row-appearance"
  >
    <span class="hub-glyph" aria-hidden="true">◐</span>
    <span class="hub-text">
      <span class="hub-title">Appearance</span>
      <span class="hub-sub muted">Theme, accent, add-button hand</span>
    </span>
    <span class="hub-chevron" aria-hidden="true">›</span>
  </button>

  <button
    class="hub-row"
    onclick={() => navigate('#/settings/security')}
    data-testid="settings-row-security"
  >
    <span class="hub-glyph" aria-hidden="true">⚿</span>
    <span class="hub-text">
      <span class="hub-title">Security &amp; recovery</span>
      <span class="hub-sub muted">Passphrase, passkeys, seed phrase, identity</span>
    </span>
    <span class="hub-chevron" aria-hidden="true">›</span>
  </button>

  <button class="hub-row" onclick={() => navigate('#/settings/sync')} data-testid="settings-row-sync">
    <span class="hub-glyph" aria-hidden="true">⇄</span>
    <span class="hub-text">
      <span class="hub-title">Sync &amp; devices</span>
      <span class="hub-sub muted">Relay, status, link another device</span>
    </span>
    <span class="hub-chevron" aria-hidden="true">›</span>
  </button>

  <button
    class="hub-row"
    onclick={() => navigate('#/settings/devices')}
    data-testid="settings-row-devices"
  >
    <span class="hub-glyph" aria-hidden="true">⚷</span>
    <span class="hub-text">
      <span class="hub-title">Devices &amp; grants</span>
      <span class="hub-sub muted">Who you share with, your node, revoke &amp; rotate</span>
    </span>
    <span class="hub-chevron" aria-hidden="true">›</span>
  </button>

  <button class="hub-row" onclick={() => navigate('#/settings/data')} data-testid="settings-row-data">
    <span class="hub-glyph" aria-hidden="true">▤</span>
    <span class="hub-text">
      <span class="hub-title">Your data</span>
      <span class="hub-sub muted">Storage, code dictionary, import, backup</span>
    </span>
    <span class="hub-chevron" aria-hidden="true">›</span>
  </button>

  <button class="hub-row" onclick={() => navigate('#/settings/about')} data-testid="settings-row-about">
    <span class="hub-glyph" aria-hidden="true">◦</span>
    <span class="hub-text">
      <span class="hub-title">About</span>
      <span class="hub-sub muted">Version, trust contract, install instructions</span>
    </span>
    <span class="hub-chevron" aria-hidden="true">›</span>
  </button>
</div>

<style>
  .hub {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-4);
  }

  /* The hub row idiom: a surfaced, bordered card with a leading glyph, a
     title + muted sub-line, and a trailing chevron — full-width and tappable. */
  .hub-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    text-align: left;
  }

  .hub-glyph {
    flex: none;
    width: 1.5em;
    font-size: var(--text-lg);
    text-align: center;
  }

  .hub-text {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }

  .hub-title {
    font-size: var(--text-base);
  }

  .hub-sub {
    font-size: var(--text-xs);
  }

  .hub-chevron {
    flex: none;
    color: var(--muted);
    font-size: var(--text-lg);
  }
</style>
