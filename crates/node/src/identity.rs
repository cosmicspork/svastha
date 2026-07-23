//! The node's own identity — the **only durable state**, and deliberately
//! disposable. On first boot the node generates a random seed, persists it to the
//! data dir, and derives its [`Identity`] from it. Losing the file means losing
//! the identity, which the design accepts: you generate a fresh one and re-grant
//! the node from the PWA. The grant mechanism *is* the recovery mechanism (see
//! `docs/ARCHITECTURE.md`, "Self-hosting", and the design doc §7, "State").
//!
//! The node holds no seed *phrase* for any vault owner and cannot sign events as
//! anyone: its identity is only how owners address it (grant + `key_handoff`) and
//! how it authenticates its outbound relay requests.

use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use rand_core::{OsRng, RngCore};
use svastha_core::keys::Identity;

/// The file under the data dir holding the node's disposable seed (lowercase hex
/// of 32 random bytes). Not a BIP39 phrase: there is nothing to socially recover,
/// so the plainest possible key material is used.
const SEED_FILE: &str = "node-identity.seed";

/// Load the node identity from the data dir, generating and persisting a fresh one
/// on first boot. Returns the identity and whether it was freshly generated (so
/// the caller can log "enrolled anew, awaiting a grant" versus "resumed").
pub fn load_or_generate(data_dir: &Path) -> Result<(Identity, bool)> {
    let path = data_dir.join(SEED_FILE);
    if let Some(seed) = read_seed(&path)? {
        return Ok((Identity::from_seed(&seed), false));
    }

    fs::create_dir_all(data_dir)
        .with_context(|| format!("create node data dir {}", data_dir.display()))?;
    let mut seed = [0u8; 32];
    OsRng.fill_bytes(&mut seed);
    write_seed(&path, &seed)?;
    Ok((Identity::from_seed(&seed), true))
}

fn read_seed(path: &Path) -> Result<Option<[u8; 32]>> {
    let Ok(contents) = fs::read_to_string(path) else {
        return Ok(None);
    };
    let bytes =
        hex::decode(contents.trim()).with_context(|| format!("{} is not hex", path.display()))?;
    let seed: [u8; 32] = bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("{} is not 32 bytes", path.display()))?;
    Ok(Some(seed))
}

fn write_seed(path: &Path, seed: &[u8; 32]) -> Result<()> {
    fs::write(path, hex::encode(seed)).with_context(|| format!("write {}", path.display()))?;
    restrict_permissions(path);
    Ok(())
}

/// Best-effort `0600` on the seed file. A failure here is not fatal — the host's
/// trust boundary (the design mounts this on a small private volume) is the real
/// protection — but tightening it costs nothing.
#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

/// The node's self-describing identity code — the same format the PWA scans and
/// pastes to grant a recipient (`docs/ARCHITECTURE.md`): both public keys and a
/// human label, exchanged out of band. Neither key is secret; the code saves
/// transcription.
///
/// `svastha1:{ed25519_hex}:{x25519_hex}:{label}`
pub fn identity_code(identity: &Identity, label: &str) -> String {
    format!(
        "svastha1:{}:{}:{}",
        hex::encode(identity.verifying_key().to_bytes()),
        hex::encode(identity.x25519_public().as_bytes()),
        label,
    )
}

/// A short fingerprint of the Ed25519 identity (first 8 bytes, hex) for the
/// human "same code?" confirmation both sides make before granting.
pub fn fingerprint(identity: &Identity) -> String {
    hex::encode(&identity.verifying_key().to_bytes()[..8])
}

/// Render `text` as a QR code drawn with unicode half-blocks, for the logs. Falls
/// back to `None` if the payload is somehow too large to encode (it never is for
/// an identity code, but encoding is fallible so we do not unwrap).
pub fn qr_unicode(text: &str) -> Option<String> {
    use qrcode::render::unicode;
    use qrcode::QrCode;
    let code = QrCode::new(text.as_bytes()).ok()?;
    Some(code.render::<unicode::Dense1x2>().quiet_zone(true).build())
}

/// Render `text` as an inline SVG QR for the bootstrap page.
pub fn qr_svg(text: &str) -> Option<String> {
    use qrcode::render::svg;
    use qrcode::QrCode;
    let code = QrCode::new(text.as_bytes()).ok()?;
    Some(
        code.render::<svg::Color>()
            .min_dimensions(200, 200)
            .quiet_zone(true)
            .build(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use svastha_core::keys::Identity;

    #[test]
    fn code_has_four_colon_parts_and_both_keys() {
        let id = Identity::from_seed(b"node seed");
        let code = identity_code(&id, "svastha-node");
        let parts: Vec<&str> = code.splitn(4, ':').collect();
        assert_eq!(parts[0], "svastha1");
        assert_eq!(parts[1], hex::encode(id.verifying_key().to_bytes()));
        assert_eq!(parts[2], hex::encode(id.x25519_public().as_bytes()));
        assert_eq!(parts[3], "svastha-node");
    }

    #[test]
    fn persisted_identity_is_stable_across_reload() {
        let dir = tempfile::tempdir().unwrap();
        let (first, fresh) = load_or_generate(dir.path()).unwrap();
        assert!(fresh, "first boot generates");
        let (second, fresh2) = load_or_generate(dir.path()).unwrap();
        assert!(!fresh2, "second boot resumes");
        // Same durable identity — the whole point of persisting the seed.
        assert_eq!(
            first.verifying_key().to_bytes(),
            second.verifying_key().to_bytes(),
        );
        assert_eq!(
            first.x25519_public().as_bytes(),
            second.x25519_public().as_bytes(),
        );
    }

    #[test]
    fn qr_encodes_the_code() {
        let id = Identity::from_seed(b"node seed");
        let code = identity_code(&id, "svastha-node");
        assert!(qr_unicode(&code).is_some());
        assert!(qr_svg(&code).is_some());
    }
}
