<script lang="ts">
  // Shared toggleable tag-filter chip row — used by both Spine (filtering the
  // owner's own timeline) and Correlate (filtering lanes before charting), so
  // "filter by tag" looks and behaves identically in both places.
  let {
    tags,
    selected,
    onToggle,
    testIdPrefix = 'tag-filter',
  }: {
    tags: string[]
    selected: ReadonlySet<string>
    onToggle: (tag: string) => void
    testIdPrefix?: string
  } = $props()
</script>

{#if tags.length > 0}
  <div class="chips" data-testid="{testIdPrefix}s">
    {#each tags as tag (tag)}
      <button
        type="button"
        class="chip"
        aria-pressed={selected.has(tag)}
        onclick={() => onToggle(tag)}
        data-testid="{testIdPrefix}-{tag}"
      >
        #{tag}
      </button>
    {/each}
  </div>
{/if}

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    margin-bottom: var(--space-4);
  }

  .chip {
    min-width: 0;
    min-height: 36px;
    border-radius: 999px;
    font-size: var(--text-xs);
    padding: var(--space-1) var(--space-3);
  }

  .chip[aria-pressed='true'] {
    border-color: var(--action);
    color: var(--action);
    background: var(--action-muted);
  }
</style>
