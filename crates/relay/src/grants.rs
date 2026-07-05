//! Grant storage: who has authorized whom to read their vault. A grant is pure
//! routing metadata — the relay never sees the wrapped vault key that makes the
//! grant useful (that travels through the mailbox); revoking a grant only stops
//! future reads, it cannot retract data already synced to the grantee's device.
//! See `docs/ARCHITECTURE.md`, "Vaults and grants".

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// A store of owner -> grantee read authorizations, queryable in both
/// directions (an owner's grantees, and a grantee's granters). Implementations
/// must be cheap to share across request handlers (`Send + Sync`). Keys are
/// raw Ed25519 public keys; the route layer validates hex before calling in.
pub trait GrantStore: Send + Sync {
    /// Authorize `grantee` to read `owner`'s shared blobs. Idempotent.
    fn put(&self, owner: &[u8; 32], grantee: &[u8; 32]) -> io::Result<()>;
    /// Revoke a grant; returns whether one existed.
    fn delete(&self, owner: &[u8; 32], grantee: &[u8; 32]) -> io::Result<bool>;
    /// Everyone `owner` has granted read access to.
    fn grantees_of(&self, owner: &[u8; 32]) -> io::Result<Vec<[u8; 32]>>;
    /// Everyone who has granted `grantee` read access to their vault.
    fn granters_to(&self, grantee: &[u8; 32]) -> io::Result<Vec<[u8; 32]>>;
    /// Whether `owner` has granted `grantee` read access.
    fn has(&self, owner: &[u8; 32], grantee: &[u8; 32]) -> io::Result<bool>;
}

/// Each owner's grantees, and the reverse index — kept in lockstep so both
/// query directions are O(1) lookups. Never errors.
#[derive(Default)]
pub struct MemoryGrantStore {
    forward: Mutex<HashMap<[u8; 32], Vec<[u8; 32]>>>,
    reverse: Mutex<HashMap<[u8; 32], Vec<[u8; 32]>>>,
}

impl MemoryGrantStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl GrantStore for MemoryGrantStore {
    fn put(&self, owner: &[u8; 32], grantee: &[u8; 32]) -> io::Result<()> {
        let mut forward = self.forward.lock().unwrap();
        let entry = forward.entry(*owner).or_default();
        if !entry.contains(grantee) {
            entry.push(*grantee);
        }
        drop(forward);

        let mut reverse = self.reverse.lock().unwrap();
        let entry = reverse.entry(*grantee).or_default();
        if !entry.contains(owner) {
            entry.push(*owner);
        }
        Ok(())
    }

    fn delete(&self, owner: &[u8; 32], grantee: &[u8; 32]) -> io::Result<bool> {
        let mut forward = self.forward.lock().unwrap();
        let existed = forward.get_mut(owner).is_some_and(|grantees| {
            match grantees.iter().position(|g| g == grantee) {
                Some(i) => {
                    grantees.remove(i);
                    true
                }
                None => false,
            }
        });
        drop(forward);

        if existed {
            let mut reverse = self.reverse.lock().unwrap();
            if let Some(owners) = reverse.get_mut(grantee) {
                if let Some(i) = owners.iter().position(|o| o == owner) {
                    owners.remove(i);
                }
            }
        }
        Ok(existed)
    }

    fn grantees_of(&self, owner: &[u8; 32]) -> io::Result<Vec<[u8; 32]>> {
        Ok(self
            .forward
            .lock()
            .unwrap()
            .get(owner)
            .cloned()
            .unwrap_or_default())
    }

    fn granters_to(&self, grantee: &[u8; 32]) -> io::Result<Vec<[u8; 32]>> {
        Ok(self
            .reverse
            .lock()
            .unwrap()
            .get(grantee)
            .cloned()
            .unwrap_or_default())
    }

    fn has(&self, owner: &[u8; 32], grantee: &[u8; 32]) -> io::Result<bool> {
        Ok(self
            .forward
            .lock()
            .unwrap()
            .get(owner)
            .is_some_and(|grantees| grantees.contains(grantee)))
    }
}

/// Durable filesystem store. A grant is an empty marker file at
/// `{root}/grants/{hex(owner)}/{hex(grantee)}`, with a reverse index mirrored at
/// `{root}/grantsrev/{hex(grantee)}/{hex(owner)}` for `granters_to`. `put` writes
/// forward then reverse; a crash between the two leaves the reverse index
/// briefly behind, which only affects `granters_to` (the grantee's own "who
/// shares with me" listing) — `has` and `grantees_of` (the security-relevant
/// checks gating `/v0/shared/*`) read the forward index only, so a crash never
/// grants access that wasn't durably recorded. A later `put` for the same pair
/// re-writes both files and reconciles the gap.
pub struct FsGrantStore {
    root: PathBuf,
}

impl FsGrantStore {
    pub fn new(root: impl AsRef<Path>) -> io::Result<Self> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(root.join("grants"))?;
        fs::create_dir_all(root.join("grantsrev"))?;
        Ok(Self { root })
    }

    fn forward_dir(&self, owner: &[u8; 32]) -> PathBuf {
        self.root.join("grants").join(hex::encode(owner))
    }

    fn reverse_dir(&self, grantee: &[u8; 32]) -> PathBuf {
        self.root.join("grantsrev").join(hex::encode(grantee))
    }

    fn list_hex_dir(dir: &Path) -> io::Result<Vec<[u8; 32]>> {
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let mut out = Vec::new();
        for entry in entries {
            let name = entry?.file_name().to_string_lossy().into_owned();
            if let Some(bytes) = hex::decode(&name).ok().and_then(|b| b.try_into().ok()) {
                out.push(bytes);
            }
        }
        Ok(out)
    }
}

impl GrantStore for FsGrantStore {
    fn put(&self, owner: &[u8; 32], grantee: &[u8; 32]) -> io::Result<()> {
        let forward = self.forward_dir(owner);
        fs::create_dir_all(&forward)?;
        fs::write(forward.join(hex::encode(grantee)), [])?;

        let reverse = self.reverse_dir(grantee);
        fs::create_dir_all(&reverse)?;
        fs::write(reverse.join(hex::encode(owner)), [])?;
        Ok(())
    }

    fn delete(&self, owner: &[u8; 32], grantee: &[u8; 32]) -> io::Result<bool> {
        let existed = match fs::remove_file(self.forward_dir(owner).join(hex::encode(grantee))) {
            Ok(()) => true,
            Err(e) if e.kind() == io::ErrorKind::NotFound => false,
            Err(e) => return Err(e),
        };
        if existed {
            match fs::remove_file(self.reverse_dir(grantee).join(hex::encode(owner))) {
                Ok(()) | Err(_) => {} // best-effort: forward index is the source of truth
            }
        }
        Ok(existed)
    }

    fn grantees_of(&self, owner: &[u8; 32]) -> io::Result<Vec<[u8; 32]>> {
        Self::list_hex_dir(&self.forward_dir(owner))
    }

    fn granters_to(&self, grantee: &[u8; 32]) -> io::Result<Vec<[u8; 32]>> {
        Self::list_hex_dir(&self.reverse_dir(grantee))
    }

    fn has(&self, owner: &[u8; 32], grantee: &[u8; 32]) -> io::Result<bool> {
        Ok(self.forward_dir(owner).join(hex::encode(grantee)).is_file())
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
    fn fs_grant_round_trip() {
        let dir = tempdir().unwrap();
        let store = FsGrantStore::new(dir.path()).unwrap();
        let (owner, grantee) = (id(1), id(2));

        assert!(!store.has(&owner, &grantee).unwrap());
        store.put(&owner, &grantee).unwrap();
        assert!(store.has(&owner, &grantee).unwrap());
        assert_eq!(store.grantees_of(&owner).unwrap(), vec![grantee]);
        assert_eq!(store.granters_to(&grantee).unwrap(), vec![owner]);

        assert!(store.delete(&owner, &grantee).unwrap());
        assert!(!store.has(&owner, &grantee).unwrap());
        assert!(!store.delete(&owner, &grantee).unwrap());
    }

    #[test]
    fn fs_put_is_idempotent() {
        let dir = tempdir().unwrap();
        let store = FsGrantStore::new(dir.path()).unwrap();
        let (owner, grantee) = (id(1), id(2));
        store.put(&owner, &grantee).unwrap();
        store.put(&owner, &grantee).unwrap();
        assert_eq!(store.grantees_of(&owner).unwrap(), vec![grantee]);
    }

    #[test]
    fn memory_grant_round_trip() {
        let store = MemoryGrantStore::new();
        let (owner, grantee) = (id(1), id(2));
        store.put(&owner, &grantee).unwrap();
        assert!(store.has(&owner, &grantee).unwrap());
        assert_eq!(store.granters_to(&grantee).unwrap(), vec![owner]);
        assert!(store.delete(&owner, &grantee).unwrap());
        assert!(!store.has(&owner, &grantee).unwrap());
    }
}
