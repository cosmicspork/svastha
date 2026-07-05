//! Mailbox storage: a store-and-forward drop box for wrapped vault keys. A
//! grant (`grants.rs`) authorizes reading a vault's blobs, but the vault key
//! itself still has to reach the grantee somehow — it travels here, wrapped
//! (ECIES) to the grantee's X25519 key, so the relay never sees it in the
//! clear. Any authed identity may deposit into any mailbox (there is nothing to
//! protect: the payload is opaque and the recipient chooses whether to trust
//! it); reading and deleting are scoped to the recipient.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tempfile::NamedTempFile;

/// A store of opaque mailbox items, each tagged with the depositor's identity
/// so the recipient can verify who claims to have sent it (see the
/// `svastha-from` response header in `routes.rs`). Implementations must be
/// cheap to share across request handlers (`Send + Sync`); `id` is
/// caller-validated (see the route layer's `valid_id`).
pub trait MailboxStore: Send + Sync {
    /// Deposit an item for `recipient`. Replaces any existing item under `id`.
    fn put(&self, recipient: &[u8; 32], id: &str, from: [u8; 32], blob: Vec<u8>) -> io::Result<()>;
    /// List `recipient`'s items: `(id, from)` pairs, no bodies.
    fn list(&self, recipient: &[u8; 32]) -> io::Result<Vec<(String, [u8; 32])>>;
    /// Fetch one item's `(blob, from)`, or `None` if absent.
    fn get(&self, recipient: &[u8; 32], id: &str) -> io::Result<Option<(Vec<u8>, [u8; 32])>>;
    /// Delete an item; returns whether one existed.
    fn delete(&self, recipient: &[u8; 32], id: &str) -> io::Result<bool>;
}

type Item = ([u8; 32], Vec<u8>); // (from, blob)
type Recipients = HashMap<[u8; 32], HashMap<String, Item>>;

/// In-memory mailbox. Loses everything on restart. Never errors.
#[derive(Default)]
pub struct MemoryMailboxStore {
    recipients: Mutex<Recipients>,
}

impl MemoryMailboxStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl MailboxStore for MemoryMailboxStore {
    fn put(&self, recipient: &[u8; 32], id: &str, from: [u8; 32], blob: Vec<u8>) -> io::Result<()> {
        self.recipients
            .lock()
            .unwrap()
            .entry(*recipient)
            .or_default()
            .insert(id.to_string(), (from, blob));
        Ok(())
    }

    fn list(&self, recipient: &[u8; 32]) -> io::Result<Vec<(String, [u8; 32])>> {
        Ok(self
            .recipients
            .lock()
            .unwrap()
            .get(recipient)
            .map(|items| {
                items
                    .iter()
                    .map(|(id, (from, _))| (id.clone(), *from))
                    .collect()
            })
            .unwrap_or_default())
    }

    fn get(&self, recipient: &[u8; 32], id: &str) -> io::Result<Option<(Vec<u8>, [u8; 32])>> {
        Ok(self
            .recipients
            .lock()
            .unwrap()
            .get(recipient)
            .and_then(|items| items.get(id))
            .map(|(from, blob)| (blob.clone(), *from)))
    }

    fn delete(&self, recipient: &[u8; 32], id: &str) -> io::Result<bool> {
        Ok(self
            .recipients
            .lock()
            .unwrap()
            .get_mut(recipient)
            .is_some_and(|items| items.remove(id).is_some()))
    }
}

/// Durable filesystem mailbox. Items live at
/// `{root}/mailbox/{hex(recipient)}/{id}`, file contents = 32-byte `from` public
/// key followed by the blob. Writes are atomic (stage in a sibling `.tmp` dir,
/// then rename), the same pattern as `store::FsStore`.
pub struct FsMailboxStore {
    root: PathBuf,
    tmp: PathBuf,
}

impl FsMailboxStore {
    pub fn new(root: impl AsRef<Path>) -> io::Result<Self> {
        let root = root.as_ref().to_path_buf();
        let tmp = root.join(".tmp");
        fs::create_dir_all(&tmp)?;
        Ok(Self { root, tmp })
    }

    fn recipient_dir(&self, recipient: &[u8; 32]) -> PathBuf {
        self.root.join(hex::encode(recipient))
    }

    fn encode(from: [u8; 32], blob: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(32 + blob.len());
        out.extend_from_slice(&from);
        out.extend_from_slice(blob);
        out
    }

    fn decode(bytes: Vec<u8>) -> Option<([u8; 32], Vec<u8>)> {
        if bytes.len() < 32 {
            return None;
        }
        let mut from = [0u8; 32];
        from.copy_from_slice(&bytes[..32]);
        Some((from, bytes[32..].to_vec()))
    }
}

impl MailboxStore for FsMailboxStore {
    fn put(&self, recipient: &[u8; 32], id: &str, from: [u8; 32], blob: Vec<u8>) -> io::Result<()> {
        let dir = self.recipient_dir(recipient);
        fs::create_dir_all(&dir)?;
        let mut tmp = NamedTempFile::new_in(&self.tmp)?;
        tmp.write_all(&Self::encode(from, &blob))?;
        tmp.flush()?;
        tmp.persist(dir.join(id)).map_err(|e| e.error)?;
        Ok(())
    }

    fn list(&self, recipient: &[u8; 32]) -> io::Result<Vec<(String, [u8; 32])>> {
        let entries = match fs::read_dir(self.recipient_dir(recipient)) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let mut out = Vec::new();
        for entry in entries {
            let entry = entry?;
            let id = entry.file_name().to_string_lossy().into_owned();
            if let Some((from, _)) = Self::decode(fs::read(entry.path())?) {
                out.push((id, from));
            }
        }
        Ok(out)
    }

    fn get(&self, recipient: &[u8; 32], id: &str) -> io::Result<Option<(Vec<u8>, [u8; 32])>> {
        match fs::read(self.recipient_dir(recipient).join(id)) {
            Ok(bytes) => Ok(Self::decode(bytes).map(|(from, blob)| (blob, from))),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn delete(&self, recipient: &[u8; 32], id: &str) -> io::Result<bool> {
        match fs::remove_file(self.recipient_dir(recipient).join(id)) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn id(b: u8) -> [u8; 32] {
        [b; 32]
    }

    #[test]
    fn fs_round_trip() {
        let dir = tempdir().unwrap();
        let store = FsMailboxStore::new(dir.path()).unwrap();
        let (recipient, from) = (id(1), id(2));

        store
            .put(&recipient, "vaultkey-abcd1234", from, b"wrapped".to_vec())
            .unwrap();
        let (blob, got_from) = store.get(&recipient, "vaultkey-abcd1234").unwrap().unwrap();
        assert_eq!(blob, b"wrapped");
        assert_eq!(got_from, from);
        assert_eq!(
            store.list(&recipient).unwrap(),
            vec![("vaultkey-abcd1234".to_string(), from)]
        );

        assert!(store.delete(&recipient, "vaultkey-abcd1234").unwrap());
        assert!(store
            .get(&recipient, "vaultkey-abcd1234")
            .unwrap()
            .is_none());
    }

    #[test]
    fn fs_missing_recipient_is_empty() {
        let dir = tempdir().unwrap();
        let store = FsMailboxStore::new(dir.path()).unwrap();
        assert!(store.list(&id(9)).unwrap().is_empty());
        assert!(store.get(&id(9), "x").unwrap().is_none());
    }
}
