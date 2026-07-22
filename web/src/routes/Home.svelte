<script lang="ts">
  import { onMount } from 'svelte'
  import { get, put } from '../lib/db'
  import { navigate } from '../lib/router.svelte'
  import { fingerprint } from '../lib/exchange'
  import {
    listShares,
    acceptInvite,
    declineInvite,
    pendingInvites,
    type Share,
    type PendingInvite,
  } from '../lib/shared'
  import Spine from '../components/Spine.svelte'
  import ClinicianSummary from '../components/ClinicianSummary.svelte'
  import InstallSheet from '../components/InstallSheet.svelte'
  import { shouldNudgeInstall, dismissInstallNudge } from '../lib/install'

  let hue = $state<'a' | 'b'>('a')
  let shares = $state<Share[]>([])
  let showInstallSheet = $state(false)
  // Timeline (the chronological spine) vs. Summary (the clinician handoff
  // shape). Persisted as a shared UI preference so it carries across the own
  // record and shared-person screens (see Person.svelte).
  let view = $state<'timeline' | 'summary'>('timeline')

  onMount(async () => {
    const stored = await get<'a' | 'b'>('prefs', 'hue')
    if (stored) hue = stored
    const storedView = await get<'timeline' | 'summary'>('prefs', 'person-view')
    if (storedView) view = storedView
    shares = await listShares()
  })

  async function setView(next: 'timeline' | 'summary') {
    view = next
    await put('prefs', next, 'person-view')
  }

  // Separate from the above onMount so a slow shouldNudgeInstall() (an
  // IndexedDB read) never delays the hue/shares load it has nothing to do with.
  onMount(async () => {
    if (await shouldNudgeInstall()) showInstallSheet = true
  })

  async function dismissAndClose(): Promise<void> {
    await dismissInstallNudge()
    showInstallSheet = false
  }

  async function accept(invite: PendingInvite): Promise<void> {
    await acceptInvite(invite, hue === 'a' ? 'b' : 'a')
    shares = await listShares()
  }

  async function decline(invite: PendingInvite): Promise<void> {
    await declineInvite(invite)
  }
</script>

<h1>Svastha</h1>

{#each $pendingInvites as invite (invite.mailboxId)}
  <div class="invite" data-testid="home-invite-banner">
    <p>
      <strong>{invite.label || 'Someone'}</strong> shared their vault with you — accept?
    </p>
    <p class="data muted" data-testid="home-invite-fingerprint">{fingerprint(invite.fromEd)}</p>
    <div class="row">
      <button class="primary" onclick={() => accept(invite)} data-testid="home-invite-accept">
        Accept
      </button>
      <button onclick={() => decline(invite)} data-testid="home-invite-decline">Decline</button>
    </div>
  </div>
{/each}

<div class="switcher" data-testid="home-nav">
  {#if shares.length > 0}
    <button
      class="switch-chip"
      aria-pressed="true"
      onclick={() => navigate('#/')}
      data-testid="switch-mine"
    >
      My record
    </button>
    {#each shares as share (share.ownerEd)}
      <button
        class="switch-chip"
        onclick={() => navigate(`#/person/${share.ownerEd}`)}
        data-testid="switch-{share.ownerEd}"
      >
        {share.label}
      </button>
    {/each}
  {/if}
  <button class="switch-chip patterns" onclick={() => navigate('#/correlate')} data-testid="nav-correlate">
    Patterns
  </button>
  <button class="switch-chip" onclick={() => navigate('#/share')} data-testid="nav-share">
    <span aria-hidden="true">◉</span> Sharing
  </button>
</div>

<div class="seg view-toggle" role="group" aria-label="Record view" data-testid="home-view-toggle">
  <button aria-pressed={view === 'timeline'} onclick={() => setView('timeline')} data-testid="view-timeline">
    Timeline
  </button>
  <button aria-pressed={view === 'summary'} onclick={() => setView('summary')} data-testid="view-summary">
    Summary
  </button>
</div>

{#if view === 'timeline'}
  <Spine {hue} />
{:else}
  <ClinicianSummary />
{/if}

{#if showInstallSheet}
  <InstallSheet onclose={dismissAndClose} />
{/if}

<style>
  .invite {
    border: 1px solid var(--action);
    border-radius: var(--radius-sm);
    padding: var(--space-3);
    margin-bottom: var(--space-4);
  }

  .row {
    display: flex;
    gap: var(--space-2);
  }

  .switcher {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    margin-bottom: var(--space-4);
  }

  .view-toggle {
    margin-bottom: var(--space-4);
  }

  .switch-chip {
    min-width: 0;
    min-height: 36px;
    border-radius: 999px;
    font-size: var(--text-xs);
    padding: var(--space-1) var(--space-3);
  }

  .switch-chip[aria-pressed='true'] {
    border-color: var(--action);
    color: var(--action);
    background: var(--action-muted);
  }

  .switch-chip.patterns {
    margin-left: auto;
  }
</style>
