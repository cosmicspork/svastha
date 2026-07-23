//! Grant storage: who has authorized whom to read their vault, and under what
//! optional constraints. A grant is pure routing metadata — the relay never sees
//! the wrapped vault key that makes the grant useful (that travels through the
//! mailbox); revoking a grant only stops future reads, it cannot retract data
//! already synced to the grantee's device. See `docs/ARCHITECTURE.md`, "Vaults
//! and grants".
//!
//! A grant may carry two **optional**, relay-enforced constraints (see the
//! [`Grant`] type): a blob-id **prefix allowlist** and an **expiry**. Both are
//! evaluated against metadata the relay already holds — prefixes are the routing
//! partition of client-chosen ids, and an expiry is a plain timestamp — so
//! enforcing them leaks nothing the relay was not already privy to. Absent
//! constraints mean today's behavior: full read, no expiry. Legacy grants
//! stored before scoping (an empty marker) decode as exactly that, so no stored
//! grant needs migrating.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// The optional, relay-enforced constraints on a grant. Both fields default to
/// "unconstrained": an empty `prefixes` is a full read, an absent `expires_at`
/// lives until revoked. A grant with both at their defaults is today's
/// whole-vault, no-expiry grant, and serializes to `{}` — which is how a legacy
/// (pre-scoping) marker round-trips unchanged.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grant {
    /// Blob-id prefix allowlist. **Empty means no restriction** (full read). A
    /// non-empty list restricts the grantee's shared listing and shared-blob
    /// fetches to ids matching one of these prefixes. Prefixes are already the
    /// relay-visible routing partition of client-chosen ids (`ev-`, `att-`, …),
    /// so filtering on them reveals nothing new.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub prefixes: Vec<String>,
    /// Optional expiry, Unix seconds. **`None` means no expiry** — the grant
    /// lives until revoked (there is no default expiry). At or past it, the grant
    /// behaves exactly as if it did not exist.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
}

impl Grant {
    /// Whether a blob `id` is visible under this grant's allowlist. An empty
    /// allowlist admits every id (the unscoped default); otherwise the id must
    /// start with one of the allowed prefixes.
    pub fn admits(&self, id: &str) -> bool {
        self.prefixes.is_empty() || self.prefixes.iter().any(|p| id.starts_with(p.as_str()))
    }

    /// Whether the grant has expired as of `now` (Unix seconds). An expired
    /// grant is treated as absent everywhere it is consulted, so the two-404
    /// non-leak rule keeps holding: a caller cannot tell an expired grant from
    /// one that never existed. Boundary is inclusive (`now >= expires_at`),
    /// matching the share endpoint's lazy-expiry comparison.
    pub fn is_expired(&self, now: u64) -> bool {
        self.expires_at.is_some_and(|e| now >= e)
    }
}

/// A store of owner -> grantee read authorizations (each with its optional
/// [`Grant`] scope), queryable in both directions (an owner's grantees, and a
/// grantee's granters). Implementations must be cheap to share across request
/// handlers (`Send + Sync`). Keys are raw Ed25519 public keys; the route layer
/// validates hex before calling in.
pub trait GrantStore: Send + Sync {
    /// Authorize `grantee` to read `owner`'s shared blobs under `grant`.
    /// Idempotent, and an **upsert**: re-`put`ting an existing pair replaces its
    /// scope, which is how a grant is re-scoped in place.
    fn put(&self, owner: &[u8; 32], grantee: &[u8; 32], grant: &Grant) -> io::Result<()>;
    /// Revoke a grant; returns whether one existed.
    fn delete(&self, owner: &[u8; 32], grantee: &[u8; 32]) -> io::Result<bool>;
    /// Everyone `owner` has granted read access to (regardless of scope or
    /// expiry — this is the owner's own view of the grants they've issued).
    fn grantees_of(&self, owner: &[u8; 32]) -> io::Result<Vec<[u8; 32]>>;
    /// Everyone who has granted `grantee` read access to their vault.
    fn granters_to(&self, grantee: &[u8; 32]) -> io::Result<Vec<[u8; 32]>>;
    /// The grant `owner` issued to `grantee`, or `None` if none exists. The
    /// returned [`Grant`] carries its raw `expires_at`; callers gating access
    /// evaluate [`Grant::is_expired`] against the current time, so expiry policy
    /// stays in one place (the handler) the way share expiry does.
    fn get(&self, owner: &[u8; 32], grantee: &[u8; 32]) -> io::Result<Option<Grant>>;
}

/// An owner's grantees mapped to the scope each was granted.
type ScopedGrantees = HashMap<[u8; 32], Grant>;

/// Each owner's grantees (with their scopes), and a reverse index of a grantee's
/// owners — kept in lockstep so both query directions are O(1) lookups. Never
/// errors.
#[derive(Default)]
pub struct MemoryGrantStore {
    forward: Mutex<HashMap<[u8; 32], ScopedGrantees>>,
    reverse: Mutex<HashMap<[u8; 32], Vec<[u8; 32]>>>,
}

impl MemoryGrantStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl GrantStore for MemoryGrantStore {
    fn put(&self, owner: &[u8; 32], grantee: &[u8; 32], grant: &Grant) -> io::Result<()> {
        // Upsert: replace any existing scope for this pair.
        self.forward
            .lock()
            .unwrap()
            .entry(*owner)
            .or_default()
            .insert(*grantee, grant.clone());

        let mut reverse = self.reverse.lock().unwrap();
        let entry = reverse.entry(*grantee).or_default();
        if !entry.contains(owner) {
            entry.push(*owner);
        }
        Ok(())
    }

    fn delete(&self, owner: &[u8; 32], grantee: &[u8; 32]) -> io::Result<bool> {
        let mut forward = self.forward.lock().unwrap();
        let existed = forward
            .get_mut(owner)
            .is_some_and(|grantees| grantees.remove(grantee).is_some());
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
            .map(|grantees| grantees.keys().copied().collect())
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

    fn get(&self, owner: &[u8; 32], grantee: &[u8; 32]) -> io::Result<Option<Grant>> {
        Ok(self
            .forward
            .lock()
            .unwrap()
            .get(owner)
            .and_then(|grantees| grantees.get(grantee))
            .cloned())
    }
}

/// Durable filesystem store. A grant is a small JSON file at
/// `{root}/grants/{hex(owner)}/{hex(grantee)}` holding its [`Grant`] scope
/// (`{}` for an unscoped grant), with a reverse index mirrored at
/// `{root}/grantsrev/{hex(grantee)}/{hex(owner)}` (an empty marker) for
/// `granters_to`. `put` writes forward then reverse; a crash between the two
/// leaves the reverse index briefly behind, which only affects `granters_to`
/// (the grantee's own "who shares with me" listing) — `get` and `grantees_of`
/// (the security-relevant checks gating `/v0/shared/*`) read the forward index
/// only, so a crash never grants access that wasn't durably recorded. A later
/// `put` for the same pair re-writes both files and reconciles the gap.
///
/// A grant marker written before scoping existed is a **zero-byte** file; it
/// decodes as [`Grant::default`] (full read, no expiry), so legacy grants keep
/// working with no migration.
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
    fn put(&self, owner: &[u8; 32], grantee: &[u8; 32], grant: &Grant) -> io::Result<()> {
        let forward = self.forward_dir(owner);
        fs::create_dir_all(&forward)?;
        let encoded = serde_json::to_vec(grant).map_err(io::Error::other)?;
        fs::write(forward.join(hex::encode(grantee)), encoded)?;

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

    fn get(&self, owner: &[u8; 32], grantee: &[u8; 32]) -> io::Result<Option<Grant>> {
        let bytes = match fs::read(self.forward_dir(owner).join(hex::encode(grantee))) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        // A zero-byte marker is a pre-scoping (legacy) grant: unconstrained.
        if bytes.is_empty() {
            return Ok(Some(Grant::default()));
        }
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(io::Error::other)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn id(b: u8) -> [u8; 32] {
        [b; 32]
    }

    fn scoped(prefixes: &[&str], expires_at: Option<u64>) -> Grant {
        Grant {
            prefixes: prefixes.iter().map(|s| s.to_string()).collect(),
            expires_at,
        }
    }

    #[test]
    fn grant_admits_and_expiry() {
        let full = Grant::default();
        assert!(full.admits("ev-abc"));
        assert!(full.admits("cur-xyz"));
        assert!(!full.is_expired(0));
        assert!(!full.is_expired(u64::MAX));

        let g = scoped(&["ev-", "att-"], Some(100));
        assert!(g.admits("ev-abc"));
        assert!(g.admits("att-9"));
        assert!(!g.admits("cur-xyz"));
        assert!(!g.admits("doc-1"));
        assert!(!g.is_expired(99));
        assert!(g.is_expired(100)); // inclusive boundary
        assert!(g.is_expired(101));
    }

    #[test]
    fn fs_grant_round_trip() {
        let dir = tempdir().unwrap();
        let store = FsGrantStore::new(dir.path()).unwrap();
        let (owner, grantee) = (id(1), id(2));

        assert!(store.get(&owner, &grantee).unwrap().is_none());
        let grant = scoped(&["ev-", "att-"], Some(1_800_000_000));
        store.put(&owner, &grantee, &grant).unwrap();
        assert_eq!(store.get(&owner, &grantee).unwrap(), Some(grant));
        assert_eq!(store.grantees_of(&owner).unwrap(), vec![grantee]);
        assert_eq!(store.granters_to(&grantee).unwrap(), vec![owner]);

        assert!(store.delete(&owner, &grantee).unwrap());
        assert!(store.get(&owner, &grantee).unwrap().is_none());
        assert!(!store.delete(&owner, &grantee).unwrap());
    }

    #[test]
    fn fs_put_upserts_scope() {
        let dir = tempdir().unwrap();
        let store = FsGrantStore::new(dir.path()).unwrap();
        let (owner, grantee) = (id(1), id(2));
        store.put(&owner, &grantee, &Grant::default()).unwrap();
        // Re-scope in place: the second put replaces the first grant's scope,
        // and does not create a duplicate reverse-index entry.
        let rescoped = scoped(&["ev-"], None);
        store.put(&owner, &grantee, &rescoped).unwrap();
        assert_eq!(store.get(&owner, &grantee).unwrap(), Some(rescoped));
        assert_eq!(store.grantees_of(&owner).unwrap(), vec![grantee]);
        assert_eq!(store.granters_to(&grantee).unwrap(), vec![owner]);
    }

    #[test]
    fn fs_zero_byte_marker_is_legacy_unscoped() {
        // A grant written before scoping existed is an empty marker file; it must
        // decode as a full-read, no-expiry grant with no migration.
        let dir = tempdir().unwrap();
        let store = FsGrantStore::new(dir.path()).unwrap();
        let (owner, grantee) = (id(1), id(2));
        let forward = store.forward_dir(&owner);
        fs::create_dir_all(&forward).unwrap();
        fs::write(forward.join(hex::encode(grantee)), []).unwrap();

        let grant = store.get(&owner, &grantee).unwrap().unwrap();
        assert_eq!(grant, Grant::default());
        assert!(grant.admits("ev-x"));
        assert!(!grant.is_expired(u64::MAX));
    }

    #[test]
    fn memory_grant_round_trip_and_upsert() {
        let store = MemoryGrantStore::new();
        let (owner, grantee) = (id(1), id(2));
        store.put(&owner, &grantee, &Grant::default()).unwrap();
        assert_eq!(store.get(&owner, &grantee).unwrap(), Some(Grant::default()));
        assert_eq!(store.granters_to(&grantee).unwrap(), vec![owner]);

        let rescoped = scoped(&["ev-"], Some(42));
        store.put(&owner, &grantee, &rescoped).unwrap();
        assert_eq!(store.get(&owner, &grantee).unwrap(), Some(rescoped));
        // Upsert must not duplicate the reverse edge.
        assert_eq!(store.granters_to(&grantee).unwrap(), vec![owner]);

        assert!(store.delete(&owner, &grantee).unwrap());
        assert!(store.get(&owner, &grantee).unwrap().is_none());
    }

    #[test]
    fn unscoped_grant_serializes_to_empty_object() {
        // The default grant round-trips as `{}`, so an unscoped grant carries no
        // incidental fields on the wire or on disk.
        assert_eq!(serde_json::to_string(&Grant::default()).unwrap(), "{}");
        let decoded: Grant = serde_json::from_str("{}").unwrap();
        assert_eq!(decoded, Grant::default());
    }
}
