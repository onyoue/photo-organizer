use std::path::PathBuf;

use tauri::image::Image;
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::core::{fileops, thumbnail};
use crate::error::{AppError, AppResult};

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

/// Decode the image at `path` to RGBA and load it onto the system
/// clipboard. The clipboard plugin expects raw pixels (not encoded JPEG/
/// PNG bytes), so we decode through the existing thumbnail pipeline —
/// which transparently routes RAW files through rawler's embedded-JPEG
/// preview. EXIF orientation is applied so pasted images come out the
/// right way up.
#[tauri::command]
pub async fn copy_image_to_clipboard(app: AppHandle, path: String) -> AppResult<()> {
    let path_buf = PathBuf::from(&path);
    let (bytes, w, h) = tauri::async_runtime::spawn_blocking(move || -> AppResult<(Vec<u8>, u32, u32)> {
        let oriented = thumbnail::load_oriented_image(&path_buf)?;
        let rgba = oriented.to_rgba8();
        let (w, h) = (rgba.width(), rgba.height());
        Ok((rgba.into_raw(), w, h))
    })
    .await
    .map_err(|e| AppError::InvalidArgument(format!("decode task: {e}")))??;

    let image = Image::new_owned(bytes, w, h);
    app.clipboard()
        .write_image(&image)
        .map_err(|e| AppError::Image(format!("clipboard write: {e}")))?;
    Ok(())
}
