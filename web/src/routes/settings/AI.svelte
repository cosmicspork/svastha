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

  onMount(async () => {
    consented = await hasConsented()
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
