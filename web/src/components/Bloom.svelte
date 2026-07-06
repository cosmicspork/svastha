<script lang="ts">
  import { onMount } from 'svelte'
  import { get } from '../lib/db'
  import { navigate } from '../lib/router.svelte'
  import { CATEGORY_META } from '../lib/category'
  import { LOG_KINDS, type LogKind } from '../lib/log-kinds'
  import { orderByFrequency } from '../lib/bloom-order'
  import { categoryLogCounts } from '../lib/events'

  let hand = $state<'left' | 'right'>('right')
  // Default order until frequency counts load, per orderByFrequency's own
  // tiebreak — no flash of a differently-ordered fan on first paint.
  let ordered = $state<LogKind[]>(LOG_KINDS)
  let open = $state(false)
  let fab: HTMLButtonElement | undefined = $state()

  onMount(async () => {
    const storedHand = await get<'left' | 'right'>('prefs', 'fab-hand')
    if (storedHand) hand = storedHand
    const counts = await categoryLogCounts()
    ordered = orderByFrequency(LOG_KINDS, (k) => counts[k.category] ?? 0)
  })

  const dir = $derived(hand === 'left' ? -1 : 1)

  // One 90° arc: i=0 is straight up, i=n-1 is straight toward the FAB's
  // inward side (left of a right-hand FAB, mirrored for left-hand).
  function angle(i: number): number {
    return (i / (ordered.length - 1)) * (Math.PI / 2)
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
    {#each ordered as { kind, label, category }, i (kind)}
      <span class="petal-label" style={labelStyle(i)}>{label.toLowerCase()}</span>
      <button
        type="button"
        class="petal {CATEGORY_META[category].hueClass}"
        style={petalStyle(i)}
        aria-label="Log {label}"
        data-testid="log-{kind}"
        onclick={() => selectKind(kind)}
      >
        {CATEGORY_META[category].glyph}
      </button>
    {/each}
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
</style>
