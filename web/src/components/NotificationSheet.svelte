<script lang="ts">
  import Sheet from './Sheet.svelte'
  import { navigate } from '../lib/router.svelte'
  import { notifications, markRead, dismiss, type Notification } from '../lib/notifications'
  import { relativeTime } from '../lib/time'

  let { onclose, onOpenUpdate }: { onclose: () => void; onOpenUpdate: (version: string) => void } =
    $props()

  async function open(n: Notification): Promise<void> {
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

  // --- swipe: right = mark read, left = delete ---
  // One finger at a time, so a single active-row cursor is enough. The axis is
  // locked on first movement so a vertical drag scrolls the list (touch-action
  // below is pan-y) while a horizontal drag reveals the action. A tap (no axis
  // lock) still opens the row via the button's own click.
  const THRESHOLD = 72
  let activeId = $state<string | null>(null)
  let dx = $state(0)
  let axis = $state<'x' | 'y' | null>(null)
  let startX = 0
  let startY = 0
  let swiped = false // a real horizontal swipe happened; suppress the click

  function onDown(e: PointerEvent, n: Notification): void {
    activeId = n.id
    dx = 0
    axis = null
    swiped = false
    startX = e.clientX
    startY = e.clientY
  }

  function onMove(e: PointerEvent): void {
    if (activeId === null) return
    const ddx = e.clientX - startX
    const ddy = e.clientY - startY
    if (axis === null) {
      if (Math.abs(ddx) > 10 && Math.abs(ddx) > Math.abs(ddy)) {
        axis = 'x'
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      } else if (Math.abs(ddy) > 10) {
        axis = 'y' // vertical — let the list scroll; stop tracking this gesture
        activeId = null
        return
      }
    }
    if (axis === 'x') {
      swiped = true
      dx = ddx
    }
  }

  function onUp(n: Notification): void {
    if (activeId === null) return
    if (axis === 'x') {
      if (dx > THRESHOLD) void markRead(n.id)
      else if (dx < -THRESHOLD) void dismiss(n.id)
    }
    activeId = null
    dx = 0
    axis = null
  }

  function onClick(n: Notification): void {
    // A horizontal swipe ends on the same button and would otherwise fire a
    // click — swallow that one; keyboard/plain taps still open.
    if (swiped) {
      swiped = false
      return
    }
    void open(n)
  }

  // The active row's live offset; every other row rests at 0.
  const offset = (n: Notification): number => (activeId === n.id ? dx : 0)
</script>

<Sheet {onclose}>
  <h2>Notifications</h2>
  {#if $notifications.length === 0}
    <p class="muted" data-testid="notifications-empty">You're caught up.</p>
  {:else}
    <ul class="list" data-testid="notifications-list">
      {#each $notifications as n (n.id)}
        <li>
          <!-- Action backgrounds, revealed as the face slides off them. -->
          <span class="action read" aria-hidden="true" style:opacity={offset(n) > 8 ? 1 : 0}>
            Mark read
          </span>
          <span class="action del" aria-hidden="true" style:opacity={offset(n) < -8 ? 1 : 0}>
            Delete
          </span>
          <button
            class="item"
            class:unread={!n.readAt}
            class:sliding={activeId === n.id && axis === 'x'}
            style:transform={`translateX(${offset(n)}px)`}
            onpointerdown={(e) => onDown(e, n)}
            onpointermove={onMove}
            onpointerup={() => onUp(n)}
            onpointercancel={() => onUp(n)}
            onclick={() => onClick(n)}
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

  /* Each row is a positioning context so the action backgrounds sit under the
     sliding face. */
  .list li {
    position: relative;
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .action {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    padding: 0 var(--space-4);
    font-size: var(--text-xs);
    font-family: var(--font-data);
    letter-spacing: 0.04em;
    pointer-events: none;
  }

  .action.read {
    justify-content: flex-start;
    background: var(--action-muted);
    color: var(--action);
  }

  .action.del {
    justify-content: flex-end;
    background: var(--danger-muted);
    color: var(--danger);
  }

  .item {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    width: 100%;
    text-align: left;
    padding: var(--space-3) var(--space-1);
    border: none;
    border-radius: var(--radius-sm);
    background: var(--surface);
    min-height: 44px;
    /* Vertical pans scroll the list; horizontal pans are ours to interpret. */
    touch-action: pan-y;
  }

  /* Snap-back / rest transition; suppressed while the finger is actively
     dragging so the face tracks the pointer 1:1. Reduced-motion strips it. */
  .item:not(.sliding) {
    transition: transform var(--duration-base) cubic-bezier(0.2, 0.9, 0.3, 1);
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
