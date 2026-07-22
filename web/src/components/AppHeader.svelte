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
  <span class="wordmark">Svastha</span>

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
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
          stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
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
    font-family: var(--font-display);
    font-size: var(--text-xl);
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
