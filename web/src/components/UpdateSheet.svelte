<script lang="ts">
  import Sheet from './Sheet.svelte'
  import { relaunchForUpdate } from '../lib/pwaUpdate'

  interface ChangelogSection {
    heading: string
    items: string[]
  }

  interface ChangelogRelease {
    version: string
    date: string
    sections: ChangelogSection[]
  }

  // The version of the bundle currently running (from the app-update
  // notification's data.version — same value as __APP_VERSION__, passed
  // explicitly so this component doesn't need the global). "Newer" is
  // computed against this, not the notification's own (also-old) version.
  let { runningVersion, onclose }: { runningVersion: string; onclose: () => void } = $props()

  let releases = $state<ChangelogRelease[] | null>(null)
  let loadFailed = $state(false)
  let relaunching = $state(false)

  function isNewer(version: string, than: string): boolean {
    const a = version.split('.').map(Number)
    const b = than.split('.').map(Number)
    for (let i = 0; i < 3; i++) {
      const diff = (a[i] ?? 0) - (b[i] ?? 0)
      if (diff !== 0) return diff > 0
    }
    return false
  }

  // Fetched fresh (cache: 'no-store'), never from the service worker's
  // precache (see vite.config.ts's globIgnores) — this is the only way the
  // still-running old bundle learns what the newly deployed one contains.
  async function load(): Promise<void> {
    try {
      const res = await fetch('/changelog.json', { cache: 'no-store' })
      if (!res.ok) throw new Error(`changelog.json: HTTP ${res.status}`)
      const all = (await res.json()) as ChangelogRelease[]
      releases = all.filter((r) => isNewer(r.version, runningVersion))
    } catch (err) {
      console.warn('release notes fetch failed:', err)
      loadFailed = true
    }
  }
  void load()

  const headlineVersion = $derived(releases?.[0]?.version)

  async function relaunch(): Promise<void> {
    relaunching = true
    await relaunchForUpdate()
  }
</script>

<Sheet {onclose}>
  <h2>{headlineVersion ? `What's new in ${headlineVersion}` : "What's new"}</h2>

  {#if loadFailed}
    <p class="muted" data-testid="update-notes-unavailable">Release notes unavailable offline.</p>
  {:else if releases === null}
    <p class="muted">Loading…</p>
  {:else if releases.length === 0}
    <p class="muted">You're already up to date.</p>
  {:else}
    <div class="stack" data-testid="update-notes">
      {#each releases as release (release.version)}
        <section>
          <h3>{release.version} <span class="muted">— {release.date}</span></h3>
          {#each release.sections as section (section.heading)}
            <h4>{section.heading}</h4>
            <ul>
              {#each section.items as item}
                <li>{item}</li>
              {/each}
            </ul>
          {/each}
        </section>
      {/each}
    </div>
  {/if}

  <div class="row">
    <button
      type="button"
      class="ghost"
      style:flex="1"
      onclick={onclose}
      data-testid="update-sheet-later"
    >
      Later
    </button>
    <button
      type="button"
      class="primary"
      disabled={relaunching}
      onclick={relaunch}
      data-testid="update-sheet-relaunch"
    >
      {relaunching ? 'Relaunching…' : 'Relaunch now'}
    </button>
  </div>
</Sheet>

<style>
  h3 {
    font-size: var(--text-base);
    font-weight: 600;
    margin: 0 0 var(--space-1);
  }

  h4 {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--muted);
    margin: var(--space-2) 0 var(--space-1);
  }

  ul {
    margin: 0 0 var(--space-3);
    padding-left: var(--space-4);
  }

  li {
    font-size: var(--text-sm);
    padding: var(--space-1) 0;
  }

  .row {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-4);
  }
</style>
