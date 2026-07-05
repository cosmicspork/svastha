<script lang="ts">
  import { onMount } from 'svelte'
  import { tagsOf, setTags, allTags } from '../lib/curation'

  let {
    eventId,
    onChange,
  }: {
    eventId: string
    /** Fired after every write, so a parent tracking its own tag/allTags
     * cache (Spine, Correlate) can refresh without re-reading the whole
     * curation store. */
    onChange?: (tags: string[]) => void
  } = $props()

  let tags = $state<string[]>([])
  let pending = $state('')
  let suggestions = $state<string[]>([])
  let loaded = $state(false)

  onMount(async () => {
    tags = await tagsOf(eventId)
    suggestions = await allTags()
    loaded = true
  })

  const matchingSuggestions = $derived(
    pending.trim()
      ? suggestions.filter(
          (s) => s.toLowerCase().startsWith(pending.trim().toLowerCase()) && !tags.includes(s),
        )
      : suggestions.filter((s) => !tags.includes(s)),
  )

  async function commit(next: string[]) {
    // Pass `next` (a plain array), not the reactive `tags` binding read back
    // after assignment: Svelte 5 wraps `$state` arrays in a reactivity proxy,
    // which IndexedDB's structured-clone `put` cannot serialize
    // ("[object Array] could not be cloned").
    tags = next
    await setTags(eventId, next)
    onChange?.(next)
  }

  function addPending() {
    const tag = pending.trim().replace(/,+$/, '')
    pending = ''
    if (tag && !tags.some((t) => t.toLowerCase() === tag.toLowerCase())) void commit([...tags, tag])
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addPending()
    }
  }

  function remove(tag: string) {
    void commit(tags.filter((t) => t !== tag))
  }

  function addSuggestion(tag: string) {
    if (!tags.includes(tag)) void commit([...tags, tag])
  }
</script>

{#if loaded}
  <div class="editor" data-testid="tag-editor">
    {#if tags.length > 0}
      <div class="chips">
        {#each tags as tag (tag)}
          <span class="chip" data-testid="tag-chip">
            #{tag}
            <button type="button" class="remove" aria-label="Remove tag {tag}" onclick={() => remove(tag)}>
              ×
            </button>
          </span>
        {/each}
      </div>
    {/if}

    <input
      bind:value={pending}
      onkeydown={onKeydown}
      autocomplete="off"
      placeholder="Add a tag — Enter or comma adds it"
      data-testid="tag-input"
    />

    {#if matchingSuggestions.length > 0}
      <div class="chips suggestions">
        {#each matchingSuggestions.slice(0, 8) as tag (tag)}
          <button
            type="button"
            class="chip suggestion"
            onclick={() => addSuggestion(tag)}
            data-testid="tag-suggestion"
          >
            #{tag}
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .chip {
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

  .suggestion {
    background: var(--bg);
    padding: var(--space-1) var(--space-3);
  }

  input {
    font-size: var(--text-sm);
  }
</style>
