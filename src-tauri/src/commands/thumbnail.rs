use std::path::PathBuf;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::core::thumbnail;
use crate::error::AppResult;

#[derive(Debug, Deserialize)]
pub struct ThumbnailRequest {
    pub bundle_id: String,
    pub file: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThumbnailReadyEvent {
    pub bundle_id: String,
    pub path: Option<String>,
    pub error: Option<String>,
}

fn resolve(folder: &PathBuf, file: &str) -> PathBuf {
    let raw = PathBuf::from(file);
    if raw.is_absolute() {
        raw
    } else {
        folder.join(raw)
    }
}

#[tauri::command]
pub async fn ensure_thumbnail(folder: String, file: String) -> AppResult<String> {
    let folder = PathBuf::from(folder);
    let source = resolve(&folder, &file);
    tauri::async_runtime::spawn_blocking(move || {
        thumbnail::ensure_thumbnail(&folder, &source).map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .expect("thumbnail task panicked")
}

#[tauri::command]
pub async fn generate_thumbnails(
    app: AppHandle,
    folder: String,
    requests: Vec<ThumbnailRequest>,
) -> AppResult<()> {
    let folder = PathBuf::from(folder);

    tauri::async_runtime::spawn_blocking(move || {
        requests.par_iter().for_each(|req| {
            let source = resolve(&folder, &req.file);
            let event = match thumbnail::ensure_thumbnail(&folder, &source) {
                Ok(p) => ThumbnailReadyEvent {
                    bundle_id: req.bundle_id.clone(),
                    path: Some(p.to_string_lossy().into_owned()),
                    error: None,
                },
                Err(e) => ThumbnailReadyEvent {
                    bundle_id: req.bundle_id.clone(),
                    path: None,
                    error: Some(e.to_string()),
                },
            };
            // Best-effort: if the webview is gone we just stop receiving.
            let _ = app.emit("thumbnail-ready", event);
        });
    })
    .await
    .expect("thumbnail batch task panicked");
    Ok(())
}
