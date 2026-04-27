use std::path::PathBuf;

use crate::core::scanner;
use crate::error::AppResult;
use crate::models::bundle::FolderIndex;

#[tauri::command]
pub async fn open_folder(path: String) -> AppResult<FolderIndex> {
    let folder = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || scanner::scan_folder(&folder))
        .await
        .expect("scan task panicked")
}
