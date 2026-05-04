//! Cross-folder image search via cached dHash values.
//!
//! Given an SNS image (a screenshot or downloaded post the model uploaded),
//! find candidate bundles across every scanned folder under a root the
//! photographer points us at. We don't open the actual photo files during
//! search — we read each folder's `.photoorg/index.json` and compare the
//! pre-computed phashes there. That's why the index has to be built first
//! (Phase 1: scan-time computation).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::core::index_cache::INDEX_FILE;
use crate::core::phash;
use crate::core::APP_DIR;
use crate::error::{AppError, AppResult};
use crate::models::bundle::{BundleFile, FileRole, FolderIndex};

/// One bundle-level match returned by `search_image_across_folders`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    /// Absolute path of the folder this bundle lives in.
    pub folder_path: String,
    pub bundle_id: String,
    pub base_name: String,
    /// Hamming distance from the target hash. 0 = identical, lower is better.
    pub distance: u32,
    /// File path (relative to `folder_path`) to use as a thumbnail source.
    /// Picks developed → in-camera JPG → RAW the same way the main UI does.
    pub thumbnail_source: Option<String>,
}

/// Wrapper so the frontend can show a "checked N folders, M had pHashes" hint.
#[derive(Debug, Clone, Serialize)]
pub struct SearchResults {
    pub hits: Vec<SearchHit>,
    /// How many `.photoorg/index.json` files we actually opened.
    pub folders_scanned: usize,
    /// Of those, how many had at least one phash. Folders scanned before
    /// pHash support landed will be 0; show a hint to re-scan them.
    pub folders_with_phash: usize,
    /// Total bundles seen (with or without phash).
    pub bundles_total: usize,
}

/// Compute a dHash for a stand-alone image file. Used by the search dialog
/// to hash whatever the user drops / picks before invoking
/// `search_image_across_folders`. Returns the same 16-char hex format
/// stored in BundleSummary so the two are directly comparable.
#[tauri::command]
pub async fn compute_phash_for_image(path: String) -> AppResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let img = image::open(&path)
            .map_err(|e| AppError::Image(format!("open {path}: {e}")))?;
        Ok(format!("{:016x}", phash::dhash(&img)))
    })
    .await
    .map_err(|e| AppError::InvalidArgument(format!("hash task: {e}")))?
}

/// Walk subdirectories under `root` collecting every `.photoorg/index.json`
/// we find, then rank each bundle's stored phash against `target_phash`.
/// Top-N (by ascending distance, tie-broken by basename) are returned.
#[tauri::command]
pub async fn search_image_across_folders(
    root: String,
    target_phash: String,
    max_results: Option<usize>,
    max_distance: Option<u32>,
) -> AppResult<SearchResults> {
    let target = u64::from_str_radix(target_phash.trim_start_matches("0x"), 16)
        .map_err(|e| AppError::InvalidArgument(format!("invalid phash '{target_phash}': {e}")))?;
    let max_results = max_results.unwrap_or(20).max(1);
    let max_distance = max_distance.unwrap_or(15).min(64);
    let root_path = PathBuf::from(&root);

    tauri::async_runtime::spawn_blocking(move || {
        let mut index_paths = Vec::new();
        walk_for_index(&root_path, &mut index_paths, 0)?;

        let mut all_hits: Vec<SearchHit> = Vec::new();
        let mut folders_scanned = 0usize;
        let mut folders_with_phash = 0usize;
        let mut bundles_total = 0usize;

        for index_path in index_paths {
            folders_scanned += 1;
            let bytes = match fs::read(&index_path) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let index: FolderIndex = match serde_json::from_slice(&bytes) {
                Ok(i) => i,
                Err(_) => continue,
            };
            let folder_path = PathBuf::from(&index.folder_path);
            let mut had_any_phash = false;
            for b in &index.bundles {
                bundles_total += 1;
                let Some(h) = b.phash else { continue };
                had_any_phash = true;
                let dist = phash::hamming_distance(target, h);
                if dist <= max_distance {
                    all_hits.push(SearchHit {
                        folder_path: folder_path.display().to_string(),
                        bundle_id: b.bundle_id.clone(),
                        base_name: b.base_name.clone(),
                        distance: dist,
                        thumbnail_source: pick_thumbnail_source(&b.files)
                            .map(|p| folder_path.join(p).display().to_string()),
                    });
                }
            }
            if had_any_phash {
                folders_with_phash += 1;
            }
        }

        all_hits.sort_by(|a, b| a.distance.cmp(&b.distance).then(a.base_name.cmp(&b.base_name)));
        all_hits.truncate(max_results);

        Ok(SearchResults {
            hits: all_hits,
            folders_scanned,
            folders_with_phash,
            bundles_total,
        })
    })
    .await
    .map_err(|e| AppError::InvalidArgument(format!("search task: {e}")))?
}

/// Recursive directory walk. Bounded by depth and skips the kind of dirs
/// that won't contain photo folders (dotfiles, build dirs, system dirs).
fn walk_for_index(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) -> AppResult<()> {
    // 8 levels is generous for a typical "photos by year/month/shoot" layout
    // and guards against accidentally pointing at a system root.
    const MAX_DEPTH: usize = 8;
    if depth > MAX_DEPTH {
        return Ok(());
    }
    let candidate = dir.join(APP_DIR).join(INDEX_FILE);
    if candidate.is_file() {
        out.push(candidate);
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(()), // permission denied / not a dir → skip silently
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && !is_skip_dir(&path) {
            walk_for_index(&path, out, depth + 1)?;
        }
    }
    Ok(())
}

fn is_skip_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| {
            // The cache dir itself is fine to descend (we want index.json),
            // but skip everything else that starts with a dot — Recycle.Bin
            // / .git / .Trash / .DS_Store containers are noise.
            (n.starts_with('.') && n != APP_DIR)
                || n == "node_modules"
                || n == "target"
                || n == "$RECYCLE.BIN"
                || n == "System Volume Information"
        })
        .unwrap_or(false)
}

/// Pick the file in a bundle that best represents it visually. Mirrors the
/// frontend's `selectThumbnailSource` logic so the search dialog and the
/// main UI agree on which file a bundle "is".
fn pick_thumbnail_source(files: &[BundleFile]) -> Option<&str> {
    files
        .iter()
        .find(|f| f.role == FileRole::Developed)
        .or_else(|| files.iter().find(|f| f.role == FileRole::Jpeg))
        .or_else(|| files.iter().find(|f| f.role == FileRole::Raw))
        .map(|f| f.path.as_str())
}
