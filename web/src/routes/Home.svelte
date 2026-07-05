<script lang="ts">
  import { onMount } from 'svelte'
  import { get } from '../lib/db'
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

  let hue = $state<'a' | 'b'>('a')
  let shares = $state<Share[]>([])

  onMount(async () => {
    const stored = await get<'a' | 'b'>('prefs', 'hue')
    if (stored) hue = stored
    shares = await listShares()
  })

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

{#if shares.length > 0}
  <div class="switcher" data-testid="person-switcher">
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
  </div>
{/if}

<Spine {hue} />

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
</style>
