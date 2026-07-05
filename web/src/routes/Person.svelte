<script lang="ts">
  import { onMount } from 'svelte'
  import { navigate } from '../lib/router.svelte'
  import { getShare, sharedEventsFor, type Share } from '../lib/shared'
  import type { StoredEvent } from '../lib/events'
  import Spine from '../components/Spine.svelte'

  let { ed }: { ed: string } = $props()

  let share = $state<Share | undefined>(undefined)
  let events = $state<StoredEvent[]>([])
  let loaded = $state(false)

  onMount(async () => {
    share = await getShare(ed)
    events = share ? await sharedEventsFor(ed) : []
    loaded = true
  })
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
    <Spine hue={share.hue} {events} readonly />
  {/if}
{/if}
