// This device's own inference endpoint: an OpenAI-compatible chat-completions
// service the owner points the app at, so OCR and cited Q&A can run without a
// processing node holding the vault key.
//
// Three things this module is deliberate about:
//
//   1. **The endpoint must be HTTPS.** A browser blocks `http://` from this
//      HTTPS page as active mixed content. Loopback is exempt but is not the
//      shape people run — a desktop model reached from a phone is a LAN
//      address, exactly the case the browser refuses — so a self-hosted
//      endpoint has to terminate TLS.
//   2. **Batch paths are rejected**, mirroring `validate_inference_endpoint` in
//      `crates/node/src/config.rs`: batch APIs retain inputs and outputs
//      server-side, so pointing at one leaks plaintext beyond the trust
//      boundary. Duplicated rather than shared because it is twenty lines and
//      the alternative is a wasm round-trip for a string check.
//   3. **The API key is sealed, not stored in `prefs`.** `prefs` is plaintext at
//      rest — see {@link saveApiKey} for what it is sealed under, and why not
//      the obvious key.
import { get, put, del } from './db'
import { session } from './session.svelte'
import { toHex, fromHex } from './hex'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** AAD for the sealed API-key record — binds the ciphertext to its purpose. */
const API_KEY_AAD = enc.encode('svastha/secrets/inference-api-key')
const API_KEY_NAME = 'inference-api-key'

/** Where the non-secret half lives. Same `prefs` pattern as `relayUrl`. */
const PREF_URL = 'inferenceUrl'
const PREF_MODEL = 'inferenceModel'
const PREF_CONSENT = 'inferenceConsentAt'

export interface InferenceConfig {
  endpoint: string
  model: string
  /** Absent when no key is configured, or when a stored one could not be
   * unsealed — see {@link loadApiKey}. */
  apiKey?: string
}

/**
 * Validate an endpoint for browser use. Mirrors the node's
 * `validate_inference_endpoint` and adds the constraint the node does not have:
 * a browser on an HTTPS page cannot reach an `http://` origin.
 */
export function validateEndpoint(raw: string): string | null {
  const endpoint = raw.trim()
  if (!endpoint) return 'Enter an endpoint URL.'

  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return 'That is not a valid URL.'
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'The endpoint must be an http(s) URL.'
  }

  // Loopback is the one http origin a secure page may call; everything else is
  // blocked before the request is even sent, so refuse it here with a reason
  // rather than letting it fail as a bare network error later.
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
    return 'The endpoint must use https. A browser blocks plain http from this app, so a model on your own machine needs a certificate (a tunnel or reverse proxy will do it).'
  }

  if (endpoint.toLowerCase().includes('/batch')) {
    return 'That looks like a Batch API path. Batch services keep your inputs and outputs on their servers, so this app needs a synchronous endpoint.'
  }

  return null
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

/** Trim a trailing slash so `${base}/models` never doubles up. */
export function normalizeEndpoint(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

/** Longest host a label can carry before it crowds the mode pill it sits in. */
const HOST_MAX = 28

/**
 * The host an endpoint reaches, for labelling where an answer came from.
 *
 * An over-long host loses *leading* labels rather than trailing ones. The tail
 * is what says whose machine this is — `…inference.example.com` is still
 * plainly not your LAN box, where a head-truncated `my-tailscale-node…` could
 * be anything.
 */
export function endpointHost(endpoint: string): string {
  const raw = endpoint.trim()
  if (!raw) return ''

  let host = raw
  try {
    // `host`, not `hostname`: a non-default port is part of which service this
    // is, and URL already drops :443 and :80 for us.
    host = new URL(raw).host
  } catch {
    // Not a URL at all — never true of a saved config, which is validated
    // before it is stored. Showing the raw string beats showing nothing.
  }

  const labels = host.split('.')
  while (labels.length > 1 && labels.join('.').length > HOST_MAX) labels.shift()
  const kept = labels.join('.')
  if (kept.length > HOST_MAX) return `…${kept.slice(kept.length - HOST_MAX)}`
  return kept.length < host.length ? `…${kept}` : kept
}

// --- config storage -------------------------------------------------------

export async function loadConfig(): Promise<InferenceConfig | null> {
  const [endpoint, model] = await Promise.all([
    get<string>('prefs', PREF_URL),
    get<string>('prefs', PREF_MODEL),
  ])
  if (!endpoint) return null
  return { endpoint, model: model ?? '', apiKey: (await loadApiKey()) ?? undefined }
}

export async function saveConfig(endpoint: string, model: string): Promise<void> {
  await Promise.all([
    put('prefs', normalizeEndpoint(endpoint), PREF_URL),
    put('prefs', model.trim(), PREF_MODEL),
  ])
}

export async function forgetConfig(): Promise<void> {
  await Promise.all([
    del('prefs', PREF_URL),
    del('prefs', PREF_MODEL),
    del('prefs', PREF_CONSENT),
    del('secrets', API_KEY_NAME),
  ])
}

// --- the API key ----------------------------------------------------------

/**
 * Seal the API key under the session's vault key.
 *
 * Not the session's `wrapKey`, which would look like the obvious choice: that is
 * the passphrase's `kdfOut` on a v1 vault and the master key on v2, and *both*
 * change out from under you — `changePassphrase` derives a fresh `kdfOut` and
 * `enrollPasskey` swaps the whole thing for MK, each resealing only the three
 * canonical records. A secret sealed under `wrapKey` would be silently orphaned
 * by either. The vault key survives both.
 */
export async function saveApiKey(apiKey: string): Promise<void> {
  const key = apiKey.trim()
  if (!key) {
    await del('secrets', API_KEY_NAME)
    return
  }
  if (!session.vaultKey) throw new Error('Unlock the vault before saving an API key.')
  const sealed = session.vaultKey.seal(enc.encode(key), API_KEY_AAD)
  await put('secrets', { sealed_hex: toHex(sealed) }, API_KEY_NAME)
}

/**
 * The stored API key, or `null` if there is none — **or if it will not unseal**.
 *
 * Failing soft is deliberate. The vault key is stable across a passphrase change
 * and passkey enrolment, but a device that adopts a relay-won vault key on first
 * connect can end up holding a different one than sealed this record. That is
 * recoverable by re-entering the key, and it is a far better outcome than a
 * thrown error on a settings screen. The caller shows "re-enter your API key".
 */
export async function loadApiKey(): Promise<string | null> {
  const record = await get<{ sealed_hex: string }>('secrets', API_KEY_NAME)
  if (!record || !session.vaultKey) return null
  try {
    return dec.decode(session.vaultKey.open(fromHex(record.sealed_hex), API_KEY_AAD))
  } catch {
    return null
  }
}

/** Whether a key is stored at all, regardless of whether it unseals. Lets the UI
 * tell "no key set" apart from "a key is here but this device cannot read it". */
export async function hasStoredApiKey(): Promise<boolean> {
  return (await get<unknown>('secrets', API_KEY_NAME)) !== undefined
}

// --- consent --------------------------------------------------------------

export async function hasConsented(): Promise<boolean> {
  return (await get<string>('prefs', PREF_CONSENT)) !== undefined
}

export async function recordConsent(): Promise<void> {
  await put('prefs', new Date().toISOString(), PREF_CONSENT)
}

// --- reachability ---------------------------------------------------------

export class InferenceError extends Error {}

/**
 * Probe the endpoint with `GET {base}/models` — the OpenAI-compatible discovery
 * call, cheap and side-effect free, so "Test connection" costs no inference.
 *
 * A CORS rejection reaches JS as an indistinguishable `TypeError`, so the failure
 * message names it as a possibility rather than blaming the network: the endpoint
 * has to send `Access-Control-Allow-Origin` for a browser to call it at all, and
 * that is the single most likely reason a correct URL still fails here.
 */
export async function testConnection(endpoint: string, apiKey?: string): Promise<string[]> {
  const base = normalizeEndpoint(endpoint)
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  let response: Response
  try {
    response = await fetch(`${base}/models`, { headers })
  } catch {
    throw new InferenceError(
      'Could not reach that endpoint from the browser. It may be offline, or it may not allow requests from web apps (CORS).',
    )
  }

  if (response.status === 401 || response.status === 403) {
    throw new InferenceError('The endpoint rejected the API key.')
  }
  if (!response.ok) {
    throw new InferenceError(`The endpoint answered ${response.status}.`)
  }

  return parseModelIds(await response.json().catch(() => null))
}

/** Model ids out of an OpenAI-compatible `/models` body, tolerant of shape. */
export function parseModelIds(body: unknown): string[] {
  if (!body || typeof body !== 'object') return []
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  return data
    .map((m) => (m && typeof m === 'object' ? (m as { id?: unknown }).id : null))
    .filter((id): id is string => typeof id === 'string')
}

// --- completions ----------------------------------------------------------

/**
 * How long one completion may run before the app gives up on it.
 *
 * A hung endpoint is otherwise indistinguishable from a slow one, and nothing
 * else ever resolves the wait: the caller's screen stays disabled for as long as
 * the socket stays open, which on a stalled LAN box is forever. Thirty seconds
 * is past the slow end of a real answer and well short of that.
 */
export const COMPLETION_TIMEOUT_MS = 30_000

/**
 * One synchronous chat completion. The single network call every AI feature on
 * this device makes, so the failure messages are written once and read the same
 * whether you were asking a question or reading a page.
 *
 * `temperature: 0` throughout: the same question over the same record, or the
 * same page read twice, should not wander.
 */
export async function chatComplete(
  config: InferenceConfig,
  system: string,
  user: string,
): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`

  const host = endpointHost(config.endpoint)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), COMPLETION_TIMEOUT_MS)
  // Names the host and the limit, because the two things worth knowing are
  // which machine went quiet and that the app — not the endpoint — decided to
  // stop waiting.
  const timedOut = () =>
    new InferenceError(
      `${host} didn't answer within 30 seconds, so the app stopped waiting. It may be overloaded, or the model may be too large for it.`,
    )

  try {
    let response: Response
    try {
      response = await fetch(`${normalizeEndpoint(config.endpoint)}/chat/completions`, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: config.model,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      })
    } catch {
      // An abort and a network/CORS failure arrive here identically; only the
      // signal can tell them apart.
      if (controller.signal.aborted) throw timedOut()
      throw new InferenceError(
        'Could not reach the inference endpoint. It may be offline, or it may not allow requests from web apps (CORS).',
      )
    }

    if (response.status === 401 || response.status === 403) {
      throw new InferenceError('The inference endpoint rejected the API key.')
    }
    if (!response.ok) {
      throw new InferenceError(`The inference endpoint answered ${response.status}.`)
    }

    // The deadline covers the body too: headers can arrive promptly and the
    // stream then stall, which is the same hang from the owner's side.
    const body = (await response.json().catch(() => null)) as {
      choices?: { message?: { content?: unknown } }[]
    } | null
    if (controller.signal.aborted) throw timedOut()
    const content = body?.choices?.[0]?.message?.content
    return typeof content === 'string' ? content : ''
  } finally {
    clearTimeout(timeout)
  }
}
