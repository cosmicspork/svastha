<script lang="ts">
  import { fiddlehead, VIEW_BOX } from '../lib/mark'

  let { small = false }: { small?: boolean } = $props()

  const d = $derived(fiddlehead(small))
</script>

<!-- Fills its box and paints in currentColor: a caller sizes and animates the
     mark from the outside. -->
<svg viewBox="0 0 {VIEW_BOX} {VIEW_BOX}" aria-hidden="true">
  <path {d} fill="currentColor" />
</svg>

<style>
  svg {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
