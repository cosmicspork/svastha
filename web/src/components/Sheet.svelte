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
</script>

<svelte:window onkeydown={onKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<!-- Purely a dismiss target; Escape (svelte:window above) is the keyboard equivalent. -->
<div class="scrim" aria-hidden="true" onclick={onclose}></div>

<div class="sheet" role="dialog" aria-modal="true" tabindex="-1" bind:this={panel}>
  <div class="grab"></div>
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

  .grab {
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: var(--border);
    margin: 0 auto var(--space-4);
  }
</style>
