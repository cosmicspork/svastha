//! Blob storage, scoped by owner. The relay stores opaque ciphertext keyed by
//! `(owner public key, id)`; it never inspects a blob's contents. The trait is
//! the seam backends plug into: an in-memory map for tests and ephemeral runs, a
//! filesystem store for durable self-hosting.
//!
//! Methods return [`io::Result`] so a real backend can surface failures rather
//! than silently dropping a write; the in-memory store never errors.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tempfile::NamedTempFile;

/// A store of opaque encrypted blobs, partitioned by owner so one identity can
/// never read another's data. Implementations must be cheap to share across
/// request handlers (`Send + Sync`, interior mutability). `id` is assumed to be a
/// caller-validated token (see the route layer); backends use it verbatim.
pub trait BlobStore: Send + Sync {
    /// Store (or replace) a blob for an owner.
    fn put(&self, owner: &[u8; 32], id: &str, blob: Vec<u8>) -> io::Result<()>;
    /// Fetch a blob, or `None` if this owner has no blob under `id`.
    fn get(&self, owner: &[u8; 32], id: &str) -> io::Result<Option<Vec<u8>>>;
    /// Byte length of a blob, or `None` if this owner has no blob under `id`.
    /// A **racy preflight hint, not authoritative**: nothing pins it to a
    /// snapshot with a subsequent `get` on the same store, so a concurrent
    /// `put`/`delete` between the two calls can make the real bytes disagree
    /// with what this returned — a caller budgeting against it must recheck
    /// against `get`'s actual result before committing to anything sized by
    /// this (see `framed_page`).
    ///
    /// Defaults to a full `get` (so a `BlobStore` that only implements the
    /// other four methods still compiles — this trait is public and the crate
    /// is semver-versioned, and a newly *required* method would break every
    /// external backend on a non-major release). A real backend should
    /// override this with a cheap `stat` instead of buffering (see
    /// `FsStore`).
    fn size(&self, owner: &[u8; 32], id: &str) -> io::Result<Option<u64>> {
        Ok(self.get(owner, id)?.map(|blob| blob.len() as u64))
    }
    /// List the ids this owner has stored.
    fn list(&self, owner: &[u8; 32]) -> io::Result<Vec<String>>;
    /// Delete a blob; returns whether one existed.
    fn delete(&self, owner: &[u8; 32], id: &str) -> io::Result<bool>;
}

/// Each owner's blobs, by id.
type Owners = HashMap<[u8; 32], HashMap<String, Vec<u8>>>;

/// In-memory blob store. Loses everything on restart — fine for tests and an
/// ephemeral relay, not for durable backup; use [`FsStore`] for that. Never errors.
#[derive(Default)]
pub struct MemoryStore {
    owners: Mutex<Owners>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl BlobStore for MemoryStore {
    fn put(&self, owner: &[u8; 32], id: &str, blob: Vec<u8>) -> io::Result<()> {
        self.owners
            .lock()
            .unwrap()
            .entry(*owner)
            .or_default()
            .insert(id.to_string(), blob);
        Ok(())
    }

    fn get(&self, owner: &[u8; 32], id: &str) -> io::Result<Option<Vec<u8>>> {
        Ok(self
            .owners
            .lock()
            .unwrap()
            .get(owner)
            .and_then(|blobs| blobs.get(id))
            .cloned())
    }

    fn size(&self, owner: &[u8; 32], id: &str) -> io::Result<Option<u64>> {
        Ok(self
            .owners
            .lock()
            .unwrap()
            .get(owner)
            .and_then(|blobs| blobs.get(id))
            .map(|blob| blob.len() as u64))
    }

    fn list(&self, owner: &[u8; 32]) -> io::Result<Vec<String>> {
        Ok(self
            .owners
            .lock()
            .unwrap()
            .get(owner)
            .map(|blobs| blobs.keys().cloned().collect())
            .unwrap_or_default())
    }

    fn delete(&self, owner: &[u8; 32], id: &str) -> io::Result<bool> {
        Ok(self
            .owners
            .lock()
            .unwrap()
            .get_mut(owner)
            .is_some_and(|blobs| blobs.remove(id).is_some()))
    }
}

/// Durable filesystem store. Blobs live at `{root}/{hex(owner)}/{id}`; writes are
/// atomic (staged in a sibling `.tmp` dir, then renamed into place) so a crash
/// never leaves a partial blob. `hex(owner)` is always 64 hex chars and `id` is
/// route-validated, so paths cannot escape `root`.
pub struct FsStore {
    root: PathBuf,
    tmp: PathBuf,
}

impl FsStore {
    /// Open (creating if needed) a store rooted at `root`. Fails fast if the
    /// directory cannot be created.
    pub fn new(root: impl AsRef<Path>) -> io::Result<Self> {
        let root = root.as_ref().to_path_buf();
        let tmp = root.join(".tmp");
        fs::create_dir_all(&tmp)?;
        Ok(Self { root, tmp })
    }

    fn owner_dir(&self, owner: &[u8; 32]) -> PathBuf {
        self.root.join(hex::encode(owner))
    }
}

impl BlobStore for FsStore {
    fn put(&self, owner: &[u8; 32], id: &str, blob: Vec<u8>) -> io::Result<()> {
        let dir = self.owner_dir(owner);
        fs::create_dir_all(&dir)?;
        // Stage then rename so a reader never sees a half-written blob.
        let mut tmp = NamedTempFile::new_in(&self.tmp)?;
        tmp.write_all(&blob)?;
        tmp.flush()?;
        tmp.persist(dir.join(id)).map_err(|e| e.error)?;
        Ok(())
    }

    fn get(&self, owner: &[u8; 32], id: &str) -> io::Result<Option<Vec<u8>>> {
        match fs::read(self.owner_dir(owner).join(id)) {
            Ok(blob) => Ok(Some(blob)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn size(&self, owner: &[u8; 32], id: &str) -> io::Result<Option<u64>> {
        match fs::metadata(self.owner_dir(owner).join(id)) {
            Ok(meta) => Ok(Some(meta.len())),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn list(&self, owner: &[u8; 32]) -> io::Result<Vec<String>> {
        let entries = match fs::read_dir(self.owner_dir(owner)) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let mut ids = Vec::new();
        for entry in entries {
            ids.push(entry?.file_name().to_string_lossy().into_owned());
        }
        Ok(ids)
    }

    fn delete(&self, owner: &[u8; 32], id: &str) -> io::Result<bool> {
        match fs::remove_file(self.owner_dir(owner).join(id)) {
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

    fn owner(b: u8) -> [u8; 32] {
        [b; 32]
    }

    #[test]
    fn fs_round_trip() {
        let dir = tempdir().unwrap();
        let store = FsStore::new(dir.path()).unwrap();
        let o = owner(1);

        store.put(&o, "rec1", b"hello".to_vec()).unwrap();
        assert_eq!(store.get(&o, "rec1").unwrap(), Some(b"hello".to_vec()));
        assert_eq!(store.list(&o).unwrap(), vec!["rec1".to_string()]);

        assert!(store.delete(&o, "rec1").unwrap());
        assert_eq!(store.get(&o, "rec1").unwrap(), None);
        assert!(!store.delete(&o, "rec1").unwrap());
    }

    /// A `BlobStore` that only implements the four pre-existing methods —
    /// standing in for an external backend written before `size` existed —
    /// still compiles and gives a correct (if unstated) answer via the
    /// trait's default. This is the non-breaking-ness `size` promises, not
    /// just an aspiration.
    struct MinimalStore(MemoryStore);

    impl BlobStore for MinimalStore {
        fn put(&self, owner: &[u8; 32], id: &str, blob: Vec<u8>) -> io::Result<()> {
            self.0.put(owner, id, blob)
        }
        fn get(&self, owner: &[u8; 32], id: &str) -> io::Result<Option<Vec<u8>>> {
            self.0.get(owner, id)
        }
        fn list(&self, owner: &[u8; 32]) -> io::Result<Vec<String>> {
            self.0.list(owner)
        }
        fn delete(&self, owner: &[u8; 32], id: &str) -> io::Result<bool> {
            self.0.delete(owner, id)
        }
        // No `size` override: the default below is exercised.
    }

    #[test]
    fn size_defaults_correctly_for_a_store_that_predates_it() {
        let store = MinimalStore(MemoryStore::new());
        let o = owner(1);
        store.put(&o, "rec1", b"hello".to_vec()).unwrap();

        assert_eq!(store.size(&o, "rec1").unwrap(), Some(5));
        assert_eq!(store.size(&o, "missing").unwrap(), None);
    }

    #[test]
    fn fs_missing_owner_is_empty() {
        let dir = tempdir().unwrap();
        let store = FsStore::new(dir.path()).unwrap();
        assert_eq!(store.get(&owner(9), "x").unwrap(), None);
        assert!(store.list(&owner(9)).unwrap().is_empty());
    }

    #[test]
    fn fs_owners_are_isolated() {
        let dir = tempdir().unwrap();
        let store = FsStore::new(dir.path()).unwrap();
        store.put(&owner(1), "secret", b"a".to_vec()).unwrap();
        assert_eq!(store.get(&owner(2), "secret").unwrap(), None);
        assert!(store.list(&owner(2)).unwrap().is_empty());
    }

    #[test]
    fn fs_list_excludes_temp_artifacts() {
        let dir = tempdir().unwrap();
        let store = FsStore::new(dir.path()).unwrap();
        store.put(&owner(1), "a", b"x".to_vec()).unwrap();
        store.put(&owner(1), "b", b"y".to_vec()).unwrap();
        let mut ids = store.list(&owner(1)).unwrap();
        ids.sort();
        assert_eq!(ids, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn fs_survives_reopen() {
        let dir = tempdir().unwrap();
        {
            let store = FsStore::new(dir.path()).unwrap();
            store.put(&owner(1), "rec", b"durable".to_vec()).unwrap();
        }
        let reopened = FsStore::new(dir.path()).unwrap();
        assert_eq!(
            reopened.get(&owner(1), "rec").unwrap(),
            Some(b"durable".to_vec())
        );
    }
}
