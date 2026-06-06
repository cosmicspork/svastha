<script lang="ts">
  import { CONTRACT_VERSION } from './lib/version'
</script>

<main>
  <h1>Svastha</h1>
  <p>Self-custodial, end-to-end-encrypted, local-first personal medical records.</p>
  <p class="muted">Skeleton. Trust contract v{CONTRACT_VERSION}.</p>
</main>

<style>
  main {
    max-width: 40rem;
    margin: 4rem auto;
    padding: 0 1rem;
    font-family: system-ui, sans-serif;
    line-height: 1.5;
  }
  h1 {
    margin-bottom: 0.25rem;
  }
  .muted {
    color: #888;
    font-size: 0.9rem;
  }
</style>
