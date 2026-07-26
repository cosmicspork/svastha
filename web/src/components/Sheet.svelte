<script lang="ts">
  import type { Snippet } from 'svelte'
  import { onMount, onDestroy } from 'svelte'

  let { onclose, children }: { onclose: () => void; children: Snippet } = $props()

  let panel = $state<HTMLDivElement>()
  // Restores focus on close — the sheet is triggered from a button that should
  // get it back, not whatever the browser defaults to (usually <body>).
  const previouslyFocused = document.activeElement as HTMLElement | null

  onMount(() => {
    panel?.focus()
  })

  onDestroy(() => {
    previouslyFocused?.focus?.()
  })

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose()
  }

  // --- drag-to-dismiss from the grab handle ---
  // Pointer-based (touch + mouse). A sheet is anchored to the bottom, so only a
  // downward drag is meaningful: past a threshold — or a committed downward
  // flick — it dismisses; a short drag springs back. The handle is the only
  // drag surface, so this never fights the sheet's own inner scroll.
  const DISMISS_PX = 96
  const FLICK_VELOCITY = 0.5 // px per ms
  let dragY = $state(0)
  let dragging = $state(false)
  let startY = 0
  let startT = 0
  let lastY = 0
  let lastT = 0

  function onGrabDown(e: PointerEvent) {
    dragging = true
    startY = lastY = e.clientY
    startT = lastT = e.timeStamp
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  function onGrabMove(e: PointerEvent) {
    if (!dragging) return
    lastY = e.clientY
    lastT = e.timeStamp
    dragY = Math.max(0, e.clientY - startY)
  }

  function onGrabUp() {
    if (!dragging) return
    dragging = false
    const dt = Math.max(1, lastT - startT)
    const velocity = (lastY - startY) / dt
    if (dragY > DISMISS_PX || velocity > FLICK_VELOCITY) {
      onclose()
    } else {
      dragY = 0
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<!-- Purely a dismiss target; Escape (svelte:window above) is the keyboard equivalent. -->
<div class="scrim" aria-hidden="true" onclick={onclose}></div>

<div
  class="sheet"
  class:dragging
  role="dialog"
  aria-modal="true"
  tabindex="-1"
  bind:this={panel}
  style="transform: translateY({dragY}px)"
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- Drag-to-dismiss handle: a downward drag past the threshold (or a flick)
       closes the sheet; a short drag springs back. Escape and the scrim are the
       non-drag equivalents, so this needs no key handler of its own. -->
  <div
    class="grab"
    aria-hidden="true"
    onpointerdown={onGrabDown}
    onpointermove={onGrabMove}
    onpointerup={onGrabUp}
    onpointercancel={onGrabUp}
  ></div>
  {@render children()}
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: var(--scrim);
    z-index: 100;
  }

  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 101;
    max-width: 40rem;
    margin: 0 auto;
    /* Anchored to the bottom and grows upward; cap it at the viewport and scroll
       inside so a tall sheet's top controls stay reachable instead of running off
       the top edge (the sheet has no internal scroll otherwise). */
    max-height: calc(100dvh - var(--space-5));
    overflow-y: auto;
    overscroll-behavior: contain;
    background: var(--surface);
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    box-shadow: var(--shadow-2);
    padding: var(--space-3) var(--space-5) calc(var(--space-5) + env(safe-area-inset-bottom));
  }

  /* Spring-back is a transform transition; while the finger is down the sheet
     tracks the pointer with no transition. Reduced-motion strips it globally
     (base.css), so spring-back is instant there. */
  .sheet:not(.dragging) {
    transition: transform var(--duration-base) cubic-bezier(0.2, 0.9, 0.3, 1);
  }

  /* The handle is a generous, touch-action-none hit area around a small visual
     bar, so a drag never scrolls the page instead of moving the sheet. */
  .grab {
    width: 100%;
    height: 22px;
    margin: 0 auto var(--space-3);
    display: grid;
    place-items: center;
    touch-action: none;
    cursor: grab;
  }

  .grab::before {
    content: '';
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: var(--border);
  }

  .sheet.dragging .grab {
    cursor: grabbing;
  }

  .sheet.dragging .grab::before {
    background: var(--muted);
  }
</style>
