<script lang="ts">
  import { onMount } from 'svelte'
  import { listFavorites, type Favorite } from '../lib/favorites'
  import { recentDrafts, templateLabel } from '../lib/events'
  import type { Category } from '../lib/category'
  import type { DraftTemplate } from '../lib/drafts'

  let {
    category,
    onPick,
    onInstant,
  }: {
    category: Category
    /** Prefill the form (tap 1 of the two-tap flow). */
    onPick: (templates: DraftTemplate[], label: string) => void
    /** Log immediately with `effective_at` = now (the one-tap ⚡ path). */
    onInstant: (templates: DraftTemplate[], label: string) => void
  } = $props()

  let favorites = $state<Favorite[]>([])
  let recents = $state<DraftTemplate[]>([])

  onMount(async () => {
    favorites = await listFavorites(category)
    const favoriteLabels = new Set(favorites.map((f) => f.label.toLowerCase()))
    // Recents that duplicate a favorite would just be a second identical chip.
    recents = (await recentDrafts(category, 12)).filter(
      (t) => !favoriteLabels.has(templateLabel(t).toLowerCase()),
    ).slice(0, 8)
  })
</script>

{#if favorites.length > 0 || recents.length > 0}
  <div class="chips" data-testid="favorites-row">
    {#each favorites as favorite (favorite.label)}
      <span class="chip favorite">
        <button
          type="button"
          class="chip-main"
          onclick={() => onPick(favorite.drafts, favorite.label)}
          data-testid="favorite-chip"
        >
          ★ {favorite.label}
        </button>
        <button
          type="button"
          class="chip-zap"
          aria-label="Log {favorite.label} now"
          onclick={() => onInstant(favorite.drafts, favorite.label)}
          data-testid="favorite-instant"
        >
          ⚡
        </button>
      </span>
    {/each}
    {#each recents as recent, i (i)}
      <button
        type="button"
        class="chip-main recent"
        onclick={() => onPick([recent], templateLabel(recent))}
        data-testid="recent-chip"
      >
        {templateLabel(recent)}
      </button>
    {/each}
  </div>
{/if}

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
  }

  .chip {
    display: inline-flex;
  }

  .chip-main {
    min-width: 0;
    border-radius: 999px;
    padding: var(--space-1) var(--space-3);
    font-size: var(--text-sm);
  }

  .favorite .chip-main {
    border-radius: 999px 0 0 999px;
    border-right: none;
  }

  .chip-zap {
    min-width: 0;
    border-radius: 0 999px 999px 0;
    padding: var(--space-1) var(--space-2);
    font-size: var(--text-sm);
    background: var(--action-muted);
  }

  .recent {
    background: var(--bg);
  }
</style>
