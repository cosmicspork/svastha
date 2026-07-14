//! Share storage: sealed bundles a record owner uploads for a doctor (or anyone
//! else) to fetch by an unguessable bearer token. Like everything else the relay
//! holds, a bundle is opaque ciphertext — the per-share key that decrypts it
//! travels only in the share link's URL fragment and never reaches the relay, so
//! serving a bundle stays zero-knowledge. A share carries an expiry (the relay
//! clamps it) and can be revoked; either one stops *future* fetches but cannot
//! recall bytes a recipient already pulled, and the client must say so.
//!
//! Revocation and expiry leave a small **tombstone** (token, owner, why, when)
//! in place of the deleted bundle bytes, so a later fetch answers `410 Gone`
//! rather than `404` — the recipient learns "this share ended," not "no such
//! link." Tombstones are swept once they age past a retention window (see
//! [`ShareStore::sweep`]). This `410`/`404` split deliberately diverges from the
//! grants' two-404 non-leak rule; the reasoning is in `spec/README.md`'s
//! "Shares" section (a share token is itself a ≥128-bit secret, so the status
//! code leaks nothing to anyone not already holding the link).

use std::collections::HashMap;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tempfile::NamedTempFile;

/// Why a share is tombstoned. Recorded so the owner (and future tooling) can
/// tell a lapsed share from a deliberately revoked one.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TombstoneReason {
    Expired,
    Revoked,
}

/// The current state of a token: a live share, a tombstone left by expiry or
/// revocation, or nothing at all. `Missing` is deliberately distinguishable from
/// `Tombstone` so the read path can answer `404` vs `410`.
pub enum ShareState {
    Missing,
    Live {
        owner: [u8; 32],
        sealed_bundle: Vec<u8>,
        created_at: u64,
        expires_at: u64,
    },
    Tombstone {
        owner: [u8; 32],
        reason: TombstoneReason,
        when: u64,
    },
}

/// A store of sealed share bundles keyed by an unguessable bearer token.
/// Implementations must be cheap to share across request handlers
/// (`Send + Sync`); `token` is caller-validated by the route layer (charset plus
/// a ≥128-bit length floor) before it ever reaches a backend.
pub trait ShareStore: Send + Sync {
    /// Create (or replace) a share under `token`. Replacing overwrites any live
    /// share or tombstone already there.
    fn put(
        &self,
        token: &str,
        owner: [u8; 32],
        sealed_bundle: Vec<u8>,
        created_at: u64,
        expires_at: u64,
    ) -> io::Result<()>;

    /// Full state of `token`, including the bundle bytes for a live share (used
    /// by the read path). See [`Self::owner`] for a cheap ownership check that
    /// does not load the bundle.
    fn get(&self, token: &str) -> io::Result<ShareState>;

    /// The owner of `token` and whether it is still live (`true`) or already a
    /// tombstone (`false`), without loading a potentially large bundle — used by
    /// the DELETE ownership check. `None` if the token never existed.
    fn owner(&self, token: &str) -> io::Result<Option<([u8; 32], bool)>>;

    /// Convert a live share to a tombstone (bundle bytes dropped), recording
    /// `reason` and `when`. A no-op that returns `false` if the token is missing
    /// or already tombstoned (the original tombstone's reason/when are kept).
    fn tombstone(&self, token: &str, reason: TombstoneReason, when: u64) -> io::Result<bool>;

    /// Housekeeping: tombstone every live share whose `expires_at <= now`, and
    /// delete every tombstone older than `tombstone_max_age_secs`. The relay has
    /// no periodic-task machinery, so this runs on startup; expiry is otherwise
    /// detected lazily on the read path.
    fn sweep(&self, now: u64, tombstone_max_age_secs: u64) -> io::Result<()>;
}

/// In-memory share store. Loses everything on restart. Never errors.
#[derive(Default)]
pub struct MemoryShareStore {
    shares: Mutex<HashMap<String, Entry>>,
}

enum Entry {
    Live {
        owner: [u8; 32],
        sealed_bundle: Vec<u8>,
        created_at: u64,
        expires_at: u64,
    },
    Tombstone {
        owner: [u8; 32],
        reason: TombstoneReason,
        when: u64,
    },
}

impl MemoryShareStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ShareStore for MemoryShareStore {
    fn put(
        &self,
        token: &str,
        owner: [u8; 32],
        sealed_bundle: Vec<u8>,
        created_at: u64,
        expires_at: u64,
    ) -> io::Result<()> {
        self.shares.lock().unwrap().insert(
            token.to_string(),
            Entry::Live {
                owner,
                sealed_bundle,
                created_at,
                expires_at,
            },
        );
        Ok(())
    }

    fn get(&self, token: &str) -> io::Result<ShareState> {
        Ok(match self.shares.lock().unwrap().get(token) {
            None => ShareState::Missing,
            Some(Entry::Live {
                owner,
                sealed_bundle,
                created_at,
                expires_at,
            }) => ShareState::Live {
                owner: *owner,
                sealed_bundle: sealed_bundle.clone(),
                created_at: *created_at,
                expires_at: *expires_at,
            },
            Some(Entry::Tombstone {
                owner,
                reason,
                when,
            }) => ShareState::Tombstone {
                owner: *owner,
                reason: *reason,
                when: *when,
            },
        })
    }

    fn owner(&self, token: &str) -> io::Result<Option<([u8; 32], bool)>> {
        Ok(self.shares.lock().unwrap().get(token).map(|e| match e {
            Entry::Live { owner, .. } => (*owner, true),
            Entry::Tombstone { owner, .. } => (*owner, false),
        }))
    }

    fn tombstone(&self, token: &str, reason: TombstoneReason, when: u64) -> io::Result<bool> {
        let mut shares = self.shares.lock().unwrap();
        match shares.get(token) {
            Some(Entry::Live { owner, .. }) => {
                let owner = *owner;
                shares.insert(
                    token.to_string(),
                    Entry::Tombstone {
                        owner,
                        reason,
                        when,
                    },
                );
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    fn sweep(&self, now: u64, tombstone_max_age_secs: u64) -> io::Result<()> {
        let mut shares = self.shares.lock().unwrap();
        let cutoff = now.saturating_sub(tombstone_max_age_secs);
        // Drop aged-out tombstones; collect live-but-expired tokens to convert.
        let mut expired = Vec::new();
        shares.retain(|token, entry| match entry {
            Entry::Live { expires_at, .. } if *expires_at <= now => {
                expired.push(token.clone());
                true // rewritten as a tombstone below
            }
            Entry::Tombstone { when, .. } => *when >= cutoff,
            _ => true,
        });
        for token in expired {
            if let Some(Entry::Live { owner, .. }) = shares.get(&token) {
                let owner = *owner;
                shares.insert(
                    token,
                    Entry::Tombstone {
                        owner,
                        reason: TombstoneReason::Expired,
                        when: now,
                    },
                );
            }
        }
        Ok(())
    }
}

/// Durable filesystem share store. Each token is one file at
/// `{root}/shares/{token}`, written atomically (stage in a sibling `.tmp` dir,
/// then rename) exactly like [`crate::store::FsStore`]. The first byte tags the
/// record — `0x00` live, `0x01` tombstone — so the read path, the cheap
/// ownership check, and the sweep can all decode from the same file:
///
/// - live: `0x00 ‖ owner(32) ‖ created_at(u64 BE) ‖ expires_at(u64 BE) ‖ bundle`
/// - tombstone: `0x01 ‖ owner(32) ‖ reason(1) ‖ when(u64 BE)`
pub struct FsShareStore {
    dir: PathBuf,
    tmp: PathBuf,
}

const TAG_LIVE: u8 = 0x00;
const TAG_TOMBSTONE: u8 = 0x01;
const REASON_EXPIRED: u8 = 0x00;
const REASON_REVOKED: u8 = 0x01;
const HEADER_LEN: usize = 1 + 32; // tag ‖ owner

impl FsShareStore {
    pub fn new(root: impl AsRef<Path>) -> io::Result<Self> {
        let dir = root.as_ref().join("shares");
        let tmp = dir.join(".tmp");
        fs::create_dir_all(&tmp)?;
        Ok(Self { dir, tmp })
    }

    fn path(&self, token: &str) -> PathBuf {
        self.dir.join(token)
    }

    fn write_atomic(&self, token: &str, bytes: &[u8]) -> io::Result<()> {
        let mut tmp = NamedTempFile::new_in(&self.tmp)?;
        tmp.write_all(bytes)?;
        tmp.flush()?;
        tmp.persist(self.path(token)).map_err(|e| e.error)?;
        Ok(())
    }

    fn encode_live(owner: [u8; 32], created_at: u64, expires_at: u64, bundle: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(HEADER_LEN + 16 + bundle.len());
        out.push(TAG_LIVE);
        out.extend_from_slice(&owner);
        out.extend_from_slice(&created_at.to_be_bytes());
        out.extend_from_slice(&expires_at.to_be_bytes());
        out.extend_from_slice(bundle);
        out
    }

    fn encode_tombstone(owner: [u8; 32], reason: TombstoneReason, when: u64) -> Vec<u8> {
        let mut out = Vec::with_capacity(HEADER_LEN + 1 + 8);
        out.push(TAG_TOMBSTONE);
        out.extend_from_slice(&owner);
        out.push(match reason {
            TombstoneReason::Expired => REASON_EXPIRED,
            TombstoneReason::Revoked => REASON_REVOKED,
        });
        out.extend_from_slice(&when.to_be_bytes());
        out
    }

    fn decode(bytes: &[u8]) -> Option<ShareState> {
        let owner: [u8; 32] = bytes.get(1..HEADER_LEN)?.try_into().ok()?;
        match *bytes.first()? {
            TAG_LIVE => {
                let created_at =
                    u64::from_be_bytes(bytes.get(HEADER_LEN..HEADER_LEN + 8)?.try_into().ok()?);
                let expires_at = u64::from_be_bytes(
                    bytes
                        .get(HEADER_LEN + 8..HEADER_LEN + 16)?
                        .try_into()
                        .ok()?,
                );
                Some(ShareState::Live {
                    owner,
                    sealed_bundle: bytes[HEADER_LEN + 16..].to_vec(),
                    created_at,
                    expires_at,
                })
            }
            TAG_TOMBSTONE => {
                let reason = match *bytes.get(HEADER_LEN)? {
                    REASON_REVOKED => TombstoneReason::Revoked,
                    _ => TombstoneReason::Expired,
                };
                let when =
                    u64::from_be_bytes(bytes.get(HEADER_LEN + 1..HEADER_LEN + 9)?.try_into().ok()?);
                Some(ShareState::Tombstone {
                    owner,
                    reason,
                    when,
                })
            }
            _ => None,
        }
    }
}

impl ShareStore for FsShareStore {
    fn put(
        &self,
        token: &str,
        owner: [u8; 32],
        sealed_bundle: Vec<u8>,
        created_at: u64,
        expires_at: u64,
    ) -> io::Result<()> {
        self.write_atomic(
            token,
            &Self::encode_live(owner, created_at, expires_at, &sealed_bundle),
        )
    }

    fn get(&self, token: &str) -> io::Result<ShareState> {
        match fs::read(self.path(token)) {
            Ok(bytes) => Ok(Self::decode(&bytes).unwrap_or(ShareState::Missing)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(ShareState::Missing),
            Err(e) => Err(e),
        }
    }

    fn owner(&self, token: &str) -> io::Result<Option<([u8; 32], bool)>> {
        // Read only the fixed header (tag ‖ owner), never the bundle body.
        let mut file = match fs::File::open(self.path(token)) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        let mut header = [0u8; HEADER_LEN];
        if file.read_exact(&mut header).is_err() {
            return Ok(None); // truncated/garbage file
        }
        let owner: [u8; 32] = header[1..].try_into().unwrap();
        Ok(Some((owner, header[0] == TAG_LIVE)))
    }

    fn tombstone(&self, token: &str, reason: TombstoneReason, when: u64) -> io::Result<bool> {
        match self.get(token)? {
            ShareState::Live { owner, .. } => {
                self.write_atomic(token, &Self::encode_tombstone(owner, reason, when))?;
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    fn sweep(&self, now: u64, tombstone_max_age_secs: u64) -> io::Result<()> {
        let cutoff = now.saturating_sub(tombstone_max_age_secs);
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        for entry in entries {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue; // skip the .tmp staging dir
            }
            let token = entry.file_name().to_string_lossy().into_owned();
            match self.get(&token)? {
                ShareState::Live { expires_at, .. } if expires_at <= now => {
                    self.tombstone(&token, TombstoneReason::Expired, now)?;
                }
                ShareState::Tombstone { when, .. } if when < cutoff => {
                    match fs::remove_file(self.path(&token)) {
                        Ok(()) => {}
                        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                        Err(e) => return Err(e),
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn owner(b: u8) -> [u8; 32] {
        [b; 32]
    }

    fn assert_live(state: ShareState, expect_owner: [u8; 32], expect_bundle: &[u8]) {
        match state {
            ShareState::Live {
                owner,
                sealed_bundle,
                ..
            } => {
                assert_eq!(owner, expect_owner);
                assert_eq!(sealed_bundle, expect_bundle);
            }
            _ => panic!("expected a live share"),
        }
    }

    fn run_round_trip(store: &dyn ShareStore) {
        let o = owner(1);
        assert!(matches!(
            store.get("tok-never").unwrap(),
            ShareState::Missing
        ));
        assert!(store.owner("tok-never").unwrap().is_none());

        store.put("tok-1", o, b"sealed".to_vec(), 100, 200).unwrap();
        assert_live(store.get("tok-1").unwrap(), o, b"sealed");
        assert_eq!(store.owner("tok-1").unwrap(), Some((o, true)));

        // Tombstone (revoke): bundle bytes gone, tombstone remains.
        assert!(store
            .tombstone("tok-1", TombstoneReason::Revoked, 300)
            .unwrap());
        match store.get("tok-1").unwrap() {
            ShareState::Tombstone {
                owner,
                reason,
                when,
            } => {
                assert_eq!(owner, o);
                assert_eq!(reason, TombstoneReason::Revoked);
                assert_eq!(when, 300);
            }
            _ => panic!("expected a tombstone"),
        }
        assert_eq!(store.owner("tok-1").unwrap(), Some((o, false)));
        // Re-tombstoning a tombstone is a no-op; the original reason/when stay.
        assert!(!store
            .tombstone("tok-1", TombstoneReason::Expired, 999)
            .unwrap());
        match store.get("tok-1").unwrap() {
            ShareState::Tombstone { reason, when, .. } => {
                assert_eq!(reason, TombstoneReason::Revoked);
                assert_eq!(when, 300);
            }
            _ => panic!("expected a tombstone"),
        }
    }

    #[test]
    fn memory_round_trip() {
        run_round_trip(&MemoryShareStore::new());
    }

    #[test]
    fn fs_round_trip() {
        let dir = tempdir().unwrap();
        run_round_trip(&FsShareStore::new(dir.path()).unwrap());
    }

    fn run_sweep(store: &dyn ShareStore) {
        let o = owner(2);
        // A live but past-expiry share becomes a tombstone.
        store.put("expired", o, b"x".to_vec(), 0, 100).unwrap();
        // A live, still-valid share is left alone.
        store.put("valid", o, b"y".to_vec(), 0, 10_000).unwrap();
        // A tombstone created at when=0.
        store.put("old-tomb", o, b"z".to_vec(), 0, 100).unwrap();
        store
            .tombstone("old-tomb", TombstoneReason::Revoked, 0)
            .unwrap();

        let now = 1_000;
        let max_age = 90 * 24 * 60 * 60;
        store.sweep(now, max_age).unwrap();

        // Past-expiry share is now an Expired tombstone stamped with the sweep clock.
        match store.get("expired").unwrap() {
            ShareState::Tombstone { reason, when, .. } => {
                assert_eq!(reason, TombstoneReason::Expired);
                assert_eq!(when, now);
            }
            _ => panic!("expected expired → tombstone"),
        }
        assert_live(store.get("valid").unwrap(), o, b"y");

        // A sweep whose clock is far past the tombstone's age drops it entirely.
        store.sweep(max_age + 1, max_age).unwrap();
        assert!(matches!(
            store.get("old-tomb").unwrap(),
            ShareState::Missing
        ));
    }

    #[test]
    fn memory_sweep() {
        run_sweep(&MemoryShareStore::new());
    }

    #[test]
    fn fs_sweep() {
        let dir = tempdir().unwrap();
        run_sweep(&FsShareStore::new(dir.path()).unwrap());
    }

    #[test]
    fn fs_put_replaces_tombstone() {
        let dir = tempdir().unwrap();
        let store = FsShareStore::new(dir.path()).unwrap();
        let o = owner(3);
        store.put("t", o, b"a".to_vec(), 0, 100).unwrap();
        store.tombstone("t", TombstoneReason::Revoked, 1).unwrap();
        // Create-or-replace revives the token as a fresh live share.
        store.put("t", o, b"b".to_vec(), 2, 500).unwrap();
        assert_live(store.get("t").unwrap(), o, b"b");
    }
}
