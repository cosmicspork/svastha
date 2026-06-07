//! Blob storage, scoped by owner. The relay stores opaque ciphertext keyed by
//! `(owner public key, id)`; it never inspects a blob's contents. The trait is
//! the seam a durable backend (filesystem, sqlite) drops into later; this PR
//! ships only the in-memory implementation.

use std::collections::HashMap;
use std::sync::Mutex;

/// Each owner's blobs, by id.
type Owners = HashMap<[u8; 32], HashMap<String, Vec<u8>>>;

/// A store of opaque encrypted blobs, partitioned by owner so one identity can
/// never read another's data. Implementations must be cheap to share across
/// request handlers (`Send + Sync`, interior mutability).
pub trait BlobStore: Send + Sync {
    /// Store (or replace) a blob for an owner.
    fn put(&self, owner: &[u8; 32], id: &str, blob: Vec<u8>);
    /// Fetch a blob, or `None` if this owner has no blob under `id`.
    fn get(&self, owner: &[u8; 32], id: &str) -> Option<Vec<u8>>;
    /// List the ids this owner has stored.
    fn list(&self, owner: &[u8; 32]) -> Vec<String>;
    /// Delete a blob; returns whether one existed.
    fn delete(&self, owner: &[u8; 32], id: &str) -> bool;
}

/// In-memory blob store. Loses everything on restart — fine for tests and a
/// throwaway relay, not for real backup; a durable store replaces it next.
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
    fn put(&self, owner: &[u8; 32], id: &str, blob: Vec<u8>) {
        self.owners
            .lock()
            .unwrap()
            .entry(*owner)
            .or_default()
            .insert(id.to_string(), blob);
    }

    fn get(&self, owner: &[u8; 32], id: &str) -> Option<Vec<u8>> {
        self.owners
            .lock()
            .unwrap()
            .get(owner)
            .and_then(|blobs| blobs.get(id))
            .cloned()
    }

    fn list(&self, owner: &[u8; 32]) -> Vec<String> {
        self.owners
            .lock()
            .unwrap()
            .get(owner)
            .map(|blobs| blobs.keys().cloned().collect())
            .unwrap_or_default()
    }

    fn delete(&self, owner: &[u8; 32], id: &str) -> bool {
        self.owners
            .lock()
            .unwrap()
            .get_mut(owner)
            .is_some_and(|blobs| blobs.remove(id).is_some())
    }
}
