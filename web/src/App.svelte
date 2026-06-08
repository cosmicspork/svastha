<script lang="ts">
  import { onMount } from 'svelte'
  import {
    initSvastha,
    contract_version,
    verify_event,
    WasmIdentity,
    WasmDataKey,
  } from './lib/svastha'

  let version = $state<number | null>(null)

  let identity = $state<WasmIdentity | null>(null)
  let mnemonic = $state('')
  let x25519 = $state('')
  let ed25519 = $state('')

  let plaintext = $state('blood pressure 118/76')
  let sealedHex = $state('')
  let recovered = $state('')

  let signatureHex = $state('')
  let verified = $state<boolean | null>(null)

  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const toHex = (b: Uint8Array) =>
    Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

  onMount(async () => {
    await initSvastha()
    version = contract_version()
  })

  function generate() {
    const id = WasmIdentity.generate()
    identity = id
    mnemonic = id.mnemonic ?? ''
    x25519 = id.x25519_public_hex
    ed25519 = id.ed25519_public_hex
    signatureHex = ''
    verified = null
  }

  function sealRoundTrip() {
    const key = WasmDataKey.generate()
    const aad = enc.encode('demo')
    const sealed = key.seal(enc.encode(plaintext), aad)
    sealedHex = toHex(sealed)
    recovered = dec.decode(key.open(sealed, aad))
  }

  function signSample() {
    if (!identity) return
    // A sample blood-pressure observation; the content-addressed id is derived.
    const content = JSON.stringify({
      kind: 'observation',
      code: {
        system: 'http://loinc.org',
        code: '85354-9',
        display: 'Blood pressure panel',
      },
      effective_at: '2026-01-02T15:04:05Z',
      value: { quantity: { value: '118', unit: null } },
      provenance: { source: 'Self-reported', source_doc: null },
    })
    const signedJson = identity.sign_event(content)
    signatureHex = JSON.parse(signedJson).signature
    verified = verify_event(signedJson)
  }
</script>

<main>
  <h1>Svastha</h1>
  <p>Self-custodial, end-to-end-encrypted, local-first personal medical records.</p>
  <p class="muted">
    Trust contract v<span data-testid="version">{version ?? '…'}</span> — running in
    your browser over WASM.
  </p>

  <section>
    <h2>Identity</h2>
    <button data-testid="generate" onclick={generate}>Generate identity</button>
    {#if identity}
      <dl>
        <dt>Mnemonic (back this up)</dt>
        <dd data-testid="mnemonic">{mnemonic}</dd>
        <dt>X25519 public</dt>
        <dd class="hex" data-testid="x25519">{x25519}</dd>
        <dt>Ed25519 public</dt>
        <dd class="hex" data-testid="ed25519">{ed25519}</dd>
      </dl>
    {/if}
  </section>

  <section>
    <h2>Seal &amp; open</h2>
    <input data-testid="plaintext" bind:value={plaintext} aria-label="plaintext" />
    <button data-testid="seal" onclick={sealRoundTrip}>Seal &amp; open</button>
    {#if sealedHex}
      <dl>
        <dt>Sealed (ciphertext)</dt>
        <dd class="hex" data-testid="sealed">{sealedHex}</dd>
        <dt>Recovered</dt>
        <dd data-testid="recovered">{recovered}</dd>
      </dl>
    {/if}
  </section>

  <section>
    <h2>Sign an event</h2>
    <button data-testid="sign" onclick={signSample} disabled={!identity}>
      Sign sample observation
    </button>
    {#if signatureHex}
      <dl>
        <dt>Signature</dt>
        <dd class="hex" data-testid="signature">{signatureHex}</dd>
        <dt>Verified</dt>
        <dd data-testid="verified">{verified}</dd>
      </dl>
    {/if}
  </section>
</main>

<style>
  main {
    max-width: 44rem;
    margin: 3rem auto;
    padding: 0 1rem;
    font-family: system-ui, sans-serif;
    line-height: 1.5;
  }
  h1 {
    margin-bottom: 0.25rem;
  }
  h2 {
    font-size: 1.1rem;
    margin-bottom: 0.5rem;
  }
  section {
    margin-top: 2rem;
    border-top: 1px solid #8884;
    padding-top: 1rem;
  }
  .muted {
    color: #888;
    font-size: 0.9rem;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
    margin-top: 0.75rem;
  }
  dt {
    color: #888;
    font-size: 0.85rem;
  }
  dd {
    margin: 0;
  }
  .hex {
    font-family: ui-monospace, monospace;
    font-size: 0.8rem;
    word-break: break-all;
  }
  button {
    font: inherit;
    padding: 0.4rem 0.8rem;
    cursor: pointer;
  }
  input {
    font: inherit;
    padding: 0.3rem 0.5rem;
    margin-right: 0.5rem;
  }
</style>
