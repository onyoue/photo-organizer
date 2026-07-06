use std::fs;
use std::path::{Path, PathBuf};

use crate::core::scanner;
use crate::error::{AppError, AppResult};
use crate::models::bundle::FolderIndex;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct FolderEntry {
    pub name: String,
    pub path: String,
    pub has_children: bool,
}

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

#[tauri::command]
pub async fn list_child_folders(path: String) -> AppResult<Vec<FolderEntry>> {
    let folder = resolve_dropped_path(&PathBuf::from(path));
    tauri::async_runtime::spawn_blocking(move || list_child_folders_inner(&folder))
        .await
        .expect("folder list task panicked")
}

fn list_child_folders_inner(folder: &Path) -> AppResult<Vec<FolderEntry>> {
    if !folder.is_dir() {
        return Err(AppError::NotADirectory(folder.display().to_string()));
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(folder)? {
        let Ok(entry) = entry else {
            continue;
        };
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if should_skip_folder(&name) {
            continue;
        }
        let path = entry.path();
        entries.push(FolderEntry {
            name,
            path: path.display().to_string(),
            has_children: has_visible_child_folder(&path),
        });
    }

    entries.sort_by_key(|e| e.name.to_lowercase());
    Ok(entries)
}

fn has_visible_child_folder(folder: &Path) -> bool {
    let Ok(entries) = fs::read_dir(folder) else {
        return false;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !should_skip_folder(&name) {
            return true;
        }
    }
    false
}

fn should_skip_folder(name: &str) -> bool {
    name.starts_with('.')
        || name.eq_ignore_ascii_case("$RECYCLE.BIN")
        || name.eq_ignore_ascii_case("System Volume Information")
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

    #[test]
    fn lists_visible_child_folders_sorted() {
        let dir = tempdir();
        std::fs::create_dir_all(dir.join("zeta")).unwrap();
        std::fs::create_dir_all(dir.join("alpha").join("nested")).unwrap();
        std::fs::create_dir_all(dir.join(".photoorg")).unwrap();
        File::create(dir.join("photo.JPG")).unwrap();

        let entries = list_child_folders_inner(&dir).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "alpha");
        assert!(entries[0].has_children);
        assert_eq!(entries[1].name, "zeta");
        assert!(!entries[1].has_children);
    }
}
