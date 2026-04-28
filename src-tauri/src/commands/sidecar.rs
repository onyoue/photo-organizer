use std::path::PathBuf;

use crate::core::sidecar::{self as sidecar_io, BundleRef};
use crate::error::{AppError, AppResult};
use crate::models::sidecar::{BundleSidecar, Flag};

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
    tauri::async_runtime::spawn_blocking(move || {
        for b in bundles {
            sidecar_io::apply_rating(&folder, &b, rating)?;
        }
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
    tauri::async_runtime::spawn_blocking(move || {
        for b in bundles {
            sidecar_io::apply_flag(&folder, &b, flag)?;
        }
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
    tauri::async_runtime::spawn_blocking(move || {
        for b in bundles {
            sidecar_io::apply_tags(&folder, &b, tags.clone())?;
        }
        Ok(())
    })
    .await
    .expect("tags task panicked")
}
