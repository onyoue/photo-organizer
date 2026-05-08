use std::path::PathBuf;

use crate::core::exif::{self, ExposureSummary};
use crate::error::{AppError, AppResult};

/// Read a compact EXIF summary from the first path in `paths` that yields
/// usable data. The frontend passes multiple candidates (JPG → RAW →
/// developed) because some delivery JPGs have their EXIF stripped during
/// export — falling through to the RAW recovers the original camera tags.
/// Returns None when *no* candidate had parseable EXIF; the frontend then
/// hides the panel rather than showing an error.
#[tauri::command]
pub async fn read_image_exif(paths: Vec<String>) -> AppResult<Option<ExposureSummary>> {
    tauri::async_runtime::spawn_blocking(move || {
        for p in &paths {
            let buf = PathBuf::from(p);
            if let Some(summary) = exif::read_summary(&buf) {
                return Some(summary);
            }
        }
        None
    })
    .await
    .map_err(|e| AppError::InvalidArgument(format!("exif task: {e}")))
}
