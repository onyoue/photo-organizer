use std::path::PathBuf;

use crate::core::sidecar as sidecar_io;
use crate::error::AppResult;
use crate::models::sidecar::BundleSidecar;

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
