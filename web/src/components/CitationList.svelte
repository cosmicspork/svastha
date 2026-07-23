<script lang="ts">
  import { get } from '../lib/db'
  import { navigate } from '../lib/router.svelte'
  import { focusedEventId } from '../lib/spine-focus'
  import { describeEvent } from '../lib/timeline'
  import { formatDay, dayKey } from '../lib/time'
  import type { StoredEvent } from '../lib/events'

  // The event content ids an answer cited. Each resolves to a compact reference
  // that deep-links to the event on the spine (see spine-focus.ts). An id the
  // owner's record doesn't hold — an answer that outran a sync, or cited an event
  // since removed — is shown honestly rather than hidden, so a citation is never
  // silently dropped.
  let { citations }: { citations: string[] } = $props()

  interface Cited {
    id: string
    label: string
    value: string
    day: string | null
    found: boolean
  }

  let resolved = $state<Cited[]>([])

  $effect(() => {
    const ids = citations
    void Promise.all(
      ids.map(async (id): Promise<Cited> => {
        const stored = await get<StoredEvent>('events', id)
        if (!stored) return { id, label: 'Not in your record', value: '', day: null, found: false }
        const { label, value } = describeEvent(stored.event)
        return {
          id,
          label,
          value,
          day: stored.event.effective_at ? formatDay(dayKey(stored.event.effective_at)) : null,
          found: true,
        }
      }),
    ).then((r) => (resolved = r))
  })

  function open(c: Cited): void {
    if (!c.found) return
    focusedEventId.set(c.id)
    navigate('#/')
  }
</script>

{#if citations.length > 0}
  <ul class="citations" data-testid="citation-list">
    {#each resolved as c (c.id)}
      <li>
        {#if c.found}
          <button type="button" class="citation" onclick={() => open(c)} data-testid="citation">
            <span class="cite-label">{c.label}</span>
            {#if c.value}<span class="cite-value data">{c.value}</span>{/if}
            {#if c.day}<span class="cite-day muted">{c.day}</span>{/if}
          </button>
        {:else}
          <span class="citation missing muted" data-testid="citation-missing">
            {c.label}
          </span>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .citations {
    list-style: none;
    margin: var(--space-2) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .citation {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    text-align: left;
    font-size: var(--text-sm);
  }

  .citation.missing {
    background: none;
    border-style: dashed;
  }

  .cite-label {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .cite-value {
    font-size: var(--text-sm);
  }

  .cite-day {
    margin-left: auto;
    font-size: var(--text-xs);
  }
</style>
