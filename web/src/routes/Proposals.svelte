<script lang="ts">
  import { onMount } from 'svelte'
  import { fingerprint } from '../lib/exchange'
  import { approveProposedEvent, type ApprovableContent } from '../lib/events'
  import {
    pendingProposals,
    refreshPendingProposals,
    setDraftStatus,
    groupByProposer,
    getProposer,
    type ProposalRecord,
    type ProposalDraft,
  } from '../lib/proposals'
  import { pullMailbox, resolveProposalIfDone } from '../lib/mailbox'
  import ProposalDraftRow from '../components/ProposalDraftRow.svelte'

  let busy = $state(false)
  // Proposer Ed25519 -> display label, resolved from the enrollment directory
  // (falls back to the fingerprint the invite flow also shows).
  let labels = $state<Record<string, string>>({})

  const groups = $derived([...groupByProposer($pendingProposals).entries()])

  onMount(async () => {
    // A fresh pull in case the deep-link arrived before the sync cycle ran; then
    // hydrate from IndexedDB regardless (proposals persist across reloads).
    await pullMailbox().catch(() => {})
    await refreshPendingProposals()
  })

  // Resolve a friendly label per proposer as the set changes.
  $effect(() => {
    for (const [fromEd] of groupByProposer($pendingProposals)) {
      if (labels[fromEd] !== undefined) continue
      labels[fromEd] = fingerprint(fromEd) // provisional until the directory answers
      void getProposer(fromEd).then((p) => {
        if (p?.label) labels = { ...labels, [fromEd]: p.label }
      })
    }
  })

  function proposedFor(record: ProposalRecord, draft: ProposalDraft) {
    return {
      by: record.fromEd,
      source_blob: draft.source_blob,
      method: draft.method,
      model: draft.model,
    }
  }

  async function approve(
    record: ProposalRecord,
    draft: ProposalDraft,
    content: ApprovableContent,
  ): Promise<void> {
    busy = true
    try {
      await approveProposedEvent(content, proposedFor(record, draft))
      await setDraftStatus(record.id, draft.event.id, 'approved')
      await resolveProposalIfDone(record.id)
    } finally {
      busy = false
    }
  }

  async function reject(record: ProposalRecord, draft: ProposalDraft): Promise<void> {
    busy = true
    try {
      await setDraftStatus(record.id, draft.event.id, 'rejected')
      await resolveProposalIfDone(record.id)
    } finally {
      busy = false
    }
  }

  /** Batch approval per proposer: sign every still-pending draft across all of
   * that proposer's messages as-is, then resolve each message (which echoes one
   * proposal_result per message). */
  async function approveAll(records: ProposalRecord[]): Promise<void> {
    busy = true
    try {
      for (const record of records) {
        for (const draft of record.drafts) {
          if (draft.status !== 'pending') continue
          await approveProposedEvent(
            {
              kind: draft.event.kind,
              code: draft.event.code,
              effective_at: draft.event.effective_at,
              value: draft.event.value,
              provenance: draft.event.provenance,
            },
            proposedFor(record, draft),
          )
          await setDraftStatus(record.id, draft.event.id, 'approved')
        }
        await resolveProposalIfDone(record.id)
      }
    } finally {
      busy = false
    }
  }

  function pendingCount(records: ProposalRecord[]): number {
    return records.reduce((n, r) => n + r.drafts.filter((d) => d.status === 'pending').length, 0)
  }
</script>

<h1>Proposals</h1>

{#if groups.length === 0}
  <p class="muted" data-testid="proposals-empty">
    No proposals waiting. When a device or caregiver you've granted access suggests entries drawn
    from your records, they'll appear here for you to review and sign.
  </p>
{:else}
  <p class="intro muted">
    Draft entries suggested by a device or person you've granted access. Nothing is added to your
    record until you approve it — approving signs the entry with your own key.
  </p>

  {#each groups as [fromEd, records] (fromEd)}
    <section class="proposer" data-testid="proposer-group">
      <header class="phead">
        <div class="who">
          <span class="plabel">{labels[fromEd] ?? fingerprint(fromEd)}</span>
          <span class="fp data muted" data-testid="proposer-fingerprint">{fingerprint(fromEd)}</span>
        </div>
        {#if pendingCount(records) > 1}
          <button
            class="approve-all"
            disabled={busy}
            onclick={() => approveAll(records)}
            data-testid="proposer-approve-all"
          >
            Approve all ({pendingCount(records)})
          </button>
        {/if}
      </header>

      {#each records as record (record.id)}
        {#each record.drafts as draft (draft.event.id)}
          <ProposalDraftRow
            {draft}
            {busy}
            onApprove={(content) => approve(record, draft, content)}
            onReject={() => reject(record, draft)}
          />
        {/each}
      {/each}
    </section>
  {/each}
{/if}

<style>
  .intro {
    font-size: var(--text-sm);
    margin: var(--space-2) 0 var(--space-5);
  }

  .proposer {
    margin-bottom: var(--space-6);
  }

  .phead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-1);
  }

  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .plabel {
    font-size: var(--text-base);
  }

  .fp {
    font-size: var(--text-xs);
  }

  .approve-all {
    flex: none;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--action);
    border-radius: var(--radius-sm);
    background: var(--action-muted);
    color: var(--action);
    font-size: var(--text-sm);
  }
</style>
