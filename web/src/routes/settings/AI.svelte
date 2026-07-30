<script lang="ts">
  import { onMount } from 'svelte'
  import {
    validateEndpoint,
    normalizeEndpoint,
    loadConfig,
    saveConfig,
    forgetConfig,
    saveApiKey,
    hasStoredApiKey,
    hasConsented,
    recordConsent,
    testConnection,
  } from '../../lib/inference'
  import {
    assetsEnabled,
    enableAssets,
    disableAssets,
    loadManifest,
    downloadBytes,
  } from '../../lib/ocr-assets'
  import {
    OPT_IN_CATEGORIES,
    loadOptIns,
    loadAnswerScope,
    resolveNodeScopeState,
    type NodeScopeState,
    type AnswerScopeRecord,
  } from '../../lib/answerScope'
  import { CATEGORY_META, type Category } from '../../lib/category'
  import { commitAnswerScope, retryAnswerScope } from '../../lib/mailbox'
  import { adminLog, refreshAdminLog, enrolledNode } from '../../lib/nodeadmin'

  let endpoint = $state('')
  let model = $state('')
  let apiKey = $state('')
  let configured = $state(false)
  let keyStoredButUnreadable = $state(false)

  let consented = $state(false)
  let showConsent = $state(false)

  let error = $state('')
  let status = $state('')
  let busy = $state(false)

  // On-device page reading. Off by default and staying that way until its
  // accuracy has been measured against the tabular fixtures — a lab panel read
  // wrong is a wrong number against the right analyte.
  let ocrOn = $state(false)
  let ocrBusy = $state(false)
  let ocrError = $state('')
  let ocrProgress = $state(0)
  let ocrSizeMb = $state(0)

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

  // A command that was sent and has no reply yet. Deliberately independent of
  // `nowMs`, so the clock below does not retrigger its own effect.
  let awaitingReply = $derived(
    !!scopeRecord?.pending.id && !$adminLog.find((e) => e.id === scopeRecord?.pending.id)?.reply,
  )
  $effect(() => {
    if (!awaitingReply) return
    const tick = setInterval(() => (nowMs = Date.now()), 5000)
    return () => clearInterval(tick)
  })

  onMount(async () => {
    consented = await hasConsented()
    optIns = await loadOptIns()
    scopeRecord = await loadAnswerScope()
    nodeEd = (await enrolledNode())?.ed ?? null
    await refreshAdminLog()
    ocrOn = await assetsEnabled()
    void loadManifest()
      .then((m) => (ocrSizeMb = downloadBytes(m) / 1024 / 1024))
      .catch(() => {})
    const config = await loadConfig()
    if (!config) return
    endpoint = config.endpoint
    model = config.model
    configured = true
    // A stored key that will not unseal reads as absent everywhere else; say so
    // here rather than silently sending requests with no credential.
    keyStoredButUnreadable = !config.apiKey && (await hasStoredApiKey())
  })

  function beginSave(e: SubmitEvent) {
    e.preventDefault()
    error = ''
    status = ''
    const problem = validateEndpoint(endpoint)
    if (problem) {
      error = problem
      return
    }
    if (!consented) {
      showConsent = true
      return
    }
    void persist()
  }

  async function acceptConsent() {
    await recordConsent()
    consented = true
    showConsent = false
    await persist()
  }

  async function persist() {
    busy = true
    try {
      await saveConfig(endpoint, model)
      if (apiKey.trim()) {
        await saveApiKey(apiKey)
        apiKey = ''
        keyStoredButUnreadable = false
      }
      endpoint = normalizeEndpoint(endpoint)
      configured = true
      status = 'Saved.'
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not save.'
    } finally {
      busy = false
    }
  }

  async function test() {
    error = ''
    status = ''
    busy = true
    try {
      const config = await loadConfig()
      const models = await testConnection(config?.endpoint ?? endpoint, config?.apiKey)
      status = models.length
        ? `Reachable — ${models.length} model${models.length === 1 ? '' : 's'} available.`
        : 'Reachable.'
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not reach the endpoint.'
    } finally {
      busy = false
    }
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
    optIns = new Set(commit.record.include)
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
    optIns = new Set(retry.record.include)
    scopeRecord = retry.record
    nodeEd = (await enrolledNode().catch(() => null))?.ed ?? nodeEd
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
    configured = false
    consented = false
    keyStoredButUnreadable = false
    status = ''
    error = ''
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
      <input bind:value={model} placeholder="a text model id" data-testid="inference-model" />
    </label>
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
      {#if configured}
        <button type="button" onclick={test} disabled={busy} data-testid="inference-test">
          Test connection
        </button>
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
      {ocrOn ? 'Turn off' : `Turn on${ocrSizeMb ? ` (${ocrSizeMb.toFixed(0)} MB)` : ''}`}
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
    A one-time download, checked against the checksums this app shipped with before it is switched
    on. Everything is served from this app — nothing is fetched from anyone else's servers.
  </p>
</section>

<section class="stack">
  <h2>Your node</h2>
  <p class="muted intro">
    A processing node has its own inference endpoint, set separately on the node's row under people
    you've shared with. That one is the node's; this one is this device's. A node is still the way to
    process a large backlog, or to read handwriting.
  </p>
</section>

{#if showConsent}
  <div class="consent" role="dialog" aria-modal="true" data-testid="inference-consent">
    <h2>Before you connect</h2>
    <ul>
      <li>This endpoint will receive the parts of your record it is asked about, decrypted.</li>
      <li>
        The API key is stored on this device and cannot be limited to this app. Use a key issued for
        this purpose, and revoke it if you lose the device.
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
{/if}

<style>
  section {
    margin-top: var(--space-6);
  }

  .intro {
    font-size: var(--text-sm);
    margin: 0 0 var(--space-3);
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

  label input {
    width: 100%;
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

  .consent {
    margin-top: var(--space-6);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
  }

  .consent ul {
    margin: 0 0 var(--space-4);
    padding-left: var(--space-4);
    font-size: var(--text-sm);
  }

  .consent li + li {
    margin-top: var(--space-2);
  }
</style>
