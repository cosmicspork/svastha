<script lang="ts">
  import { onMount } from 'svelte'
  import {
    validateEndpoint,
    normalizeEndpoint,
    loadConfig,
    saveInferenceConfig,
    forgetConfig,
    hasStoredApiKey,
    hasConsented,
    recordConsent,
    endpointOrigin,
    probeTarget,
    testConnection,
  } from '../../lib/inference'
  import {
    pageReadingEnabled,
    enableAssets,
    disableAssets,
  } from '../../lib/ocr-assets'
  import {
    OPT_IN_CATEGORIES,
    optInsFrom,
    loadAnswerScope,
    resolveNodeScopeState,
    type NodeScopeState,
    type AnswerScopeRecord,
  } from '../../lib/answerScope'
  import {
    loadAnswerWhere,
    saveAnswerWhere,
    type AnswerWhere,
  } from '../../lib/answerWhere'
  import {
    loadNodeEndpoint,
    resolveNodeEndpointState,
    parseJobStatus,
    type NodeEndpointRecord,
    type NodeEndpointState,
  } from '../../lib/nodeEndpoint'
  import { CATEGORY_META, type Category } from '../../lib/category'
  import {
    commitAnswerScope,
    retryAnswerScope,
    commitNodeEndpoint,
    sendAdminCommand,
  } from '../../lib/mailbox'
  import {
    adminLog,
    refreshAdminLog,
    enrolledNode,
    getNodeLastSeen,
    describeCommand,
    type AdminCommand,
  } from '../../lib/nodeadmin'
  import { formatDay, formatTime, dayKey } from '../../lib/time'
  import type { ProposerRecord } from '../../lib/proposals'
  import Sheet from '../../components/Sheet.svelte'
  import BulkReadSheet from '../../components/BulkReadSheet.svelte'
  import { unreadAttachmentPages, type BulkPage } from '../../lib/bulk-read'

  let endpoint = $state('')
  let model = $state('')
  let apiKey = $state('')
  let configured = $state(false)
  let keyStoredButUnreadable = $state(false)

  let showConsent = $state(false)

  let error = $state('')
  let status = $state('')
  let busy = $state(false)

  // Model ids a successful "Test connection" discovered. Empty until one runs,
  // and empty forever for an endpoint that does not expose /models — hence the
  // free-type fallback rather than a select that could trap someone with no
  // options in it.
  let modelOptions = $state<string[]>([])
  let typingModel = $state(false)
  const modelIsPicker = $derived(modelOptions.length > 0 && !typingModel)

  // Where questions are answered (answerWhere.ts). Page reading follows it too.
  let answerWhere = $state<AnswerWhere>('auto')

  // Page reading is enabled unless this device explicitly turns it off. Its
  // runtime stays lazy: this is only the preference, not a claim that assets
  // have been downloaded and verified.
  let ocrOn = $state(false)
  let ocrBusy = $state(false)
  let ocrError = $state('')
  let ocrProgress = $state(0)
  let ocrSizeMb = $state(0)
  let unreadPages = $state<BulkPage[]>([])
  let showBulkRead = $state(false)

  // Opt-in entries. Off unless the owner turns them on — see answerScope.ts.
  // What each category actually covers, said in the owner's words rather than
  // the taxonomy's, because "Mind" alone does not tell anyone that a gratitude
  // note is in scope.
  const OPT_IN_SUBCOPY: Partial<Record<Category, string>> = {
    cycle: 'Periods, flow, cycle symptoms',
    mind: 'Mood, mindfulness, gratitude',
  }
  let optIns = $state<Set<Category>>(new Set())
  let optInBusy = $state(false)
  let optInError = $state('')

  // Whether the NODE has agreed with the local choice — tracked separately
  // because it is a separate fact. A deposited command is not an applied one:
  // an offline node, a node too old to parse the command, and a node whose
  // state file will not write (`ok: false`) all leave the owner switched off
  // here and still disclosed there. Only its `admin_reply` promotes this to
  // `confirmed`; there is deliberately no "assume it worked" path.
  //
  // The node's *identity*, not merely whether one exists: a confirmation from a
  // node the owner has since replaced says nothing about the one enrolled now,
  // which has never been sent the scope.
  let nodeEd = $state<string | null>(null)
  let scopeRecord = $state<AnswerScopeRecord | undefined>(undefined)
  // Ticked so an outstanding command ages into `unconfirmed` without a reload.
  let nowMs = $state(Date.now())
  let nodeScope = $derived<NodeScopeState>(
    resolveNodeScopeState(scopeRecord, $adminLog, nodeEd, nowMs),
  )

  // --- processing node ---
  let node = $state<ProposerRecord | null>(null)
  let lastSeen = $state<string | null>(null)
  let nodeEndpoint = $state('')
  let nodeApiKey = $state('')
  let nodeBusy = $state(false)
  let nodeError = $state('')
  let endpointRecord = $state<NodeEndpointRecord | undefined>(undefined)
  let nodeEndpointState = $derived<NodeEndpointState>(
    resolveNodeEndpointState(endpointRecord, $adminLog, nodeEd, nowMs),
  )
  // The node's own account of itself, read from the most recent `job_status` it
  // answered. Unknown until it has answered one — shown as unknown rather than
  // as zero, because "0 pages waiting" is a claim and this device has none.
  const jobStatus = $derived(
    parseJobStatus(
      $adminLog.find((e) => e.command.cmd === 'job_status' && e.reply?.ok)?.reply?.detail,
    ),
  )

  // A command that was sent and has no reply yet. Deliberately independent of
  // `nowMs`, so the clock below does not retrigger its own effect.
  let awaitingReply = $derived(
    (!!scopeRecord?.pending.id &&
      !$adminLog.find((e) => e.id === scopeRecord?.pending.id)?.reply) ||
      (!!endpointRecord?.pending.id &&
        !$adminLog.find((e) => e.id === endpointRecord?.pending.id)?.reply),
  )
  $effect(() => {
    if (!awaitingReply) return
    const tick = setInterval(() => (nowMs = Date.now()), 5000)
    return () => clearInterval(tick)
  })

  onMount(async () => {
    // ONE read of the scope record, with both the switches and the confirmation
    // banner derived from it. Reading it twice is two transactions, and a commit
    // landing between them would leave the switches showing one set while the
    // banner reasons about another.
    const record = await loadAnswerScope()
    scopeRecord = record
    optIns = optInsFrom(record)
    answerWhere = await loadAnswerWhere()
    node = await enrolledNode()
    nodeEd = node?.ed ?? null
    lastSeen = (await getNodeLastSeen()) ?? null
    endpointRecord = await loadNodeEndpoint()
    nodeEndpoint = endpointRecord?.endpoint ?? ''
    await refreshAdminLog()
    ocrOn = await pageReadingEnabled()
    const config = await loadConfig()
    if (config) {
      endpoint = config.endpoint
      model = config.model
      configured = true
      // A stored key that will not unseal reads as absent everywhere else; say so
      // here rather than silently sending requests with no credential.
      keyStoredButUnreadable = !config.apiKey && (await hasStoredApiKey())
    }
    unreadPages = await unreadAttachmentPages()
  })

  async function beginSave(e: SubmitEvent) {
    e.preventDefault()
    error = ''
    status = ''
    const problem = validateEndpoint(endpoint)
    if (problem) {
      error = problem
      return
    }
    // Consent is to this endpoint's origin, so editing to a different host asks
    // again — the sheet's promises are all about a specific recipient.
    if (!(await hasConsented(endpoint))) {
      showConsent = true
      return
    }
    await persist()
  }

  async function acceptConsent() {
    await recordConsent(endpoint)
    showConsent = false
    await persist()
  }

  async function persist() {
    busy = true
    try {
      // Key first: it is the only step that can fail on a locked vault, and a
      // configured endpoint with no credential is worse than no save at all.
      await saveInferenceConfig(endpoint, model, apiKey)
      apiKey = ''
      keyStoredButUnreadable = false
      endpoint = normalizeEndpoint(endpoint)
      configured = true
      status = 'Saved.'
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not save.'
    } finally {
      busy = false
    }
  }

  /**
   * Test what is in the form, with the headers the real call sends.
   *
   * Both halves used to be wrong in the same direction — it tested the *saved*
   * config, so an edited endpoint was never the one probed, and it sent a bare
   * GET, which a browser treats as a simple request and never preflights. An
   * endpoint could pass here and fail every question.
   */
  async function test() {
    error = ''
    status = ''
    busy = true
    try {
      const target = probeTarget({ endpoint, apiKey }, await loadConfig())
      const models = await testConnection(target.endpoint, target.apiKey)
      modelOptions = models
      if (models.length > 0) typingModel = false
      status = models.length
        ? `Reachable — ${models.length} model${models.length === 1 ? '' : 's'} available.`
        : 'Reachable.'
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not reach the endpoint.'
    } finally {
      busy = false
    }
  }

  async function pickAnswerWhere(where: AnswerWhere) {
    answerWhere = where
    await saveAnswerWhere(where)
  }

  async function toggleOcr() {
    ocrError = ''
    if (ocrOn) {
      await disableAssets()
      ocrOn = false
      return
    }
    ocrBusy = true
    ocrProgress = 0
    try {
      await enableAssets((done, total) => (ocrProgress = total > 0 ? done / total : 0))
      ocrOn = true
    } catch (err) {
      // Nothing is switched on unless every file verified.
      ocrError = err instanceof Error ? err.message : 'Could not prepare the reader.'
    } finally {
      ocrBusy = false
    }
  }

  async function closeBulkRead(): Promise<void> {
    showBulkRead = false
    unreadPages = await unreadAttachmentPages()
  }

  /**
   * Flip one category and commit it.
   *
   * The switch is **not** moved until the local write has landed. This device's
   * own answers read the persisted value on the next question, so rendering the
   * new position first would show a choice `ask.ts` does not honour — worst
   * while turning a category *off*, where the switch would read "excluded" and
   * the entries would keep going out. On a failed write the switch stays where
   * it was, which is the truth.
   */
  async function toggleOptIn(category: Category) {
    optInError = ''
    optInBusy = true
    const next = new Set(optIns)
    if (next.has(category)) next.delete(category)
    else next.add(category)
    let commit: Awaited<ReturnType<typeof commitAnswerScope>>
    try {
      commit = await commitAnswerScope(next)
    } catch {
      // Nothing written, nothing sent — leave the switch where it was.
      optInError = "That couldn't be saved on this device, so nothing changed. Try again."
      optInBusy = false
      return
    }
    // Installed from what the commit persisted, not from `next` and not from a
    // re-read: the record IS the truth, and a second read is a second thing that
    // can fail. (They differ only if another tab committed underneath us, in
    // which case the owner's latest choice is the one to show.)
    optIns = optInsFrom(commit.record)
    scopeRecord = commit.record
    nowMs = Date.now()
    // Past the commit. A failure refreshing the log is not a commit failure and
    // must not be reported as one — the choice is already in force.
    try {
      if (commit.node !== 'no-node') await refreshAdminLog()
    } catch {
      // The reply, if any, will be folded in by the next pull.
    }
    optInBusy = false
  }

  /** Re-send the same desired set. A retry, not a reversal — the copy this
   * replaced told the owner to "toggle again", which would have sent the
   * opposite set and left the node further from what they wanted. */
  async function retryScope() {
    optInError = ''
    optInBusy = true
    let retry: Awaited<ReturnType<typeof retryAnswerScope>>
    try {
      retry = await retryAnswerScope()
    } catch {
      optInError = "That couldn't be saved on this device, so nothing was sent. Try again."
      optInBusy = false
      return
    }
    optIns = optInsFrom(retry.record)
    scopeRecord = retry.record
    // From the record the retry just wrote, not a fresh lookup: the retry
    // already resolved the node and stamped it, and a second read is a second
    // answer that can differ from the one the command was actually sent to.
    if (retry.record.pending.nodeEd) nodeEd = retry.record.pending.nodeEd
    nowMs = Date.now()
    try {
      await refreshAdminLog()
    } catch {
      // As above: the send already happened.
    }
    optInBusy = false
  }

  async function disconnect() {
    await forgetConfig()
    endpoint = ''
    model = ''
    apiKey = ''
    modelOptions = []
    configured = false
    keyStoredButUnreadable = false
    status = ''
    error = ''
  }

  // --- processing node ---

  async function sendToNode(command: AdminCommand): Promise<void> {
    if (!node) return
    nodeBusy = true
    nodeError = ''
    try {
      await sendAdminCommand({ ed: node.ed, x25519: node.x25519 }, command)
      await refreshAdminLog()
      nowMs = Date.now()
    } catch {
      nodeError = "That couldn't be sent. Try again."
    } finally {
      nodeBusy = false
    }
  }

  /** Set the endpoint the node runs THIS owner's work against. The key is sent
   * and not stored here — see `commitNodeEndpoint`. */
  async function setNodeEndpoint(): Promise<void> {
    const value = nodeEndpoint.trim()
    if (!value) return
    nodeBusy = true
    nodeError = ''
    let commit: Awaited<ReturnType<typeof commitNodeEndpoint>>
    try {
      commit = await commitNodeEndpoint(value, nodeApiKey)
    } catch {
      nodeError = "That couldn't be saved on this device, so nothing was sent. Try again."
      nodeBusy = false
      return
    }
    endpointRecord = commit.record
    nodeEndpoint = commit.record.endpoint
    nodeApiKey = ''
    nowMs = Date.now()
    try {
      if (commit.node !== 'no-node') await refreshAdminLog()
    } catch {
      // The reply, if any, is folded in by the next pull.
    }
    nodeBusy = false
  }

  function seenLabel(iso: string): string {
    return `${formatDay(dayKey(iso))}, ${formatTime(iso)}`
  }
</script>

<h1>AI</h1>

<section class="stack">
  <h2>This device</h2>
  <p class="muted intro">
    Point this device at an OpenAI-compatible endpoint and it can read your documents and answer
    questions about your record without a processing node. Whatever you point it at sees the parts of
    your record it is asked about, so choose it the way you would choose a person to hand a file to.
  </p>

  <form class="stack" onsubmit={beginSave}>
    <label>
      Endpoint
      <input
        type="url"
        bind:value={endpoint}
        placeholder="https://your-endpoint/v1"
        data-testid="inference-endpoint"
      />
    </label>
    <label>
      Model
      {#if modelIsPicker}
        <select bind:value={model} data-testid="inference-model-select">
          {#if model && !modelOptions.includes(model)}
            <option value={model}>{model}</option>
          {/if}
          {#each modelOptions as id (id)}
            <option value={id}>{id}</option>
          {/each}
        </select>
      {:else}
        <input bind:value={model} placeholder="a text model id" data-testid="inference-model" />
      {/if}
    </label>
    {#if modelOptions.length > 0}
      <!-- Always an escape hatch: an endpoint can list models it will not serve,
           and a picker with the wrong ids in it must not be the only way to type
           one. -->
      <button
        type="button"
        class="linkish"
        onclick={() => (typingModel = !typingModel)}
        data-testid="inference-model-mode"
      >
        {modelIsPicker ? 'Type a model id instead' : 'Choose from the list'}
      </button>
    {/if}
    <label>
      API key <span class="muted">(if the endpoint needs one)</span>
      <input
        type="password"
        bind:value={apiKey}
        placeholder={configured ? 'unchanged' : ''}
        autocomplete="off"
        data-testid="inference-api-key"
      />
    </label>

    {#if keyStoredButUnreadable}
      <p class="error" data-testid="inference-key-unreadable">
        There's an API key saved here that this device can no longer unseal. Enter it again to
        replace it.
      </p>
    {/if}
    {#if error}
      <p class="error" data-testid="inference-error">{error}</p>
    {/if}
    {#if status}
      <p class="ok" data-testid="inference-status">{status}</p>
    {/if}

    <div class="swatches">
      <button type="submit" class="primary" disabled={busy} data-testid="inference-save">Save</button>
      <button
        type="button"
        onclick={test}
        disabled={busy || endpoint.trim() === ''}
        data-testid="inference-test"
      >
        Test connection
      </button>
      {#if configured}
        <button type="button" onclick={disconnect} disabled={busy} data-testid="inference-forget">
          Forget
        </button>
      {/if}
    </div>
  </form>

  <p class="muted note">
    The endpoint must use <strong>https</strong>. A browser blocks plain http from this app, so a
    model running on your own machine needs a certificate — a tunnel or reverse proxy in front of it
    is enough. The API key is stored sealed on this device, and it is unavailable while the vault is
    locked.
  </p>
</section>

<section class="stack">
  <h2>Answers</h2>
  <div class="setrow">
    <span class="l">Answers<small>Where questions are answered</small></span>
    <div class="seg" style:width="14rem">
      <button
        aria-pressed={answerWhere === 'auto'}
        onclick={() => pickAnswerWhere('auto')}
        data-testid="answer-where-auto"
      >
        Auto
      </button>
      <button
        aria-pressed={answerWhere === 'device'}
        onclick={() => pickAnswerWhere('device')}
        data-testid="answer-where-device"
      >
        Device
      </button>
      <button
        aria-pressed={answerWhere === 'node'}
        onclick={() => pickAnswerWhere('node')}
        data-testid="answer-where-node"
      >
        Node
      </button>
    </div>
  </div>
  <p class="muted note">
    Auto answers here when an endpoint is set and asks your node otherwise. Reading pages follows the
    same choice.
  </p>
</section>

<section class="stack">
  <h2>Opt-in entries</h2>
  <p class="muted intro">
    Cycle and Mind entries stay out of AI answers unless you turn them on here — the same rule
    doctor shares follow. This choice covers answers from this device and from your node.
  </p>

  <div class="optin" role="group" aria-label="Opt-in entries">
    {#each OPT_IN_CATEGORIES as cat (cat)}
      <button
        type="button"
        role="switch"
        class="optin-row {CATEGORY_META[cat].hueClass}"
        aria-checked={optIns.has(cat)}
        disabled={optInBusy}
        onclick={() => toggleOptIn(cat)}
        data-testid="answer-optin-{cat}"
      >
        <span class="optin-text">
          <span class="optin-name">
            <span class="glyph" aria-hidden="true">{CATEGORY_META[cat].glyph}</span>
            {CATEGORY_META[cat].label}
          </span>
          <span class="optin-sub muted">{OPT_IN_SUBCOPY[cat] ?? ''}</span>
        </span>
        <span class="switch" aria-hidden="true"><span class="knob"></span></span>
      </button>
    {/each}
  </div>

  {#if optInError}
    <p class="error" data-testid="answer-optin-error">{optInError}</p>
  {/if}

  <!-- What the NODE is doing with this choice. Its own line, because a switch
       that governs two machines cannot report on one of them and imply the
       other. Only `confirmed` claims the node agrees. -->
  {#if nodeScope.state === 'pending'}
    <p class="muted" data-testid="answer-optin-node-pending">Telling your node…</p>
  {:else if nodeScope.state === 'confirmed'}
    <p class="ok" data-testid="answer-optin-node-confirmed">Your node has applied this.</p>
  {:else if nodeScope.state === 'refused'}
    <p class="error" data-testid="answer-optin-node-refused">
      Your node refused this and kept its previous setting{nodeScope.detail
        ? `: ${nodeScope.detail}`
        : '.'}
    </p>
    <button type="button" onclick={retryScope} disabled={optInBusy} data-testid="answer-optin-retry">
      Send again
    </button>
  {:else if nodeScope.state === 'superseded'}
    <p class="error" data-testid="answer-optin-node-superseded">
      Your node is using a different setting — {nodeScope.applied.length > 0
        ? `it is reading ${nodeScope.applied.map((c) => CATEGORY_META[c].label).join(' and ')}`
        : 'it is reading neither of these'}, because another of your devices set it more recently.
      Send again to make this device's choice the one in force.
    </p>
    <button type="button" onclick={retryScope} disabled={optInBusy} data-testid="answer-optin-retry">
      Send again
    </button>
  {:else if nodeScope.state === 'node-changed'}
    <p class="error" data-testid="answer-optin-node-changed">
      Your node has changed since you last set this, so the node you're using now has never been
      told. What it reads is unknown until you send this again.
    </p>
    <button type="button" onclick={retryScope} disabled={optInBusy} data-testid="answer-optin-retry">
      Send again
    </button>
  {:else if nodeScope.state === 'unconfirmed' || nodeScope.state === 'unsent'}
    <p class="error" data-testid="answer-optin-node-unconfirmed">
      {#if nodeScope.state === 'unsent'}
        This is saved on this device, but your node hasn't been told yet.
      {:else}
        This is saved on this device, but your node hasn't confirmed it — it may be offline, or
        running a version that doesn't know about opt-in entries.
      {/if}
      Until it confirms, assume it is still using your previous setting.
    </p>
    <button type="button" onclick={retryScope} disabled={optInBusy} data-testid="answer-optin-retry">
      Send again
    </button>
  {/if}

  <p class="muted note">
    While off, a question that only these entries could answer gets an honest “your record doesn't
    say” — not a quiet guess without them.
  </p>
</section>

<section class="stack">
  <h2>Reading pages on this device</h2>
  <p class="muted intro">
    Reads text out of a photographed or scanned page here, so the image itself never leaves this
    device — only the text it contains is sent for coding. Digital PDFs are read exactly and need
    none of this; the reader is for pages that are pictures.
  </p>
  <p class="muted intro">
    It does not read handwriting. A handwritten page comes back as "couldn't read this" rather than
    a guess, which is the honest answer for a medical record.
  </p>

  <div class="swatches">
    <button type="button" onclick={toggleOcr} disabled={ocrBusy} data-testid="ocr-toggle">
      {ocrOn ? 'Turn off' : 'Turn on'}
    </button>
  </div>
  {#if ocrBusy}
    <p class="muted" data-testid="ocr-progress">
      Preparing the reader… {Math.round(ocrProgress * 100)}%
    </p>
  {/if}
  {#if ocrError}
    <p class="error" data-testid="ocr-error">{ocrError}</p>
  {/if}
  <p class="muted note">
    Reading pages is on by default. The first photographed or scanned page needs an approximately
    10 MB download, checked against the checksums this app shipped with before it can run. Turn it
    off here to avoid that download on a metered connection.
  </p>
  {#if unreadPages.length > 0}
    <div class="bulk-read-card" data-testid="bulk-read-card">
      <h3>Read your unread pages</h3>
      <p class="muted" data-testid="bulk-read-count">
        {unreadPages.length === 1 ? "1 page hasn't been read yet." : `${unreadPages.length} pages haven't been read yet.`}
      </p>
      <button type="button" class="tonal" onclick={() => (showBulkRead = true)} data-testid="bulk-read-start">
        Read pages
      </button>
    </div>
  {/if}
</section>

<section class="stack" data-testid="node-admin">
  <h2>Processing node</h2>
  {#if !node}
    <p class="muted intro" data-testid="node-none">
      No processing node is enrolled. One is still the way to process a large backlog, or to read
      handwriting — enrol one from People.
    </p>
  {:else}
    <p class="last-seen muted" data-testid="node-last-seen">
      {node.label || 'Home Node'} ·
      {#if lastSeen}
        last heard from {seenLabel(lastSeen)}
      {:else}
        not heard from yet
      {/if}
    </p>

    <div class="cmd-row">
      <label class="endpoint-field">
        <span class="field-label">Inference endpoint</span>
        <input
          type="url"
          bind:value={nodeEndpoint}
          placeholder="https://…/v1"
          data-testid="admin-endpoint-input"
        />
      </label>
      <button
        type="button"
        class="tonal"
        disabled={nodeBusy || nodeEndpoint.trim() === ''}
        onclick={setNodeEndpoint}
        data-testid="admin-set-endpoint"
      >
        Set
      </button>
    </div>
    <label class="endpoint-field key-field">
      <span class="field-label">API key <span class="muted">(if the endpoint needs one)</span></span>
      <input
        type="password"
        bind:value={nodeApiKey}
        autocomplete="off"
        data-testid="admin-endpoint-key"
      />
    </label>
    <p class="muted note">
      Your endpoint on this node — other people it serves set their own.
    </p>

    {#if nodeError}
      <p class="error" data-testid="admin-endpoint-error">{nodeError}</p>
    {/if}
    {#if nodeEndpointState.state === 'pending'}
      <p class="muted" data-testid="admin-endpoint-pending">Telling your node…</p>
    {:else if nodeEndpointState.state === 'confirmed'}
      <p class="ok" data-testid="admin-endpoint-confirmed">
        Your node is using this endpoint for your record.
      </p>
    {:else if nodeEndpointState.state === 'refused'}
      <p class="error" data-testid="admin-endpoint-refused">
        Your node refused this and kept its previous endpoint{nodeEndpointState.detail
          ? `: ${nodeEndpointState.detail}`
          : '.'}
      </p>
    {:else if nodeEndpointState.state === 'superseded'}
      <p class="error" data-testid="admin-endpoint-superseded">
        Your node is sending your record to {nodeEndpointState.applied || 'nowhere'}, because another
        of your devices set it more recently. Set it again to make this the one in force.
      </p>
    {:else if nodeEndpointState.state === 'node-changed'}
      <p class="error" data-testid="admin-endpoint-node-changed">
        Your node has changed since you set this, so the node you're using now has never been told.
        Where it sends your record is unknown until you set it again.
      </p>
    {:else if nodeEndpointState.state === 'unconfirmed' || nodeEndpointState.state === 'unsent'}
      <p class="error" data-testid="admin-endpoint-unconfirmed">
        {#if nodeEndpointState.state === 'unsent'}
          This is saved on this device, but your node hasn't been told yet.
        {:else}
          This is saved on this device, but your node hasn't confirmed it — it may be offline, or
          running a version that doesn't know about per-person endpoints.
        {/if}
        Until it confirms, assume it is still using its previous endpoint.
      </p>
    {/if}

    <dl class="node-status" data-testid="node-status">
      <dt>Reading</dt>
      <dd data-testid="node-status-reading">
        {jobStatus.reading === null ? '—' : jobStatus.reading ? 'reading' : 'paused'}
      </dd>
      <dt>Waiting</dt>
      <dd data-testid="node-status-queued">
        {jobStatus.queued === null ? '—' : `${jobStatus.queued} pages`}
      </dd>
      <dt>Each pass</dt>
      <dd data-testid="node-status-cap">
        {jobStatus.maxPerPass === null ? '—' : `up to ${jobStatus.maxPerPass}`}
      </dd>
    </dl>

    <div class="cmd-actions">
      {#if jobStatus.reading}
        <button
          type="button"
          class="tonal"
          disabled={nodeBusy}
          onclick={() => sendToNode({ cmd: 'pause_ocr' })}
          data-testid="admin-pause-ocr"
        >
          Pause reading
        </button>
      {:else}
        <button
          type="button"
          class="tonal"
          disabled={nodeBusy}
          onclick={() => sendToNode({ cmd: 'resume_ocr' })}
          data-testid="admin-resume-ocr"
        >
          Resume reading
        </button>
      {/if}
      <button
        type="button"
        class="tonal"
        disabled={nodeBusy}
        onclick={() => sendToNode({ cmd: 'job_status' })}
        data-testid="admin-job-status"
      >
        Job status
      </button>
      <button
        type="button"
        class="tonal"
        disabled={nodeBusy}
        onclick={() => sendToNode({ cmd: 'log_tail' })}
        data-testid="admin-log-tail"
      >
        Log tail
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
                {entry.reply.ok ? 'OK' : 'Failed'}{entry.reply.detail
                  ? ` — ${entry.reply.detail}`
                  : ''}
              </span>
            {:else}
              <span class="log-reply pending muted" data-testid="admin-pending">
                Waiting for the node…
              </span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

{#if showConsent}
  <Sheet onclose={() => (showConsent = false)}>
    <div data-testid="inference-consent">
      <h2>Before you connect</h2>
      <ul class="consent-points">
        <li>
          <strong>{endpointOrigin(endpoint) || endpoint}</strong> will receive the parts of your
          record it is asked about, decrypted.
        </li>
        <li>
          The API key is stored on this device and cannot be limited to this app. Use a key issued
          for this purpose, and revoke it if you lose the device.
        </li>
        <li>The relay never sees any of this — it goes straight from this device to the endpoint.</li>
      </ul>
      <div class="swatches">
        <button class="primary" onclick={acceptConsent} data-testid="inference-consent-accept">
          I understand
        </button>
        <button onclick={() => (showConsent = false)} data-testid="inference-consent-cancel">
          Cancel
        </button>
      </div>
    </div>
  </Sheet>
{/if}

{#if showBulkRead}
  <BulkReadSheet pages={unreadPages} onclose={closeBulkRead} />
{/if}

<style>
  section {
    margin-top: var(--space-6);
  }

  .intro {
    font-size: var(--text-sm);
    margin: 0 0 var(--space-3);
  }

  .bulk-read-card {
    margin-top: var(--space-4);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .bulk-read-card h3 {
    margin: 0 0 var(--space-1);
  }

  .note {
    font-size: var(--text-xs);
    margin-top: var(--space-3);
  }

  label {
    display: block;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  label input,
  label select {
    width: 100%;
  }

  .linkish {
    align-self: flex-start;
    padding: 0;
    border: none;
    background: none;
    color: var(--action);
    font-size: var(--text-xs);
    min-height: 0;
  }

  .swatches {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }

  .ok {
    color: var(--action);
    font-size: var(--text-sm);
  }

  .setrow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
  }

  .setrow .l {
    font-size: var(--text-sm);
  }

  .setrow .l small {
    display: block;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  /* The opt-in group, matching the doctor-share sheet's: a bordered surface box
     that separates "off unless you say so" from the ordinary settings around it,
     so the two places the owner meets this choice look like one rule. */
  .optin {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    padding: var(--space-2) var(--space-3);
  }

  .optin-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-2) 0;
    background: none;
    border: none;
    text-align: left;
    color: var(--text);
  }

  .optin-row + .optin-row {
    border-top: 1px solid var(--border);
  }

  .optin-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .optin-name {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-sm);
  }

  .optin-name .glyph {
    /* The hue class colors just the glyph, as the category chips do. */
    color: currentColor;
  }

  .optin-sub {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .switch {
    flex: none;
    position: relative;
    width: 40px;
    height: 24px;
    border-radius: var(--radius-full);
    background: var(--border);
    transition: background 0.15s ease;
  }

  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--surface);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
    transition: transform 0.15s ease;
  }

  .optin-row[aria-checked='true'] .switch {
    background: var(--action);
  }

  .optin-row[aria-checked='true'] .knob {
    transform: translateX(16px);
  }

  .consent-points {
    margin: 0 0 var(--space-4);
    padding-left: var(--space-4);
    font-size: var(--text-sm);
  }

  .consent-points li + li {
    margin-top: var(--space-2);
  }

  /* --- processing node --- */

  .last-seen {
    font-size: var(--text-sm);
    margin: 0 0 var(--space-3);
  }

  .cmd-row {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
  }

  .endpoint-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    flex: 1;
    min-width: 0;
  }

  .key-field {
    margin-top: var(--space-2);
  }

  .field-label {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .endpoint-field input {
    width: 100%;
  }

  .node-status {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--space-1) var(--space-3);
    margin: var(--space-4) 0;
    font-size: var(--text-sm);
  }

  .node-status dt {
    color: var(--muted);
  }

  .node-status dd {
    margin: 0;
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
