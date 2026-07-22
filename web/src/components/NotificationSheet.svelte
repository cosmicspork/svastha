<script lang="ts">
  import Sheet from './Sheet.svelte'
  import { navigate } from '../lib/router.svelte'
  import { notifications, markRead, type Notification } from '../lib/notifications'
  import { relativeTime } from '../lib/time'

  let { onclose, onOpenUpdate }: { onclose: () => void; onOpenUpdate: (version: string) => void } =
    $props()

  async function tap(n: Notification): Promise<void> {
    await markRead(n.id)
    // app-update opens the release-notes sheet instead of following a href —
    // there's nowhere in the route tree for "what's new", and the sheet needs
    // the running version (carried on data.version) to know what counts as new.
    if (n.kind === 'app-update' && typeof n.data?.version === 'string') {
      onclose()
      onOpenUpdate(n.data.version)
      return
    }
    const href = n.data?.href
    onclose()
    if (href) navigate(href)
  }
</script>

<Sheet {onclose}>
  <h2>Notifications</h2>
  {#if $notifications.length === 0}
    <p class="muted" data-testid="notifications-empty">You're caught up.</p>
  {:else}
    <ul class="list" data-testid="notifications-list">
      {#each $notifications as n (n.id)}
        <li>
          <button
            class="item"
            class:unread={!n.readAt}
            onclick={() => tap(n)}
            data-testid="notification-item"
          >
            {#if !n.readAt}
              <span class="dot" aria-hidden="true"></span>
            {/if}
            <span class="body">
              <span class="title">{n.title}</span>
              {#if n.body}<span class="sub muted">{n.body}</span>{/if}
            </span>
            <span class="time muted">{relativeTime(n.createdAt)}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</Sheet>

<style>
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 60vh;
    overflow-y: auto;
  }

  .item {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    width: 100%;
    text-align: left;
    padding: var(--space-3) var(--space-1);
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    min-height: 44px;
  }

  .item:hover {
    background: var(--action-muted);
    border-color: transparent;
  }

  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    margin-top: 0.4em;
    border-radius: var(--radius-full);
    background: var(--flare);
  }

  /* Reserve the dot's gutter on read rows so titles stay aligned. */
  .item:not(.unread) .body {
    padding-left: calc(8px + var(--space-2));
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }

  .title {
    line-height: 1.3;
  }

  .sub {
    font-size: var(--text-sm);
  }

  .item.unread .title {
    font-weight: 600;
  }

  .time {
    flex: none;
    font-size: var(--text-xs);
    white-space: nowrap;
  }
</style>
