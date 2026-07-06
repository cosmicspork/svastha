<script lang="ts">
  import { foodDrafts, type Draft, type DraftTemplate } from '../../lib/drafts'
  import LogShell from './LogShell.svelte'

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
    // Un-chipped text still counts — typing one item and hitting Save without
    // Enter is the common single-item case.
    const all = pending.trim() ? [...items, pending.trim().replace(/,+$/, '')] : items
    return all.length > 0 ? foodDrafts(all, effectiveAt) : null
  }

  function favoriteLabel(): string {
    const all = pending.trim() ? [...items, pending.trim()] : items
    return all.join(', ')
  }

  function onReset() {
    items = []
    pending = ''
  }

  function onPrefill(templates: DraftTemplate[]) {
    for (const t of templates) {
      if (!('text' in t.value)) continue
      const text = t.value.text
      if (!items.some((i) => i.toLowerCase() === text.toLowerCase())) {
        items = [...items, text]
      }
    }
  }
</script>

<LogShell title="Food" category="food" {buildDrafts} {favoriteLabel} {onPrefill} {onReset}>
  {#if items.length > 0}
    <div class="items">
      {#each items as item (item)}
        <span class="item" data-testid="food-item">
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
      placeholder="oatmeal, coffee — Enter or comma adds each"
      data-testid="food-input"
    />
  </label>
</LogShell>

<style>
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
