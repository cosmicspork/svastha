<script lang="ts">
  import { onMount } from 'svelte'
  import { get } from '../lib/db'
  import Spine from '../components/Spine.svelte'

  let hue = $state<'a' | 'b'>('a')

  onMount(async () => {
    const stored = await get<'a' | 'b'>('prefs', 'hue')
    if (stored) hue = stored
  })
</script>

<h1>Svastha</h1>

<Spine {hue} />
