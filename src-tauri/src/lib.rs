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

    // `tauri android init` regenerates these files from a template that backs
    // the app's data up and shares all of external storage.
    const MANIFEST: &str = include_str!("../gen/android/app/src/main/AndroidManifest.xml");
    const EXTRACTION_RULES: &str =
        include_str!("../gen/android/app/src/main/res/xml/data_extraction_rules.xml");
    const FILE_PATHS: &str = include_str!("../gen/android/app/src/main/res/xml/file_paths.xml");

    #[test]
    fn android_keeps_the_vault_out_of_backup_and_device_transfer() {
        assert!(MANIFEST.contains(r#"android:allowBackup="false""#));
        assert!(MANIFEST.contains(r#"android:fullBackupContent="false""#));
        assert!(MANIFEST.contains(r#"android:dataExtractionRules="@xml/data_extraction_rules""#));
        assert!(!MANIFEST.contains(r#"android:allowBackup="true""#));

        // Every storage domain is excluded on both paths, and nothing is
        // re-included: one <include> would narrow the backup to that path
        // instead of disabling it.
        assert!(!EXTRACTION_RULES.contains("<include"));
        for section in ["cloud-backup", "device-transfer"] {
            let open = format!("<{section}>");
            let close = format!("</{section}>");
            let start = EXTRACTION_RULES.find(&open).expect(section);
            let end = EXTRACTION_RULES.find(&close).expect(section);
            let body = &EXTRACTION_RULES[start..end];
            for domain in ["root", "file", "database", "sharedpref", "external"] {
                assert!(
                    body.contains(&format!(r#"<exclude domain="{domain}" path="." />"#)),
                    "{section} does not exclude {domain}"
                );
            }
        }
    }

    #[test]
    fn android_file_provider_shares_only_camera_captures() {
        let roots: Vec<&str> = FILE_PATHS
            .lines()
            .map(str::trim)
            .filter(|l| l.starts_with('<') && l.contains("path="))
            .collect();
        assert_eq!(
            roots,
            [r#"<external-files-path name="camera" path="Pictures/" />"#]
        );
    }
}
