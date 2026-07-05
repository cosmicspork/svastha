// The trust contract, compiled from `crates/core` to WASM (see `crates/wasm`).
// The browser runs the exact same envelope/event/identity code as the servers.
//
// The wasm module needs async instantiation; call `initSvastha()` once (it is
// idempotent) before using any export.
import init, {
  contract_version,
  verify_event,
  import_ccda,
  import_fhir,
  event_id,
  WasmIdentity,
  WasmDataKey,
} from '../wasm/svastha'

let ready: Promise<void> | null = null

/** Instantiate the wasm module. Safe to call repeatedly; only loads once. */
export function initSvastha(): Promise<void> {
  return (ready ??= init().then(() => undefined))
}

export { contract_version, verify_event, import_ccda, import_fhir, event_id, WasmIdentity, WasmDataKey }
