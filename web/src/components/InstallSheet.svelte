<script lang="ts">
  import Sheet from './Sheet.svelte'
  import { isIos } from '../lib/install'

  let { onclose }: { onclose: () => void } = $props()

  const ios = isIos()
</script>

<Sheet {onclose}>
  <h2>Keep Svastha on your home screen</h2>
  <p>It opens full-screen, works offline, and your records stay on this device.</p>
  <ol class="steps">
    {#if ios}
      <li><span class="k">1</span><span>Tap <b>Share</b> <span class="hint">(the square with the arrow)</span></span></li>
      <li><span class="k">2</span><span>Choose <b>Add to Home Screen</b></span></li>
    {:else}
      <li><span class="k">1</span><span>Open the browser menu</span></li>
      <li><span class="k">2</span><span>Choose <b>Install app</b> <span class="hint">(or Add to Home Screen)</span></span></li>
    {/if}
    <li><span class="k">3</span><span>Open Svastha from the icon from now on</span></li>
  </ol>
  <div class="row">
    <button type="button" class="ghost" style:flex="1" onclick={onclose} data-testid="install-sheet-not-now">
      Not now
    </button>
    <button type="button" class="primary" onclick={onclose} data-testid="install-sheet-done"> Done </button>
  </div>
</Sheet>

<style>
  .steps {
    margin: 0 0 var(--space-4);
    padding: 0;
    list-style: none;
  }

  .steps li {
    display: flex;
    gap: var(--space-3);
    font-size: var(--text-sm);
    padding: var(--space-2) 0;
    align-items: baseline;
  }

  .steps .k {
    font-family: var(--font-data);
    font-size: var(--text-xs);
    color: var(--action);
    flex: none;
    width: 1.2rem;
  }

  .hint {
    opacity: 0.6;
  }

  .row {
    display: flex;
    gap: var(--space-2);
  }
</style>
