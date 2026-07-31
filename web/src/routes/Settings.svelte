<script lang="ts">
  import { onMount } from 'svelte'
  import { navigate } from '../lib/router.svelte'
  import { getAll } from '../lib/db'
  import { pendingRecords, type ProposalRecord } from '../lib/proposals'

  // Proposals arrive as notifications; this is the deliberate always-there entry
  // point (the dashboard no longer carries a Proposals card). The badge is the
  // pending draft count.
  let pendingProposals = $state(0)
  onMount(async () => {
    const proposals = await getAll<ProposalRecord>('proposals')
    pendingProposals = pendingRecords(proposals).reduce(
      (n, r) => n + r.drafts.filter((d) => d.status === 'pending').length,
      0,
    )
  })
</script>

<h1>Settings</h1>

<!-- Inline SVG, not glyph characters, for the same reason as the header (see
     AppHeader.svelte): iconography ships with the app. These rows used to be
     literal codepoints, which put them at the mercy of the font stack — the AI
     row's ✳ (U+2733) is emoji-capable and uncovered by our Atkinson subsets, so
     it fell through to the platform colour-emoji font and rendered green among
     seven monochrome siblings. ⚿ and ⇄ were a tofu risk on the same grounds. -->
<div class="hub" data-testid="settings-hub">
  <button
    class="hub-row"
    onclick={() => navigate('#/settings/appearance')}
    data-testid="settings-row-appearance"
  >
    <svg class="hub-glyph" viewBox="0 0 24 24" width="22" height="22" fill="none"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
    </svg>
    <span class="hub-text">
      <span class="hub-title">Appearance</span>
      <span class="hub-sub muted">Theme, accent, add-button hand</span>
    </span>
    <svg class="hub-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true">
      <path d="M9 5l7 7-7 7" />
    </svg>
  </button>

  <button
    class="hub-row"
    onclick={() => navigate('#/settings/security')}
    data-testid="settings-row-security"
  >
    <svg class="hub-glyph" viewBox="0 0 24 24" width="22" height="22" fill="none"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true">
      <path d="M12 3l7 3v5.5c0 4.5-3 7.8-7 9.5-4-1.7-7-5-7-9.5V6z" />
      <circle cx="12" cy="11" r="1.6" />
      <path d="M12 12.6V15" />
    </svg>
    <span class="hub-text">
      <span class="hub-title">Security &amp; recovery</span>
      <span class="hub-sub muted">Passphrase, passkeys, seed phrase, identity</span>
    </span>
    <svg class="hub-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true">
      <path d="M9 5l7 7-7 7" />
    </svg>
  </button>

  <button class="hub-row" onclick={() => navigate('#/settings/sync')} data-testid="settings-row-sync">
    <svg class="hub-glyph" viewBox="0 0 24 24" width="22" height="22" fill="none"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true">
      <path d="M4 9h16" />
      <path d="M17 6l3 3-3 3" />
      <path d="M20 15H4" />
      <path d="M7 12l-3 3 3 3" />
    </svg>
    <span class="hub-text">
      <span class="hub-title">Sync &amp; devices</span>
      <span class="hub-sub muted">Relay, status, link another device</span>
    </span>
    <svg class="hub-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true">
      <path d="M9 5l7 7-7 7" />
    </svg>
  </button>


  <button
    class="hub-row"
    onclick={() => navigate('#/settings/notifications')}
    data-testid="settings-row-notifications"
  >
    <!-- Same bell as the header's notification button: same subject, same shape. -->
    <svg class="hub-glyph" viewBox="0 0 24 24" width="22" height="22" fill="none"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true">
      <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </svg>
    <span class="hub-text">
      <span class="hub-title">Notifications</span>
      <span class="hub-sub muted">Lock-screen alerts when something's waiting</span>
    </span>
    <svg class="hub-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true">
      <path d="M9 5l7 7-7 7" />
    </svg>
  </button>

  <button class="hub-row" onclick={() => navigate('#/settings/ai')} data-testid="settings-row-ai">
    <svg class="hub-glyph" viewBox="0 0 24 24" width="22" height="22" fill="none"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true">
      <path d="M12 3c0 4 2 6 6 6-4 0-6 2-6 6 0-4-2-6-6-6 4 0 6-2 6-6z" />
      <path d="M18.5 15.5c0 1.7.8 2.5 2.5 2.5-1.7 0-2.5.8-2.5 2.5 0-1.7-.8-2.5-2.5-2.5 1.7 0 2.5-.8 2.5-2.5z" />
    </svg>
    <span class="hub-text">
      <span class="hub-title">AI</span>
      <span class="hub-sub muted">Inference endpoint for reading and answering</span>
    </span>
    <svg class="hub-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true">
      <path d="M9 5l7 7-7 7" />
    </svg>
  </button>

  <button class="hub-row" onclick={() => navigate('#/proposals')} data-testid="settings-row-proposals">
    <svg class="hub-glyph" viewBox="0 0 24 24" width="22" height="22" fill="none"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 14l2 2 4-4" />
    </svg>
    <span class="hub-text">
      <span class="hub-title"
        >Proposals{#if pendingProposals > 0}
          <span class="badge" data-testid="settings-proposals-badge">{pendingProposals}</span>{/if}</span
      >
      <span class="hub-sub muted">Review suggested entries before they're signed in</span>
    </span>
    <svg class="hub-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true">
      <path d="M9 5l7 7-7 7" />
    </svg>
  </button>

  <button class="hub-row" onclick={() => navigate('#/settings/data')} data-testid="settings-row-data">
    <svg class="hub-glyph" viewBox="0 0 24 24" width="22" height="22" fill="none"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true">
      <path d="M12 3l9 4-9 4-9-4z" />
      <path d="M3 12l9 4 9-4" />
      <path d="M3 17l9 4 9-4" />
    </svg>
    <span class="hub-text">
      <span class="hub-title">Your data</span>
      <span class="hub-sub muted">Storage, code dictionary, import, backup</span>
    </span>
    <svg class="hub-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true">
      <path d="M9 5l7 7-7 7" />
    </svg>
  </button>

  <button class="hub-row" onclick={() => navigate('#/settings/about')} data-testid="settings-row-about">
    <svg class="hub-glyph" viewBox="0 0 24 24" width="22" height="22" fill="none"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </svg>
    <span class="hub-text">
      <span class="hub-title">About</span>
      <span class="hub-sub muted">Version, trust contract, install instructions</span>
    </span>
    <svg class="hub-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true">
      <path d="M9 5l7 7-7 7" />
    </svg>
  </button>
</div>

<style>
  .hub {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-4);
  }

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
  }

  .badge {
    font-family: var(--font-data);
    font-size: var(--text-xs);
    background: var(--flare);
    color: var(--bg);
    border-radius: var(--radius-full);
    padding: 0 var(--space-2);
    margin-left: var(--space-1);
  }
</style>
