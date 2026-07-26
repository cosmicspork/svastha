<script lang="ts">
  import { onMount } from 'svelte'
  import { get } from '../lib/db'
  import Spine from '../components/Spine.svelte'

  // Own-record chronological spine, now its own page (Home is a dashboard). The
  // owner hue rules the spine, same as it did when this lived under Home.
  let hue = $state<'a' | 'b'>('a')

  onMount(async () => {
    const stored = await get<'a' | 'b'>('prefs', 'hue')
    if (stored) hue = stored
  })
</script>

<h1>Timeline</h1>
<Spine {hue} />
