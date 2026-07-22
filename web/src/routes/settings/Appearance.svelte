<script lang="ts">
  import { onMount } from 'svelte'
  import { del, get, put } from '../../lib/db'
  import { loadTheme, setTheme, type ThemePref } from '../../lib/theme'
  import { CATEGORY_META } from '../../lib/category'
  import { LOG_KINDS } from '../../lib/log-kinds'
  import {
    applyStoredOrder,
    BLOOM_ORDER_PREF,
    MAX_ACTION_PETALS,
    orderByFrequency,
  } from '../../lib/bloom-order'
  import { categoryLogCounts } from '../../lib/events'

  // --- appearance ---
  let theme = $state<ThemePref>('system')
  onMount(async () => {
    theme = await loadTheme()
  })
  async function pickTheme(pref: ThemePref) {
    theme = pref
    await setTheme(pref)
  }

  let hue = $state<'a' | 'b'>('a')
  onMount(async () => {
    const stored = await get<'a' | 'b'>('prefs', 'hue')
    if (stored) hue = stored
  })
  async function setHue(value: 'a' | 'b') {
    hue = value
    await put('prefs', value, 'hue')
  }

  let fabHand = $state<'right' | 'left'>('right')
  onMount(async () => {
    const stored = await get<'right' | 'left'>('prefs', 'fab-hand')
    if (stored) fabHand = stored
  })
  async function setFabHand(value: 'right' | 'left') {
    fabHand = value
    await put('prefs', value, 'fab-hand')
  }

  // --- bloom petal order ---
  // null = automatic (frequency-ordered, the default); an array = the user's
  // manual order, stored under BLOOM_ORDER_PREF and read by Bloom.svelte.
  let bloomOrder = $state<string[] | null>(null)
  onMount(async () => {
    bloomOrder = (await get<string[]>('prefs', BLOOM_ORDER_PREF)) ?? null
  })

  const orderedKinds = $derived(
    bloomOrder ? applyStoredOrder(LOG_KINDS, bloomOrder, (k) => k.kind) : [],
  )

  async function useAutomaticOrder() {
    bloomOrder = null
    await del('prefs', BLOOM_ORDER_PREF)
  }

  // Seed the manual list from today's automatic order, so switching to Custom
  // starts from the fan the user already sees rather than the factory default.
  async function useCustomOrder() {
    if (bloomOrder) return
    const counts = await categoryLogCounts()
    const seeded = orderByFrequency(LOG_KINDS, (k) => counts[k.category] ?? 0).map((k) => k.kind)
    bloomOrder = seeded
    await put('prefs', seeded, BLOOM_ORDER_PREF)
  }

  async function moveKind(kind: string, delta: -1 | 1) {
    if (!bloomOrder) return
    const current = orderedKinds.map((k) => k.kind)
    const i = current.indexOf(kind)
    const j = i + delta
    if (i < 0 || j < 0 || j >= current.length) return
    ;[current[i], current[j]] = [current[j], current[i]]
    // `current` is a fresh plain array, not the $state proxy — IndexedDB's
    // structured-clone put can't serialize a reactivity proxy.
    bloomOrder = current
    await put('prefs', current, BLOOM_ORDER_PREF)
  }
</script>

<h1>Appearance</h1>

<section class="stack">
  <div class="setrow">
    <span class="l">Theme</span>
    <div class="seg" style:width="13rem">
      <button
        aria-pressed={theme === 'light'}
        onclick={() => pickTheme('light')}
        data-testid="theme-light"
      >
        Light
      </button>
      <button
        aria-pressed={theme === 'dark'}
        onclick={() => pickTheme('dark')}
        data-testid="theme-dark"
      >
        Dark
      </button>
      <button
        aria-pressed={theme === 'system'}
        onclick={() => pickTheme('system')}
        data-testid="theme-system"
      >
        System
      </button>
    </div>
  </div>
  <div class="setrow">
    <span class="l">Timeline accent<small>Colors the spine of your own record</small></span>
    <div class="swatches">
      <button
        class="swatch"
        style:background="var(--person-a)"
        aria-pressed={hue === 'a'}
        onclick={() => setHue('a')}
        data-testid="hue-a"
        aria-label="Indigo"
      ></button>
      <button
        class="swatch"
        style:background="var(--person-b)"
        aria-pressed={hue === 'b'}
        onclick={() => setHue('b')}
        data-testid="hue-b"
        aria-label="Madder"
      ></button>
    </div>
  </div>
  <div class="setrow">
    <span class="l">Add button<small>Which thumb opens the bloom</small></span>
    <div class="seg" style:width="10rem">
      <button
        aria-pressed={fabHand === 'right'}
        onclick={() => setFabHand('right')}
        data-testid="fab-hand-right"
      >
        Right
      </button>
      <button
        aria-pressed={fabHand === 'left'}
        onclick={() => setFabHand('left')}
        data-testid="fab-hand-left"
      >
        Left
      </button>
    </div>
  </div>
  <div class="setrow">
    <span class="l">Petal order<small>Automatic puts what you log most first</small></span>
    <div class="seg" style:width="11rem">
      <button
        aria-pressed={bloomOrder === null}
        onclick={useAutomaticOrder}
        data-testid="bloom-order-auto"
      >
        Automatic
      </button>
      <button
        aria-pressed={bloomOrder !== null}
        onclick={useCustomOrder}
        data-testid="bloom-order-custom"
      >
        Custom
      </button>
    </div>
  </div>
  {#if bloomOrder}
    <ul class="order-list" data-testid="bloom-order-list">
      {#each orderedKinds as k, i (k.kind)}
        <li class="order-row">
          <span class="order-glyph {CATEGORY_META[k.category].hueClass}" aria-hidden="true">
            {k.glyph ?? CATEGORY_META[k.category].glyph}
          </span>
          <span class="order-label">{k.label}</span>
          <button
            class="order-move"
            onclick={() => moveKind(k.kind, -1)}
            disabled={i === 0}
            aria-label="Move {k.label} up"
            data-testid="bloom-up-{k.kind}"
          >
            ↑
          </button>
          <button
            class="order-move"
            onclick={() => moveKind(k.kind, 1)}
            disabled={i === orderedKinds.length - 1}
            aria-label="Move {k.label} down"
            data-testid="bloom-down-{k.kind}"
          >
            ↓
          </button>
        </li>
      {/each}
    </ul>
    <p class="muted order-hint">
      The first {MAX_ACTION_PETALS} open as petals; the rest fold behind “More”.
    </p>
  {/if}
</section>

<style>
  section {
    margin-top: var(--space-6);
  }

  /* A settings row: a label (with optional muted caption) paired with its
     control, e.g. the .seg theme picker or the hue swatches below. */
  .setrow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
  }

  .setrow .l {
    font-size: var(--text-sm);
  }

  .setrow .l small {
    display: block;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .swatches {
    display: flex;
    gap: var(--space-3);
  }

  .swatch {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 2px solid transparent;
    padding: 0;
  }

  .swatch[aria-pressed='true'] {
    border-color: var(--text);
  }

  .order-list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .order-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
  }

  .order-row + .order-row {
    border-top: 1px solid var(--border);
  }

  .order-glyph {
    width: 1.6em;
    text-align: center;
    color: currentColor;
  }

  .order-label {
    flex: 1;
    font-size: var(--text-sm);
  }

  .order-move {
    min-width: 44px;
    min-height: 44px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--muted);
    font-size: var(--text-base);
  }

  .order-move:disabled {
    opacity: 0.3;
  }

  .order-move:hover:not(:disabled) {
    color: var(--text);
  }

  .order-hint {
    margin-top: var(--space-2);
    font-size: var(--text-xs);
  }
</style>
