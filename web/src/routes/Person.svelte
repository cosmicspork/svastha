<script lang="ts">
  import { onMount } from 'svelte'
  import { get, put } from '../lib/db'
  import { navigate } from '../lib/router.svelte'
  import { getShare, sharedEventsFor, type Share } from '../lib/shared'
  import type { StoredEvent } from '../lib/events'
  import Spine from '../components/Spine.svelte'
  import ClinicianSummary from '../components/ClinicianSummary.svelte'

  let { ed }: { ed: string } = $props()

  let share = $state<Share | undefined>(undefined)
  let events = $state<StoredEvent[]>([])
  let loaded = $state(false)
  // Shares the own-record screen's `person-view` preference (see Home.svelte).
  let view = $state<'timeline' | 'summary'>('timeline')

  onMount(async () => {
    share = await getShare(ed)
    events = share ? await sharedEventsFor(ed) : []
    const storedView = await get<'timeline' | 'summary'>('prefs', 'person-view')
    if (storedView) view = storedView
    loaded = true
  })

  async function setView(next: 'timeline' | 'summary') {
    view = next
    await put('prefs', next, 'person-view')
  }
</script>

{#if loaded}
  {#if !share}
    <h1>Not shared</h1>
    <p class="muted" data-testid="person-not-shared">No longer shared with you.</p>
    <button onclick={() => navigate('#/')} data-testid="person-back">Back to my record</button>
  {:else}
    <h1>{share.label} <span class="muted">— read-only</span></h1>
    {#if share.stale}
      <p class="muted" data-testid="person-stale">No longer shared with you.</p>
    {/if}
    <div class="seg view-toggle" role="group" aria-label="Record view" data-testid="person-view-toggle">
      <button aria-pressed={view === 'timeline'} onclick={() => setView('timeline')} data-testid="view-timeline">
        Timeline
      </button>
      <button aria-pressed={view === 'summary'} onclick={() => setView('summary')} data-testid="view-summary">
        Summary
      </button>
    </div>
    {#if view === 'timeline'}
      <Spine hue={share.hue} {events} readonly />
    {:else}
      <ClinicianSummary {events} readonly />
    {/if}
  {/if}
{/if}

<style>
  .view-toggle {
    margin-bottom: var(--space-4);
  }
</style>
