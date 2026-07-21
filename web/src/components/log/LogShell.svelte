<script lang="ts">
  import { onDestroy, type Snippet } from 'svelte'
  import { navigate } from '../../lib/router.svelte'
  import { toLocalIso } from '../../lib/time'
  import { logEvent } from '../../lib/events'
  import { fromTemplates, toTemplate, type Draft, type DraftTemplate } from '../../lib/drafts'
  import { addFavorite } from '../../lib/favorites'
  import type { Category } from '../../lib/category'
  import Favorites from '../Favorites.svelte'

  let {
    title,
    category,
    buildDrafts,
    favoriteLabel,
    onPrefill,
    onReset,
    saveLabel = 'Save',
    children,
  }: {
    title: string
    category: Category
    /** Build the drafts to sign, or null while the form isn't saveable. */
    buildDrafts: (effectiveAt: string) => Draft[] | null
    /** Label for the just-saved combo if the user favorites it. */
    favoriteLabel: () => string
    onPrefill: (templates: DraftTemplate[]) => void
    onReset: () => void
    /** Primary button text — most forms just "Save"; a form whose action
     * varies by pane (e.g. CycleForm's "Log flow" / "Log period start") can
     * override it. */
    saveLabel?: string
    children: Snippet
  } = $props()

  // --- time control ---
  let earlier = $state(false)
  let earlierValue = $state('')

  /** Now in `datetime-local` form (minute precision, no offset). */
  function nowLocalInput(): string {
    return toLocalIso(new Date()).slice(0, 16)
  }

  function openEarlier() {
    earlierValue = nowLocalInput()
    earlier = true
  }

  function effectiveAt(): string {
    const now = new Date()
    if (earlier && earlierValue) {
      const picked = new Date(earlierValue)
      // The input's max caps it too, but max is advisory (typed input can
      // exceed it) — clamp so a future-dated fact can't be logged.
      return toLocalIso(picked < now ? picked : now)
    }
    return toLocalIso(now)
  }

  // The probe timestamp is throwaway — buildDrafts only embeds it, so any
  // valid string works for the "is the form saveable" check.
  const canSave = $derived(buildDrafts('2000-01-01T00:00:00+00:00') !== null)

  // --- save + toast ---
  let saving = $state(false)
  let error = $state('')
  let toast = $state<{ label: string; templates: DraftTemplate[] } | null>(null)
  let favorited = $state(false)
  // Bumped after a favorite is added so the chips row remounts and shows it.
  let favoritesVersion = $state(0)
  let navTimer: ReturnType<typeof setTimeout> | undefined
  let toastTimer: ReturnType<typeof setTimeout> | undefined

  onDestroy(() => {
    clearTimeout(navTimer)
    clearTimeout(toastTimer)
  })

  async function saveDrafts(drafts: Draft[], label: string, stay: boolean) {
    saving = true
    error = ''
    try {
      await logEvent(drafts)
      favorited = false
      toast = { label, templates: drafts.map(toTemplate) }
      if (stay) {
        onReset()
        clearTimeout(toastTimer)
        toastTimer = setTimeout(() => (toast = null), 2500)
      } else {
        // Linger long enough to read the checkmark and reach "Favorite this".
        navTimer = setTimeout(() => navigate('#/'), 900)
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not save — try again.'
    } finally {
      saving = false
    }
  }

  function save(stay: boolean) {
    const drafts = buildDrafts(effectiveAt())
    if (!drafts) return
    void saveDrafts(drafts, favoriteLabel(), stay)
  }

  async function favoriteThis() {
    if (!toast) return
    clearTimeout(navTimer)
    await addFavorite({ label: toast.label, category, drafts: toast.templates })
    favorited = true
    favoritesVersion += 1
    navTimer = setTimeout(() => navigate('#/'), 700)
  }

  function instantLog(templates: DraftTemplate[], label: string) {
    void saveDrafts(fromTemplates(templates, toLocalIso(new Date())), label, false)
  }

  function cancel() {
    navigate('#/')
  }
</script>

<div class="head">
  <span class="dot" style:background={`var(--cat-${category})`}></span>
  <h1>{title}</h1>
</div>

{#key favoritesVersion}
  <Favorites {category} onPick={onPrefill} onInstant={instantLog} />
{/key}

<form
  class="stack"
  onsubmit={(e) => {
    e.preventDefault()
    save(false)
  }}
>
  {@render children()}

  <div class="when">
    {#if earlier}
      <input
        type="datetime-local"
        bind:value={earlierValue}
        max={nowLocalInput()}
        data-testid="effective-at"
      />
      <button type="button" onclick={() => (earlier = false)} data-testid="time-now">Now</button>
    {:else}
      <span class="muted">Time: now</span>
      <button type="button" onclick={openEarlier} data-testid="time-earlier">Earlier</button>
    {/if}
  </div>

  {#if error}
    <p class="error" data-testid="save-error">{error}</p>
  {/if}
</form>

<div class="action-bar">
  <div class="action-bar-inner">
    <button type="button" class="ghost" onclick={cancel} data-testid="log-cancel">Cancel</button>
    <button
      type="button"
      class="tonal"
      disabled={saving || !canSave}
      onclick={() => save(true)}
      data-testid="save-another"
    >
      Save & another
    </button>
    <button
      type="button"
      class="primary"
      disabled={saving || !canSave}
      onclick={() => save(false)}
      data-testid="save"
    >
      {saveLabel}
    </button>
  </div>
</div>

{#if toast}
  <div class="toast" role="status" data-testid="save-toast">
    <span>✓ Logged</span>
    {#if favorited}
      <span class="muted" data-testid="favorited">Favorited</span>
    {:else}
      <button type="button" onclick={favoriteThis} data-testid="favorite-this">
        Favorite this
      </button>
    {/if}
  </div>
{/if}

<style>
  .head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .head h1 {
    font-size: var(--text-xl);
  }

  .dot {
    flex: none;
    width: 9px;
    height: 9px;
    border-radius: 50%;
  }

  .when {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .when input {
    width: auto;
    flex: 1;
  }

  form.stack {
    padding-bottom: 96px;
  }

  .action-bar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    background: var(--surface);
    border-top: 1px solid var(--border);
  }

  .action-bar-inner {
    max-width: 40rem;
    margin: 0 auto;
    display: flex;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4) calc(var(--space-3) + env(safe-area-inset-bottom));
  }

  .action-bar-inner .primary {
    flex: 1;
  }

  .toast {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    bottom: calc(84px + env(safe-area-inset-bottom));
    display: flex;
    align-items: center;
    gap: var(--space-3);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-2) var(--space-4);
    box-shadow: var(--shadow-1);
  }
</style>
