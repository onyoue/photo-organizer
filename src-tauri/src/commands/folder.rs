use std::path::{Path, PathBuf};

use crate::core::scanner;
use crate::error::AppResult;
use crate::models::bundle::FolderIndex;

/// Normalise a path that the user might have dragged onto the window. If they
/// drop a file (a JPG, RAW, anything), open its parent directory instead of
/// erroring out — that's almost always what they meant.
fn resolve_dropped_path(path: &Path) -> PathBuf {
    if path.is_file() {
        path.parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| path.to_path_buf())
    } else {
        path.to_path_buf()
    }
}

#[tauri::command]
pub async fn open_folder(path: String, force: Option<bool>) -> AppResult<FolderIndex> {
    let folder = resolve_dropped_path(&PathBuf::from(path));
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || scanner::scan_folder(&folder, force))
        .await
        .expect("scan task panicked")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use ulid::Ulid;

    fn tempdir() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("photoorg_drop_{}", Ulid::new()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn resolves_file_to_parent_directory() {
        let dir = tempdir();
        let file = dir.join("photo.JPG");
        File::create(&file).unwrap();
        assert_eq!(resolve_dropped_path(&file), dir);
    }

    #[test]
    fn keeps_directory_as_is() {
        let dir = tempdir();
        assert_eq!(resolve_dropped_path(&dir), dir);
    }

    #[test]
    fn returns_unchanged_for_nonexistent_path() {
        // is_file() and is_dir() both return false for missing paths — fall
        // through to the original input so the scanner can surface a clean
        // NotADirectory error.
        let nonexistent = PathBuf::from("/nope/this/does/not/exist");
        assert_eq!(resolve_dropped_path(&nonexistent), nonexistent);
    }
}
