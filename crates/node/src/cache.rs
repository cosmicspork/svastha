//! The ephemeral plaintext cache. Decrypted attachment and source-document bytes
//! land here — never in the durable data dir — so D2's OCR has files to read.
//!
//! It is treated as **disposable**: on restart, anything missing simply re-syncs
//! from the relay (design §7, "State" — restart = resync). The code only ever uses
//! the configured directory and encodes **no deployment assumption**; a deployment
//! that wants host backups and snapshots to never contain plaintext mounts this on
//! tmpfs, but that is the operator's choice, not this code's concern.
//!
//! Events and curation records stay in the in-memory [`crate::index::VaultIndex`]
//! (RAM, not a disk backup surface); only the larger binary blobs are written out.

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};

/// Writes decrypted plaintext under a per-owner subtree of the cache dir.
pub struct Cache {
    root: PathBuf,
}

impl Cache {
    /// A cache rooted at `root` (the configured cache dir).
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// Write a captured document's decrypted bytes, keyed by its content hash.
    /// Overwrites idempotently (the content hash is the id, so identical bytes).
    pub fn write_attachment(&self, owner_hex: &str, sha256: &str, bytes: &[u8]) -> Result<()> {
        self.write(owner_hex, "attachments", sha256, bytes)
    }

    /// Write a source document's decrypted bytes, keyed by its content hash.
    pub fn write_doc(&self, owner_hex: &str, sha256: &str, bytes: &[u8]) -> Result<()> {
        self.write(owner_hex, "documents", sha256, bytes)
    }

    /// Read a captured document's decrypted bytes back for OCR (D2). `Ok(None)`
    /// if the file is absent — the cache is ephemeral, so a page the index knows
    /// about may not be on disk after a partial resync; the caller treats that as
    /// "not ready yet", never an error.
    pub fn read_attachment(&self, owner_hex: &str, sha256: &str) -> Result<Option<Vec<u8>>> {
        let path = self
            .root
            .join(owner_hex)
            .join("attachments")
            .join(sanitize(sha256));
        match fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e).with_context(|| format!("read cache file {}", path.display())),
        }
    }

    fn write(&self, owner_hex: &str, kind: &str, name: &str, bytes: &[u8]) -> Result<()> {
        let dir = self.root.join(owner_hex).join(kind);
        fs::create_dir_all(&dir).with_context(|| format!("create cache dir {}", dir.display()))?;
        let path = dir.join(sanitize(name));
        fs::write(&path, bytes).with_context(|| format!("write cache file {}", path.display()))
    }

    /// The per-owner cache root, for D2/D3 to locate what sync wrote.
    pub fn owner_dir(&self, owner_hex: &str) -> PathBuf {
        self.root.join(owner_hex)
    }
}

/// Keep a content-hash filename to the safe charset. Blob-id suffixes are already
/// lowercase hex, so this only guards against a malformed id ever reaching the
/// filesystem — it can never produce a `/` or a leading `.`.
fn sanitize(name: &str) -> String {
    let safe: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .collect();
    let trimmed = safe.trim_start_matches('.');
    if trimmed.is_empty() {
        "unnamed".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_under_per_owner_subtree() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path().to_path_buf());
        cache
            .write_attachment("ownerhex", "deadbeef", b"jpeg bytes")
            .unwrap();
        let path = dir
            .path()
            .join("ownerhex")
            .join("attachments")
            .join("deadbeef");
        assert_eq!(fs::read(path).unwrap(), b"jpeg bytes");
    }

    #[test]
    fn sanitize_defuses_traversal() {
        assert!(!sanitize("../../etc/passwd").contains('/'));
        assert!(!sanitize(".hidden").starts_with('.'));
    }
}
