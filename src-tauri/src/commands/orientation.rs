use std::path::PathBuf;

use crate::core::orientation::{self, Direction, RotateOutcome};
use crate::error::{AppError, AppResult};

/// Rotate every supported image in `files` 90° CW or CCW by patching
/// only the EXIF Orientation tag — lossless, no pixel re-encoding. RAW
/// files in the bundle are returned as "skipped" so the UI can show a
/// note ("rotate the RAW via your developer").
#[tauri::command]
pub async fn rotate_bundle_orientation(
    folder: String,
    files: Vec<String>,
    direction: String,
) -> AppResult<Vec<RotateOutcome>> {
    let dir = match direction.as_str() {
        "cw" => Direction::Cw,
        "ccw" => Direction::Ccw,
        other => {
            return Err(AppError::InvalidArgument(format!(
                "direction must be 'cw' or 'ccw', got {other}"
            )))
        }
    };
    let folder_buf = PathBuf::from(folder);
    tauri::async_runtime::spawn_blocking(move || {
        orientation::rotate_files(&folder_buf, &files, dir)
    })
    .await
    .map_err(|e| AppError::InvalidArgument(format!("rotate task: {e}")))
}
