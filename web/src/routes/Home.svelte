<script lang="ts">
  import { onMount } from 'svelte'
  import { get } from '../lib/db'

  let hue = $state<'a' | 'b'>('a')

  onMount(async () => {
    const stored = await get<'a' | 'b'>('prefs', 'hue')
    if (stored) hue = stored
  })
</script>

<h1>Svastha</h1>

<div class="spine" style:--spine-color={`var(--person-${hue})`}>
  <div class="rule"></div>
  <div class="tick" data-testid="day-tick"></div>
  <p class="empty-copy" data-testid="empty-state">
    Nothing logged yet. Start with today — tap Log below.
  </p>
</div>

<style>
  .spine {
    position: relative;
    padding-left: var(--space-5);
    min-height: 12rem;
  }

  .rule {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--spine-color);
  }

  .tick {
    position: absolute;
    left: -3px;
    top: var(--space-1);
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--spine-color);
  }

  .empty-copy {
    color: var(--muted);
    padding-top: var(--space-1);
  }
</style>
