use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::SystemTime;

use chrono::{DateTime, Utc};
use ulid::Ulid;

use crate::error::{AppError, AppResult};
use crate::models::bundle::{BundleFile, BundleSummary, FileRole, FolderIndex};

const SIDECAR_SUFFIX: &str = ".photoorg.json";

fn classify_extension(ext: &str) -> FileRole {
    match ext.to_ascii_lowercase().as_str() {
        "dng" | "raf" | "pef" | "arw" | "cr3" | "nef" | "raw" => FileRole::Raw,
        "jpg" | "jpeg" => FileRole::Jpeg,
        "xmp" | "pp3" | "dop" | "rwl" => FileRole::Sidecar,
        _ => FileRole::Unknown,
    }
}

fn systemtime_to_iso(t: SystemTime) -> String {
    let dt: DateTime<Utc> = t.into();
    dt.to_rfc3339()
}

pub fn scan_folder(folder: &Path) -> AppResult<FolderIndex> {
    if !folder.is_dir() {
        return Err(AppError::NotADirectory(folder.display().to_string()));
    }

    let mut groups: BTreeMap<String, Vec<BundleFile>> = BTreeMap::new();

    for entry in fs::read_dir(folder)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = entry.metadata()?;

        if !metadata.is_file() {
            continue;
        }

        let file_name = match path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };

        // Hidden files (dotfiles) and our own sidecar JSONs are skipped from the listing.
        if file_name.starts_with('.') || file_name.ends_with(SIDECAR_SUFFIX) {
            continue;
        }

        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };

        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
        let role = classify_extension(ext);

        let mtime = metadata
            .modified()
            .map(systemtime_to_iso)
            .unwrap_or_default();

        groups.entry(stem).or_default().push(BundleFile {
            role,
            path: file_name,
            size: metadata.len(),
            mtime,
        });
    }

    let mut bundles: Vec<BundleSummary> = groups
        .into_iter()
        .map(|(base_name, mut files)| {
            // Stable per-bundle file order: RAW, JPEG, sidecars, developed, unknown.
            files.sort_by_key(|f| (role_sort_key(f.role), f.path.clone()));
            BundleSummary {
                bundle_id: Ulid::new().to_string(),
                base_name,
                files,
            }
        })
        .collect();

    bundles.sort_by(|a, b| a.base_name.cmp(&b.base_name));

    Ok(FolderIndex {
        version: 1,
        scanned_at: Utc::now().to_rfc3339(),
        folder_path: folder.display().to_string(),
        bundles,
    })
}

fn role_sort_key(role: FileRole) -> u8 {
    match role {
        FileRole::Raw => 0,
        FileRole::Jpeg => 1,
        FileRole::Sidecar => 2,
        FileRole::Developed => 3,
        FileRole::Unknown => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    fn touch(dir: &Path, name: &str, contents: &[u8]) {
        let mut f = File::create(dir.join(name)).unwrap();
        f.write_all(contents).unwrap();
    }

    #[test]
    fn groups_files_by_basename() {
        let tmp = tempdir_for_test();
        touch(&tmp, "DSC_0123.DNG", b"raw");
        touch(&tmp, "DSC_0123.JPG", b"jpg");
        touch(&tmp, "DSC_0124.JPG", b"jpg2");
        touch(&tmp, "notes.txt", b"hi");

        let idx = scan_folder(&tmp).unwrap();

        assert_eq!(idx.bundles.len(), 3);
        let dsc123 = idx.bundles.iter().find(|b| b.base_name == "DSC_0123").unwrap();
        assert_eq!(dsc123.files.len(), 2);
        assert!(dsc123.files.iter().any(|f| f.role == FileRole::Raw));
        assert!(dsc123.files.iter().any(|f| f.role == FileRole::Jpeg));

        let notes = idx.bundles.iter().find(|b| b.base_name == "notes").unwrap();
        assert_eq!(notes.files[0].role, FileRole::Unknown);
    }

    #[test]
    fn skips_sidecar_and_hidden() {
        let tmp = tempdir_for_test();
        touch(&tmp, "DSC_0123.JPG", b"jpg");
        touch(&tmp, "DSC_0123.photoorg.json", b"{}");
        touch(&tmp, ".DS_Store", b"x");

        let idx = scan_folder(&tmp).unwrap();
        assert_eq!(idx.bundles.len(), 1);
        assert_eq!(idx.bundles[0].base_name, "DSC_0123");
        assert_eq!(idx.bundles[0].files.len(), 1);
    }

    fn tempdir_for_test() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("photoorg_test_{}", Ulid::new()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }
}
