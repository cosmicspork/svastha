<script lang="ts">
  import { onMount } from 'svelte'
  import { get } from '../lib/db'
  import { navigate } from '../lib/router.svelte'
  import { CATEGORY_META } from '../lib/category'
  import { LOG_KINDS, type LogKind } from '../lib/log-kinds'
  import {
    applyStoredOrder,
    BLOOM_ORDER_PREF,
    orderByFrequency,
    selectPetals,
  } from '../lib/bloom-order'
  import { categoryLogCounts } from '../lib/events'
  import Sheet from './Sheet.svelte'

  let hand = $state<'left' | 'right'>('right')
  // Default order until frequency counts load, per orderByFrequency's own
  // tiebreak — no flash of a differently-ordered fan on first paint.
  let ordered = $state<LogKind[]>(LOG_KINDS)
  let open = $state(false)
  let showMore = $state(false)
  let fab: HTMLButtonElement | undefined = $state()

  onMount(async () => {
    const storedHand = await get<'left' | 'right'>('prefs', 'fab-hand')
    if (storedHand) hand = storedHand
    // A saved manual order (Settings → Appearance) wins outright; otherwise
    // fall back to frequency.
    const manual = await get<string[]>('prefs', BLOOM_ORDER_PREF)
    if (manual) {
      ordered = applyStoredOrder(LOG_KINDS, manual, (k) => k.kind)
    } else {
      const counts = await categoryLogCounts()
      ordered = orderByFrequency(LOG_KINDS, (k) => counts[k.category] ?? 0)
    }
  })

  const dir = $derived(hand === 'left' ? -1 : 1)
  // Top six by frequency as petals, folding the rest behind a trailing More
  // petal once the fan would otherwise overflow — see bloom-order.ts.
  const plan = $derived(selectPetals(ordered))
  // Arc positions actually on screen: the action petals plus, when present,
  // the More petal in the last (innermost) slot.
  const arcCount = $derived(plan.petals.length + (plan.hasMore ? 1 : 0))

  // One 90° arc: i=0 is straight up, i=arcCount-1 is straight toward the FAB's
  // inward side (left of a right-hand FAB, mirrored for left-hand).
  function angle(i: number): number {
    return arcCount <= 1 ? 0 : (i / (arcCount - 1)) * (Math.PI / 2)
  }

  function petalStyle(i: number): string {
    const t = angle(i)
    const r = 230 // one arc; ~12px air between petals
    const tx = -dir * r * Math.sin(t)
    const ty = -r * Math.cos(t)
    return `--tx: ${tx}px; --ty: ${ty}px; --d: ${i * 22}ms`
  }

  function labelStyle(i: number): string {
    const t = angle(i)
    const r = 230
    // Labels clear the petal by its radius vertically but by half their own
    // width horizontally, so the offset grows as the direction turns sideways.
    const lr = r + 46 + 18 * Math.sin(t)
    const tx = -dir * lr * Math.sin(t)
    const ty = -lr * Math.cos(t) - 13
    return `--tx: ${tx}px; --ty: ${ty}px; --d: ${i * 22 + 40}ms`
  }

  function setOpen(next: boolean) {
    open = next
  }

  function selectKind(kind: string) {
    setOpen(false)
    navigate(`#/log/${kind}`)
  }

  // More folds the fan away in favor of the sheet rather than claiming an 8th
  // arc position — the sheet has no geometry limit, so it always fits.
  function openMore() {
    setOpen(false)
    showMore = true
  }

  function closeMore() {
    showMore = false
  }

  function selectFromSheet(kind: string) {
    showMore = false
    navigate(`#/log/${kind}`)
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !open) return
    setOpen(false)
    fab?.focus()
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="layer" class:open data-hand={hand}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <!-- Purely a dismiss target; Escape (svelte:window above) is the keyboard
       equivalent, and the petals themselves are focusable buttons. -->
  <div class="scrim" aria-hidden="true" onclick={() => setOpen(false)}></div>

  <div class="petals" inert={!open}>
    {#if !showMore}
      {#each plan.petals as { kind, label, category, glyph }, i (kind)}
        <span class="petal-label" style={labelStyle(i)}>{label.toLowerCase()}</span>
        <button
          type="button"
          class="petal {CATEGORY_META[category].hueClass}"
          style={petalStyle(i)}
          aria-label="Log {label}"
          data-testid="log-{kind}"
          onclick={() => selectKind(kind)}
        >
          {glyph ?? CATEGORY_META[category].glyph}
        </button>
      {/each}
      {#if plan.hasMore}
        <span class="petal-label" style={labelStyle(plan.petals.length)}>more</span>
        <button
          type="button"
          class="petal more"
          style={petalStyle(plan.petals.length)}
          aria-label="More actions"
          data-testid="bloom-more"
          onclick={openMore}
        >
          ⋯
        </button>
      {/if}
    {/if}
  </div>

  <button
    bind:this={fab}
    type="button"
    class="fab"
    aria-label="Log an entry"
    aria-expanded={open}
    data-testid="fab"
    onclick={() => setOpen(!open)}
  >
    <span>+</span>
  </button>
</div>

{#if showMore}
  <Sheet onclose={closeMore}>
    <h2>More actions</h2>
    <p class="muted">Everything you can log, in one place.</p>
    <div class="more-grid" role="group" aria-label="All log actions">
      {#each ordered as { kind, label, category, glyph } (kind)}
        <button
          type="button"
          class="more-item {CATEGORY_META[category].hueClass}"
          data-testid="log-{kind}"
          onclick={() => selectFromSheet(kind)}
        >
          <span class="more-glyph" aria-hidden="true">{glyph ?? CATEGORY_META[category].glyph}</span>
          <span class="more-label">{label}</span>
        </button>
      {/each}
    </div>
  </Sheet>
{/if}

<style>
  .layer {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 50;
  }

  .scrim {
    position: absolute;
    inset: 0;
    background: var(--scrim);
    backdrop-filter: blur(2px);
    -webkit-backdrop-filter: blur(2px);
    opacity: 0;
    transition: opacity var(--duration-base);
    pointer-events: none;
  }

  .layer.open .scrim {
    opacity: 1;
    pointer-events: auto;
  }

  .fab {
    position: absolute;
    bottom: calc(26px + env(safe-area-inset-bottom));
    width: 56px;
    height: 56px;
    min-width: 56px;
    border-radius: 50%;
    border: none;
    background: var(--action);
    color: var(--bg);
    font-size: 28px;
    line-height: 1;
    box-shadow: var(--shadow-2);
    cursor: pointer;
    pointer-events: auto;
    display: grid;
    place-items: center;
    transition:
      transform var(--duration-base),
      background var(--duration-fast);
  }

  .layer[data-hand='right'] .fab {
    right: 22px;
  }

  .layer[data-hand='left'] .fab {
    left: 22px;
  }

  .fab span {
    display: block;
    transition: transform var(--duration-base);
  }

  .layer.open .fab span {
    transform: rotate(45deg);
  }

  .petal {
    position: absolute;
    bottom: calc(26px + env(safe-area-inset-bottom));
    width: 48px;
    height: 48px;
    min-width: 48px;
    border-radius: 50%;
    border: 1px solid var(--border);
    background: var(--surface);
    font-size: 19px;
    box-shadow: var(--shadow-1);
    cursor: pointer;
    pointer-events: none;
    display: grid;
    place-items: center;
    opacity: 0;
    transform: translate(0, 0) scale(0.4);
    transition:
      transform var(--duration-base) cubic-bezier(0.2, 0.9, 0.3, 1.15),
      opacity var(--duration-fast);
    transition-delay: var(--d, 0ms);
  }

  .layer[data-hand='right'] .petal {
    right: 26px;
  }

  .layer[data-hand='left'] .petal {
    left: 26px;
  }

  .layer.open .petal {
    opacity: 1;
    pointer-events: auto;
    transform: translate(var(--tx), var(--ty)) scale(1);
  }

  .petal:hover,
  .petal:active {
    border-color: var(--action);
    background: var(--action-muted);
  }

  /* Visually distinct from an action petal — muted and dashed, so it reads as
     "more options" rather than another loggable kind. */
  .petal.more {
    color: var(--muted);
    border-style: dashed;
  }

  .petal.more:hover,
  .petal.more:active {
    border-color: var(--muted);
    background: var(--surface);
  }

  .petal-label {
    position: absolute;
    bottom: calc(26px + env(safe-area-inset-bottom));
    padding: 0.15rem 0.55rem;
    border-radius: var(--radius-full);
    background: var(--surface);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-1);
    font-size: 0.7rem;
    font-family: var(--font-data);
    color: var(--text);
    white-space: nowrap;
    opacity: 0;
    transform: translateX(var(--cx, 0));
    transition:
      opacity var(--duration-fast),
      transform var(--duration-base);
    transition-delay: var(--d, 0ms);
    pointer-events: none;
  }

  /* --cx re-centers the pill on its radial point: petals are fixed-width and
     edge-anchored, but the pill's width varies, so without this labels drift
     into neighbouring petals. */
  .layer[data-hand='right'] .petal-label {
    right: 26px;
    --cx: calc(50% - 24px);
  }

  .layer[data-hand='left'] .petal-label {
    left: 26px;
    --cx: calc(-50% + 24px);
  }

  .layer.open .petal-label {
    opacity: 1;
    transform: translate(var(--tx), var(--ty)) translateX(var(--cx, 0));
  }

  h2 {
    margin: 0 0 var(--space-2);
  }

  .more-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
    gap: var(--space-3);
    margin-top: var(--space-4);
  }

  .more-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-3) var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
  }

  .more-item:hover,
  .more-item:active {
    border-color: var(--action);
    background: var(--action-muted);
  }

  .more-glyph {
    font-size: 1.4rem;
    color: currentColor;
  }

  .more-label {
    font-size: var(--text-xs);
  }
</style>
