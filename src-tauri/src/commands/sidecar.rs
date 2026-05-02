use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::core::sidecar::{self as sidecar_io, BundleRef};
use crate::core::index_cache;
use crate::error::{AppError, AppResult};
use crate::models::bundle::BundleSummary;
use crate::models::sidecar::{BundleSidecar, Flag};

/// Mutate the cached folder index in place after a sidecar update so the
/// next folder open doesn't have to depend on the OS bumping the folder's
/// mtime to invalidate the cache (NTFS in particular can be flaky here).
/// No-op if the cache file doesn't exist yet — next scan will build it
/// fresh anyway.
fn patch_cache_for_bundles<F>(
    folder: &Path,
    bundles: &[BundleRef],
    mut patch: F,
) -> AppResult<()>
where
    F: FnMut(&mut BundleSummary),
{
    let Some(mut cached) = index_cache::read(folder) else { return Ok(()) };
    let ids: HashSet<&str> = bundles.iter().map(|b| b.bundle_id.as_str()).collect();
    let mut touched = false;
    for b in &mut cached.bundles {
        if ids.contains(b.bundle_id.as_str()) {
            patch(b);
            touched = true;
        }
    }
    if touched {
        index_cache::write(folder, &cached)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_bundle_sidecar(
    folder: String,
    base_name: String,
) -> AppResult<Option<BundleSidecar>> {
    let folder = PathBuf::from(folder);
    tauri::async_runtime::spawn_blocking(move || sidecar_io::read(&folder, &base_name))
        .await
        .expect("sidecar read task panicked")
}

#[tauri::command]
pub async fn save_bundle_sidecar(folder: String, sidecar: BundleSidecar) -> AppResult<()> {
    let folder = PathBuf::from(folder);
    tauri::async_runtime::spawn_blocking(move || {
        // §7.3: don't leave empty sidecar files lying around.
        if sidecar.is_empty_payload() {
            sidecar_io::delete(&folder, &sidecar.base_name)
        } else {
            sidecar_io::write(&folder, &sidecar)
        }
    })
    .await
    .expect("sidecar write task panicked")
}

#[tauri::command]
pub async fn set_bundle_rating(
    folder: String,
    bundles: Vec<BundleRef>,
    rating: Option<u8>,
) -> AppResult<()> {
    if let Some(r) = rating {
        if r > 5 {
            return Err(AppError::InvalidArgument(format!(
                "rating must be 0..=5, got {r}"
            )));
        }
    }
    let folder = PathBuf::from(folder);
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        for b in &bundles {
            sidecar_io::apply_rating(&folder, b, rating)?;
        }
        patch_cache_for_bundles(&folder, &bundles, |b| b.rating = rating)?;
        Ok(())
    })
    .await
    .expect("rating task panicked")
}

#[tauri::command]
pub async fn set_bundle_flag(
    folder: String,
    bundles: Vec<BundleRef>,
    flag: Option<Flag>,
) -> AppResult<()> {
    let folder = PathBuf::from(folder);
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        for b in &bundles {
            sidecar_io::apply_flag(&folder, b, flag)?;
        }
        patch_cache_for_bundles(&folder, &bundles, |b| b.flag = flag)?;
        Ok(())
    })
    .await
    .expect("flag task panicked")
}

#[tauri::command]
pub async fn set_bundle_tags(
    folder: String,
    bundles: Vec<BundleRef>,
    tags: Vec<String>,
) -> AppResult<()> {
    let folder = PathBuf::from(folder);
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        for b in &bundles {
            sidecar_io::apply_tags(&folder, b, tags.clone())?;
        }
        patch_cache_for_bundles(&folder, &bundles, |b| b.tags = tags.clone())?;
        Ok(())
    })
    .await
    .expect("tags task panicked")
}
