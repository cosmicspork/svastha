<script lang="ts">
  import { navigate } from '../lib/router.svelte'
  import { unreadCount } from '../lib/notifications'
  import NotificationSheet from './NotificationSheet.svelte'
  import UpdateSheet from './UpdateSheet.svelte'

  // The app shell decides visibility (see App.svelte). The only per-route choice
  // the header itself makes is Back vs. Settings on the right, driven by this.
  let { showBack = false }: { showBack?: boolean } = $props()

  let sheetOpen = $state(false)
  // Set (to the running version) when the app-update notification is tapped;
  // null otherwise. Lifted here rather than owned by NotificationSheet so it
  // can stay open after that sheet closes.
  let updateRunningVersion = $state<string | null>(null)

  // Cap the badge so a runaway count never blows out the header width.
  const badge = $derived($unreadCount > 99 ? '99+' : String($unreadCount))
</script>

<header class="app-header">
  <!-- On home (no back button) the wordmark IS the page heading — Home renders
       no h1 of its own, so the name isn't doubled up. Sub-screens keep their
       own h1 and the wordmark drops back to a span. -->
  <svelte:element this={showBack ? 'span' : 'h1'} class="wordmark">Svastha</svelte:element>

  <div class="actions">
    <button
      class="icon-btn"
      onclick={() => (sheetOpen = true)}
      aria-label={$unreadCount > 0 ? `Notifications, ${$unreadCount} unread` : 'Notifications'}
      data-testid="nav-notifications"
    >
      <!-- Inline bell; the app inlines all iconography (no icon-font network dep). -->
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
        stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" />
        <path d="M10 20a2 2 0 0 0 4 0" />
      </svg>
      {#if $unreadCount > 0}
        <span class="badge" data-testid="notification-badge">{badge}</span>
      {/if}
    </button>

    {#if showBack}
      <button
        class="icon-btn"
        onclick={() => navigate('#/')}
        aria-label="Back"
        data-testid="nav-back"
      >
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
          stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M15 5l-7 7 7 7" />
        </svg>
      </button>
    {:else}
      <button
        class="icon-btn"
        onclick={() => navigate('#/settings')}
        aria-label="Settings"
        data-testid="nav-settings"
      >
        <!-- Gear, not rays: a rayed circle reads as a sun (brightness), and this
             button is Settings. -->
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
          stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    {/if}
  </div>
</header>

{#if sheetOpen}
  <NotificationSheet
    onclose={() => (sheetOpen = false)}
    onOpenUpdate={(version) => (updateRunningVersion = version)}
  />
{/if}

{#if updateRunningVersion}
  <UpdateSheet runningVersion={updateRunningVersion} onclose={() => (updateRunningVersion = null)} />
{/if}

<style>
  .app-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
  }

  .wordmark {
    /* Identical rendering whether it's the home h1 or a sub-screen span. */
    margin: 0;
    font-family: var(--font-display);
    font-size: var(--text-xl);
    font-weight: normal;
    line-height: 1;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .icon-btn {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--muted);
  }

  .icon-btn:hover {
    border-color: transparent;
    color: var(--text);
  }

  .badge {
    position: absolute;
    top: 2px;
    right: 2px;
    min-width: 18px;
    height: 18px;
    padding: 0 4px;
    border-radius: var(--radius-full);
    background: var(--flare);
    color: var(--bg);
    font-size: var(--text-xs);
    line-height: 18px;
    text-align: center;
    font-family: var(--font-data);
  }
</style>
