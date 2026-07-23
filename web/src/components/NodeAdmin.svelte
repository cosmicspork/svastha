<script lang="ts">
  import { onMount } from 'svelte'
  import { sendAdminCommand } from '../lib/mailbox'
  import {
    adminLog,
    refreshAdminLog,
    getNodeLastSeen,
    describeCommand,
    type AdminCommand,
  } from '../lib/nodeadmin'
  import { formatDay, formatTime, dayKey } from '../lib/time'
  import type { ProposerRecord } from '../lib/proposals'

  // Administers the node's work on THIS vault (design §1): the inference endpoint
  // it uses for your record, your job status, its log tail. Node-global
  // operations (restart, upgrade) are the host operator's and deliberately absent.
  let { node }: { node: ProposerRecord } = $props()

  let endpoint = $state('')
  let busy = $state(false)
  let lastSeen = $state<string | null>(null)

  onMount(async () => {
    await refreshAdminLog()
    lastSeen = (await getNodeLastSeen()) ?? null
  })

  async function send(command: AdminCommand): Promise<void> {
    busy = true
    try {
      await sendAdminCommand({ ed: node.ed, x25519: node.x25519 }, command)
    } finally {
      busy = false
    }
  }

  async function setEndpoint(): Promise<void> {
    const value = endpoint.trim()
    if (!value) return
    await send({ cmd: 'set_inference_endpoint', endpoint: value })
    endpoint = ''
  }

  function seenLabel(iso: string): string {
    return `${formatDay(dayKey(iso))}, ${formatTime(iso)}`
  }
</script>

<section class="node-admin" data-testid="node-admin">
  <h2>Node</h2>
  <p class="last-seen muted" data-testid="node-last-seen">
    {#if lastSeen}
      Last heard from: {seenLabel(lastSeen)}
    {:else}
      Not heard from yet.
    {/if}
  </p>

  <div class="cmd-row">
    <label class="endpoint-field">
      <span class="field-label">Inference endpoint</span>
      <input
        type="url"
        bind:value={endpoint}
        placeholder="https://…/v1"
        data-testid="admin-endpoint-input"
      />
    </label>
    <button
      type="button"
      class="tonal"
      disabled={busy || endpoint.trim() === ''}
      onclick={setEndpoint}
      data-testid="admin-set-endpoint"
    >
      Set
    </button>
  </div>

  <div class="cmd-actions">
    <button
      type="button"
      class="tonal"
      disabled={busy}
      onclick={() => send({ cmd: 'job_status' })}
      data-testid="admin-job-status"
    >
      Request job status
    </button>
    <button
      type="button"
      class="tonal"
      disabled={busy}
      onclick={() => send({ cmd: 'log_tail' })}
      data-testid="admin-log-tail"
    >
      Request log tail
    </button>
  </div>

  {#if $adminLog.length > 0}
    <ul class="admin-log" data-testid="admin-log">
      {#each $adminLog as entry (entry.id)}
        <li class="log-entry" data-testid="admin-log-entry">
          <span class="log-cmd">{describeCommand(entry.command)}</span>
          {#if entry.reply}
            <span
              class="log-reply"
              class:ok={entry.reply.ok}
              class:err={!entry.reply.ok}
              data-testid="admin-reply"
            >
              {entry.reply.ok ? 'OK' : 'Failed'}{entry.reply.detail ? ` — ${entry.reply.detail}` : ''}
            </span>
          {:else}
            <span class="log-reply pending muted" data-testid="admin-pending">Waiting for the node…</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .node-admin {
    margin-top: var(--space-6);
    padding-top: var(--space-5);
    border-top: 1px solid var(--border);
  }

  .last-seen {
    font-size: var(--text-sm);
    margin: 0 0 var(--space-3);
  }

  .cmd-row {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .endpoint-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    flex: 1;
    min-width: 0;
  }

  .field-label {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .endpoint-field input {
    width: 100%;
  }

  .cmd-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
  }

  .admin-log {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .log-entry {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    font-size: var(--text-sm);
  }

  .log-cmd {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .log-reply {
    margin-left: auto;
    font-size: var(--text-xs);
  }

  .log-reply.ok {
    color: var(--action);
  }

  .log-reply.err {
    color: var(--flare);
  }
</style>
