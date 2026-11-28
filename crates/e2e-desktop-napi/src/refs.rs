//! The elements snapshots handed out refs for, held in this process: an
//! action names a ref, and acts on that very element. An element whose
//! control is gone answers `AX_INVALID_ELEMENT`, a stale ref. The oldest
//! refs are dropped first once there are too many.

use crate::ax::Element;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// How many refs stay usable, across every snapshot.
const MAX_REFS: usize = 100_000;

/// One element a ref names, and where it was read.
#[derive(Clone)]
pub struct Entry {
    pub element: Element,
    pub pid: i32,
    pub window: u32,
}

#[derive(Default)]
struct Registry {
    entries: HashMap<String, Entry>,
    order: VecDeque<String>,
}

fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(Mutex::default)
}

/// A snapshot id no other snapshot of this process has: a ref from another run or process never resolves here.
pub fn snapshot_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    static BASE: OnceLock<u64> = OnceLock::new();
    let base =
        *BASE.get_or_init(|| SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_nanos() as u64).unwrap_or(0) ^ (std::process::id() as u64) << 32);
    let next = NEXT.fetch_add(1, Ordering::Relaxed);
    format!("s{}", radix36(base.wrapping_add(next.wrapping_mul(0x9E37_79B9_7F4A_7C15))))
}

fn radix36(mut value: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
        if value == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// Keeps a snapshot's refs, dropping the oldest beyond the cap.
pub fn insert_all(entries: Vec<(String, Entry)>) {
    let mut registry = registry().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    for (reference, entry) in entries {
        registry.order.push_back(reference.clone());
        registry.entries.insert(reference, entry);
    }
    while registry.order.len() > MAX_REFS {
        if let Some(oldest) = registry.order.pop_front() {
            registry.entries.remove(&oldest);
        }
    }
}

pub fn get(reference: &str) -> Option<Entry> {
    registry().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).entries.get(reference).cloned()
}

/// Drops every ref of a process, once it quit.
pub fn forget_process(pid: i32) {
    let mut registry = registry().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    registry.entries.retain(|_, entry| entry.pid != pid);
    let Registry { entries, order } = &mut *registry;
    order.retain(|reference| entries.contains_key(reference));
}
