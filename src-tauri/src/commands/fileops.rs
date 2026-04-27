use std::path::PathBuf;

use crate::core::fileops;
use crate::error::AppResult;

#[tauri::command]
pub async fn trash_bundle(folder: String, files: Vec<String>) -> AppResult<()> {
    let folder = PathBuf::from(folder);
    tauri::async_runtime::spawn_blocking(move || fileops::trash_files(&folder, &files))
        .await
        .expect("trash task panicked")
}

#[tauri::command]
pub async fn move_bundle(folder: String, files: Vec<String>, dest: String) -> AppResult<()> {
    let folder = PathBuf::from(folder);
    let dest = PathBuf::from(dest);
    tauri::async_runtime::spawn_blocking(move || fileops::move_files(&folder, &files, &dest))
        .await
        .expect("move task panicked")
}

#[tauri::command]
pub async fn copy_bundle(folder: String, files: Vec<String>, dest: String) -> AppResult<()> {
    let folder = PathBuf::from(folder);
    let dest = PathBuf::from(dest);
    tauri::async_runtime::spawn_blocking(move || fileops::copy_files(&folder, &files, &dest))
        .await
        .expect("copy task panicked")
}

#[tauri::command]
pub async fn open_path(path: String) -> AppResult<()> {
    let path = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || fileops::open_path(&path))
        .await
        .expect("open task panicked")
}
