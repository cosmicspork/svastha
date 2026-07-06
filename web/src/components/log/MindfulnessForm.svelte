<script lang="ts">
  import { MOOD, MOOD_NOTE, GRATITUDE } from '../../lib/codes'
  import { moodDraft, gratitudeDrafts, type Draft, type DraftTemplate } from '../../lib/drafts'
  import { MOOD_WORDS } from '../../lib/timeline'
  import LogShell from './LogShell.svelte'

  type Pane = 'mood' | 'gratitude'

  /** Waxing-moon fill fraction per score — the mockup's exact steps, not an
   * evenly-spaced 0.2/0.4/0.6/0.8/1: the moon should read as barely-lit at
   * "rough" and nearly-full at "bright", not a linear ramp. */
  const MOOD_SCALE = [
    { score: 1, fill: 0.06 },
    { score: 2, fill: 0.28 },
    { score: 3, fill: 0.5 },
    { score: 4, fill: 0.75 },
    { score: 5, fill: 1 },
  ]

  let pane = $state<Pane>('mood')
  let moodScore = $state<number | null>(null)
  let moodNote = $state('')

  let items = $state<string[]>([])
  let pending = $state('')

  function addPending() {
    const item = pending.trim().replace(/,+$/, '')
    if (item && !items.some((i) => i.toLowerCase() === item.toLowerCase())) {
      items = [...items, item]
    }
    pending = ''
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addPending()
    }
  }

  function remove(item: string) {
    items = items.filter((i) => i !== item)
  }

  function buildDrafts(effectiveAt: string): Draft[] | null {
    if (pane === 'mood') {
      return moodScore !== null ? moodDraft(moodScore, moodNote, effectiveAt) : null
    }
    // Un-chipped text still counts — typing one item and hitting Save without
    // Enter is the common single-item case (see FoodForm).
    const all = pending.trim() ? [...items, pending.trim().replace(/,+$/, '')] : items
    return all.length > 0 ? gratitudeDrafts(all, effectiveAt) : null
  }

  function favoriteLabel(): string {
    if (pane === 'mood') {
      const word = moodScore !== null ? MOOD_WORDS[moodScore] : ''
      return `Mood: ${word}`
    }
    const all = pending.trim() ? [...items, pending.trim()] : items
    const first = all[0] ?? ''
    // FoodForm doesn't truncate its (joined) label; gratitude's is one short
    // phrase, so it follows NoteForm's 40-char convention instead.
    return first.length > 40 ? `${first.slice(0, 40)}…` : first
  }

  function onReset() {
    moodScore = null
    moodNote = ''
    items = []
    pending = ''
  }

  function onPrefill(templates: DraftTemplate[]) {
    const moodTemplate = templates.find((t) => t.code?.code === MOOD.code)
    if (moodTemplate && 'quantity' in moodTemplate.value) {
      pane = 'mood'
      moodScore = Number(moodTemplate.value.quantity.value)
      const noteTemplate = templates.find((t) => t.code?.code === MOOD_NOTE.code)
      moodNote = noteTemplate && 'text' in noteTemplate.value ? noteTemplate.value.text : ''
      return
    }
    pane = 'gratitude'
    for (const t of templates) {
      if (t.code?.code !== GRATITUDE.code || !('text' in t.value)) continue
      const text = t.value.text
      if (!items.some((i) => i.toLowerCase() === text.toLowerCase())) {
        items = [...items, text]
      }
    }
  }
</script>

<LogShell title="Mindfulness" category="mind" {buildDrafts} {favoriteLabel} {onPrefill} {onReset}>
  <div class="seg" role="group" aria-label="Mood or gratitude">
    <button
      type="button"
      aria-pressed={pane === 'mood'}
      onclick={() => (pane = 'mood')}
      data-testid="mind-tab-mood"
    >
      Mood
    </button>
    <button
      type="button"
      aria-pressed={pane === 'gratitude'}
      onclick={() => (pane = 'gratitude')}
      data-testid="mind-tab-gratitude"
    >
      Gratitude
    </button>
  </div>

  {#if pane === 'mood'}
    <p class="prompt">How are you, on the whole?</p>
    <div class="moods" role="group" aria-label="Mood">
      {#each MOOD_SCALE as m (m.score)}
        <button
          type="button"
          class="mood"
          aria-pressed={moodScore === m.score}
          onclick={() => (moodScore = m.score)}
          data-testid="mood-{m.score}"
        >
          <span class="moon" style:--fill={m.fill}></span>
          <small>{MOOD_WORDS[m.score]}</small>
        </button>
      {/each}
    </div>
    <label class="field">
      A word about it <span class="optional">(optional)</span>
      <input
        bind:value={moodNote}
        autocomplete="off"
        placeholder="calm morning"
        data-testid="mood-note"
      />
    </label>
  {:else}
    <p class="prompt">What was good today? Small counts.</p>
    {#if items.length > 0}
      <div class="items">
        {#each items as item (item)}
          <span class="item" data-testid="gratitude-item">
            {item}
            <button
              type="button"
              class="remove"
              aria-label="Remove {item}"
              onclick={() => remove(item)}
            >
              ×
            </button>
          </span>
        {/each}
      </div>
    {/if}
    <label class="field">
      Add items
      <input
        bind:value={pending}
        onkeydown={onKeydown}
        autocomplete="off"
        placeholder="slow morning, call with mom — Enter or comma adds each"
        data-testid="gratitude-input"
      />
    </label>
  {/if}
</LogShell>

<style>
  .prompt {
    font-size: var(--text-sm);
    color: var(--muted);
    margin-bottom: 0;
  }

  .optional {
    opacity: 0.6;
  }

  /* mood scale — the mockup's waxing moon, filled bottom-up by --fill */
  .moods {
    display: flex;
    justify-content: space-between;
    gap: var(--space-2);
    margin: var(--space-3) 0 var(--space-2);
  }

  .mood {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    background: none;
    border: none;
    min-height: auto;
    min-width: 0;
    padding: var(--space-2) 0;
    border-radius: var(--radius-sm);
  }

  .mood .moon {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    border: 2px solid var(--cat-mind);
    position: relative;
    overflow: hidden;
    transition: box-shadow var(--duration-fast);
  }

  .mood .moon::after {
    content: '';
    position: absolute;
    inset: 0;
    background: var(--cat-mind);
    transform-origin: bottom;
    transform: scaleY(var(--fill, 0));
    transition: transform var(--duration-base);
  }

  .mood small {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .mood[aria-pressed='true'] .moon {
    box-shadow: 0 0 0 3px var(--action-muted), 0 0 0 4px var(--action);
  }

  .mood[aria-pressed='true'] small {
    color: var(--text);
    font-weight: 700;
  }

  /* gratitude chips — same pattern as FoodForm's item entry */
  .items {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .item {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    padding: var(--space-1) var(--space-2) var(--space-1) var(--space-3);
    font-size: var(--text-sm);
  }

  .remove {
    min-height: auto;
    min-width: auto;
    border: none;
    background: none;
    padding: 0 var(--space-1);
    color: var(--muted);
  }
</style>
