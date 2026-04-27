use std::path::PathBuf;

use crate::core::thumbnail;
use crate::error::AppResult;

#[tauri::command]
pub async fn ensure_thumbnail(folder: String, file: String) -> AppResult<String> {
    let folder = PathBuf::from(folder);
    let raw = PathBuf::from(&file);
    let source = if raw.is_absolute() {
        raw
    } else {
        folder.join(raw)
    };

    tauri::async_runtime::spawn_blocking(move || {
        thumbnail::ensure_thumbnail(&folder, &source).map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .expect("thumbnail task panicked")
}
