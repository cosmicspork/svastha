<script lang="ts">
  import { onMount } from 'svelte'
  import { get } from '../lib/db'
  import { navigate } from '../lib/router.svelte'
  import { getShare, sharedEventsFor, type Share } from '../lib/shared'
  import type { StoredEvent } from '../lib/events'
  import Spine from '../components/Spine.svelte'
  import ClinicianSummary from '../components/ClinicianSummary.svelte'

  // One record view for your own vault and for a shared person's record. `ed`
  // set → that person's record (read-only); absent → your own (writable).
  // `view` comes from the route (/timeline vs /summary, /person/:ed/timeline vs
  // …/summary) rather than an in-page toggle, so own and shared records look and
  // behave identically — the dashboard's Timeline/Summary buttons pick which.
  let { ed, view }: { ed?: string; view: 'timeline' | 'summary' } = $props()

  let hue = $state<'a' | 'b'>('a')
  let share = $state<Share | undefined>(undefined)
  let events = $state<StoredEvent[]>([])
  let loaded = $state(false)

  onMount(async () => {
    if (ed) {
      share = await getShare(ed)
      events = share ? await sharedEventsFor(ed) : []
    } else {
      const stored = await get<'a' | 'b'>('prefs', 'hue')
      if (stored) hue = stored
    }
    loaded = true
  })
</script>

{#if !ed}
  {#if view === 'timeline'}
    <h1>Timeline</h1>
    <Spine {hue} />
  {:else}
    <ClinicianSummary heading="Summary" />
  {/if}
{:else if loaded}
  {#if !share}
    <h1>Not shared</h1>
    <p class="muted" data-testid="person-not-shared">No longer shared with you.</p>
    <button onclick={() => navigate('#/')} data-testid="person-back">Back to my record</button>
  {:else}
    <h1 style:color={`var(--person-${share.hue})`}>{share.label}</h1>
    {#if share.stale}
      <p class="muted" data-testid="person-stale">No longer shared with you.</p>
    {/if}
    {#if view === 'timeline'}
      <Spine hue={share.hue} {events} readonly />
    {:else}
      <ClinicianSummary {events} readonly />
    {/if}
  {/if}
{/if}
