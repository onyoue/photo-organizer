use std::fs;
use std::path::{Path, PathBuf};

use crate::core::APP_DIR;
use crate::error::AppResult;
use crate::models::bundle::FolderIndex;

const INDEX_FILE: &str = "index.json";
// v2: bundle structure changed when '.' was added as a variant boundary
// (so RAW dev sidecars like <base>.DNG.rawdev.json group correctly).
// v1 caches encode pre-fix groupings — discard them on first read.
pub const INDEX_VERSION: u32 = 2;

pub fn index_path(folder: &Path) -> PathBuf {
    folder.join(APP_DIR).join(INDEX_FILE)
}

/// Read the cached folder index. Returns None on any error or version mismatch
/// — callers should treat that as "no cache" and rescan.
pub fn read(folder: &Path) -> Option<FolderIndex> {
    let path = index_path(folder);
    let bytes = fs::read(&path).ok()?;
    let index: FolderIndex = serde_json::from_slice(&bytes).ok()?;
    if index.version != INDEX_VERSION {
        return None;
    }
    Some(index)
}

pub fn write(folder: &Path, index: &FolderIndex) -> AppResult<()> {
    let path = index_path(folder);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(index)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, path)?;
    Ok(())
}
