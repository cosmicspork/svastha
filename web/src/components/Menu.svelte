<script lang="ts" module>
  export type MenuItem = {
    label: string
    onSelect: () => void
    /** Render in the danger hue (e.g. a destructive action). */
    danger?: boolean
    /** Draw a separator directly above this item. */
    separatorBefore?: boolean
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte'

  let {
    label,
    items,
    trigger,
    triggerClass = '',
    triggerTestId,
  }: {
    /** Accessible name for the trigger button. */
    label: string
    items: MenuItem[]
    /** Visible trigger content (e.g. a glyph). */
    trigger: Snippet
    triggerClass?: string
    triggerTestId?: string
  } = $props()

  let open = $state(false)
  // Horizontal nudge and vertical flip applied after measuring, so the popover
  // never spills off a narrow (phone) viewport.
  let shiftX = $state(0)
  let flipUp = $state(false)
  let triggerEl = $state<HTMLButtonElement>()
  let menuEl = $state<HTMLDivElement>()

  function menuItemEls(): HTMLButtonElement[] {
    return menuEl ? Array.from(menuEl.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')) : []
  }

  function close(refocus = true) {
    open = false
    if (refocus) triggerEl?.focus()
  }

  function activate(item: MenuItem) {
    item.onSelect()
    close()
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const els = menuItemEls()
    if (els.length === 0) return
    const i = els.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.key === 'ArrowDown' ? i + 1 : i - 1
    els[((next % els.length) + els.length) % els.length]?.focus()
  }

  // On open: move focus to the first item (menu-button pattern), clamp within
  // the viewport, and wire an outside-pointer close. The effect reads only
  // `open`, so writing shiftX/flipUp here cannot re-trigger it.
  $effect(() => {
    if (!open) return
    shiftX = 0
    flipUp = false
    menuItemEls()[0]?.focus()
    const rect = menuEl?.getBoundingClientRect()
    if (rect) {
      const m = 8
      if (rect.left < m) shiftX = m - rect.left
      else if (rect.right > window.innerWidth - m) shiftX = window.innerWidth - m - rect.right
      if (rect.bottom > window.innerHeight - m) flipUp = true
    }
    const onPointer = (ev: PointerEvent) => {
      if (!triggerEl?.parentElement?.contains(ev.target as Node)) close(false)
    }
    // The opening tap's pointerdown already fired before this runs, so the menu
    // won't immediately close itself.
    window.addEventListener('pointerdown', onPointer)
    return () => window.removeEventListener('pointerdown', onPointer)
  })
</script>

<span class="menu-anchor">
  <button
    bind:this={triggerEl}
    type="button"
    class="menu-trigger {triggerClass}"
    aria-label={label}
    aria-haspopup="menu"
    aria-expanded={open}
    data-testid={triggerTestId}
    onclick={() => (open = !open)}
  >
    {@render trigger()}
  </button>
  {#if open}
    <div
      bind:this={menuEl}
      class="menu"
      class:up={flipUp}
      role="menu"
      aria-label={label}
      style:transform={shiftX ? `translateX(${shiftX}px)` : undefined}
      onkeydown={onKeydown}
    >
      {#each items as item, i (i)}
        {#if item.separatorBefore}
          <div class="menu-sep" role="separator"></div>
        {/if}
        <button
          type="button"
          role="menuitem"
          class="menu-item"
          class:danger={item.danger}
          onclick={() => activate(item)}
        >
          {item.label}
        </button>
      {/each}
    </div>
  {/if}
</span>

<style>
  .menu-anchor {
    position: relative;
    flex: none;
    display: inline-flex;
  }

  /* Reset the global button chrome down to a bare icon affordance. */
  .menu-trigger {
    min-height: auto;
    min-width: auto;
    border: none;
    background: none;
    color: var(--muted);
    padding: 0 var(--space-1);
    font-size: var(--text-sm);
  }

  .menu {
    position: absolute;
    top: calc(100% + var(--space-1));
    right: 0;
    z-index: 20;
    min-width: 11rem;
    padding: var(--space-1);
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-2);
    /* base.css reduced-motion kill-switch drops this. */
    animation: menu-in var(--duration-fast) ease;
  }

  .menu.up {
    top: auto;
    bottom: calc(100% + var(--space-1));
  }

  /* min-height (44px touch target) and font come from the global button rule;
     everything else is reset to a full-width, borderless menu row. */
  .menu-item {
    display: flex;
    align-items: center;
    width: 100%;
    min-width: 0;
    padding: 0 var(--space-3);
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: inherit;
    text-align: left;
    white-space: nowrap;
  }

  .menu-item:hover {
    background: var(--action-muted);
  }

  .menu-item.danger {
    color: var(--danger);
  }

  .menu-item.danger:hover {
    background: var(--danger-muted);
  }

  .menu-sep {
    height: 1px;
    margin: var(--space-1) 0;
    background: var(--border);
  }

  @keyframes menu-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
</style>
