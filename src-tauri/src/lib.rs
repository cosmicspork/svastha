//! The Tauri shell around the Svastha web app.
//!
//! The WebView runs the same Svelte bundle and the same `core` WASM as the PWA;
//! this crate adds nothing to the data model, signing, storage, or sync. It
//! exists to expose native-only capabilities (Bluetooth LE first) to the web
//! app through `web/src/lib/native.ts`, which is the only place UI code reaches
//! them from.

use serde::Serialize;

/// What this build of the shell can do natively. The web app asks once and
/// hides features the answer leaves out, so a capability lands here only once
/// it actually works on the platform.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Capabilities {
    pub bluetooth: bool,
}

#[tauri::command]
fn capabilities() -> Capabilities {
    Capabilities::default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![capabilities])
        .run(tauri::generate_context!())
        .expect("error while running the Svastha shell");
}

#[cfg(test)]
mod tests {
    use super::*;

    // native.ts reads these field names; a rename here would silently turn
    // every capability off in the UI.
    #[test]
    fn capabilities_serialize_with_the_names_native_ts_reads() {
        let json = serde_json::to_value(capabilities()).unwrap();
        assert_eq!(json, serde_json::json!({ "bluetooth": false }));
    }
}
