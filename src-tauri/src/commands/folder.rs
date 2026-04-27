use std::path::PathBuf;

use crate::core::scanner;
use crate::error::AppResult;
use crate::models::bundle::FolderIndex;

#[tauri::command]
pub async fn open_folder(path: String, force: Option<bool>) -> AppResult<FolderIndex> {
    let folder = PathBuf::from(path);
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || scanner::scan_folder(&folder, force))
        .await
        .expect("scan task panicked")
}
