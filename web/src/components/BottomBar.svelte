<script lang="ts">
  import { navigate } from '../lib/router.svelte'

  const kinds: { kind: string; label: string }[] = [
    { kind: 'vitals', label: 'Vitals' },
    { kind: 'symptom', label: 'Symptom' },
    { kind: 'meds', label: 'Meds' },
    { kind: 'food', label: 'Food' },
    { kind: 'move', label: 'Move' },
    { kind: 'note', label: 'Note' },
  ]
</script>

<nav aria-label="Log an entry">
  {#each kinds as { kind, label } (kind)}
    <button data-testid="log-{kind}" onclick={() => navigate(`#/log/${kind}`)}>
      {label}
    </button>
  {/each}
</nav>

<style>
  nav {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-2)
      calc(var(--space-2) + env(safe-area-inset-bottom));
    background: var(--action);
    border-top: 1px solid var(--action);
  }

  button {
    flex: 1;
    min-width: 0;
    background: var(--action);
    color: var(--bg);
    border-color: transparent;
    font-size: var(--text-xs);
    padding: var(--space-2) var(--space-1);
  }

  button:hover {
    filter: brightness(1.15);
    border-color: transparent;
  }
</style>
