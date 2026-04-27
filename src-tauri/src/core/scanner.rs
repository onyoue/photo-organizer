use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::Path;
use std::time::SystemTime;

use chrono::{DateTime, Utc};
use ulid::Ulid;

use crate::core::index_cache::{self, INDEX_VERSION};
use crate::core::sidecar as sidecar_io;
use crate::core::APP_DIR;
use crate::error::{AppError, AppResult};
use crate::models::bundle::{BundleFile, BundleSummary, FileRole, FolderIndex};
use crate::models::sidecar::{BundleSidecar, PostBy};

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

fn folder_mtime_iso(folder: &Path) -> AppResult<String> {
    let metadata = fs::metadata(folder)?;
    Ok(systemtime_to_iso(metadata.modified()?))
}

pub fn scan_folder(folder: &Path, force_rescan: bool) -> AppResult<FolderIndex> {
    if !folder.is_dir() {
        return Err(AppError::NotADirectory(folder.display().to_string()));
    }

    // Pre-create .photoorg/ before reading folder mtime — otherwise the
    // index_cache::write below would create it lazily and bump the parent
    // folder's mtime, making the freshly-cached folder_mtime stale on the
    // very next call.
    fs::create_dir_all(folder.join(APP_DIR))?;

    let current_mtime = folder_mtime_iso(folder)?;
    let prior = index_cache::read(folder);

    if !force_rescan {
        if let Some(ref cached) = prior {
            if cached.folder_mtime == current_mtime {
                return Ok(cached.clone());
            }
        }
    }

    // Walk fresh, but always feed in any prior cache so bundle_ids stay stable
    // across rescans (folder change, force, version mismatch — all cases).
    let index = walk_folder(folder, current_mtime, prior.as_ref())?;
    index_cache::write(folder, &index)?;
    Ok(index)
}

fn walk_folder(
    folder: &Path,
    folder_mtime: String,
    prior: Option<&FolderIndex>,
) -> AppResult<FolderIndex> {
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

    // Reuse bundle_ids from prior cache when basename still exists.
    let prior_id_by_name: HashMap<&str, &str> = prior
        .map(|p| {
            p.bundles
                .iter()
                .map(|b| (b.base_name.as_str(), b.bundle_id.as_str()))
                .collect()
        })
        .unwrap_or_default();

    let mut bundles: Vec<BundleSummary> = groups
        .into_iter()
        .map(|(base_name, mut files)| {
            files.sort_by_key(|f| (role_sort_key(f.role), f.path.clone()));
            let bundle_id = prior_id_by_name
                .get(base_name.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| Ulid::new().to_string());

            // A corrupt sidecar shouldn't break a folder scan — treat as no posts.
            let sidecar = sidecar_io::read(folder, &base_name).ok().flatten();
            let (has_posts, post_platforms, has_model_post) = collect_post_info(sidecar.as_ref());

            BundleSummary {
                bundle_id,
                base_name,
                files,
                has_posts,
                post_platforms,
                has_model_post,
            }
        })
        .collect();

    bundles.sort_by(|a, b| a.base_name.cmp(&b.base_name));

    Ok(FolderIndex {
        version: INDEX_VERSION,
        scanned_at: Utc::now().to_rfc3339(),
        folder_path: folder.display().to_string(),
        folder_mtime,
        bundles,
    })
}

fn collect_post_info(sidecar: Option<&BundleSidecar>) -> (bool, Vec<String>, bool) {
    let Some(s) = sidecar else {
        return (false, vec![], false);
    };
    if s.posts.is_empty() {
        return (false, vec![], false);
    }
    let mut platforms: BTreeSet<&'static str> = BTreeSet::new();
    let mut has_model = false;
    for post in &s.posts {
        platforms.insert(post.platform.as_str());
        if post.by == PostBy::Model {
            has_model = true;
        }
    }
    (
        true,
        platforms.into_iter().map(String::from).collect(),
        has_model,
    )
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

    fn tempdir_for_test() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("photoorg_scanner_{}", Ulid::new()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn groups_files_by_basename() {
        let tmp = tempdir_for_test();
        touch(&tmp, "DSC_0123.DNG", b"raw");
        touch(&tmp, "DSC_0123.JPG", b"jpg");
        touch(&tmp, "DSC_0124.JPG", b"jpg2");
        touch(&tmp, "notes.txt", b"hi");

        let idx = scan_folder(&tmp, false).unwrap();

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

        let idx = scan_folder(&tmp, false).unwrap();
        assert_eq!(idx.bundles.len(), 1);
        assert_eq!(idx.bundles[0].base_name, "DSC_0123");
        assert_eq!(idx.bundles[0].files.len(), 1);
    }

    #[test]
    fn reads_post_info_from_sidecar() {
        use crate::core::sidecar::SIDECAR_VERSION;
        use crate::models::sidecar::{BundleSidecar, PostRecord, Platform};

        let tmp = tempdir_for_test();
        touch(&tmp, "DSC_0001.JPG", b"jpg");
        touch(&tmp, "DSC_0002.JPG", b"jpg");

        // Bundle 1 has a self post on X and a model post on Instagram.
        let sidecar = BundleSidecar {
            version: SIDECAR_VERSION,
            bundle_id: Ulid::new().to_string(),
            base_name: "DSC_0001".into(),
            rating: None,
            flag: None,
            tags: vec![],
            posts: vec![
                PostRecord {
                    id: Ulid::new().to_string(),
                    platform: Platform::X,
                    url: "https://x.com/me".into(),
                    posted_at: None,
                    by: PostBy::Self_,
                    posted_by_handle: None,
                    note: None,
                },
                PostRecord {
                    id: Ulid::new().to_string(),
                    platform: Platform::Instagram,
                    url: "https://instagram.com/model".into(),
                    posted_at: None,
                    by: PostBy::Model,
                    posted_by_handle: Some("@m".into()),
                    note: None,
                },
            ],
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        sidecar_io::write(&tmp, &sidecar).unwrap();

        let idx = scan_folder(&tmp, false).unwrap();
        let b1 = idx.bundles.iter().find(|b| b.base_name == "DSC_0001").unwrap();
        assert!(b1.has_posts);
        assert_eq!(b1.post_platforms, vec!["instagram", "x"]); // BTreeSet → sorted
        assert!(b1.has_model_post);

        let b2 = idx.bundles.iter().find(|b| b.base_name == "DSC_0002").unwrap();
        assert!(!b2.has_posts);
        assert!(b2.post_platforms.is_empty());
        assert!(!b2.has_model_post);
    }

    #[test]
    fn writes_and_returns_cache_on_unchanged_folder() {
        let tmp = tempdir_for_test();
        touch(&tmp, "a.jpg", b"x");

        let first = scan_folder(&tmp, false).unwrap();
        // index.json should exist after first scan.
        assert!(index_cache::index_path(&tmp).exists());

        let second = scan_folder(&tmp, false).unwrap();
        // Same scanned_at means we got the cached struct verbatim, not a new walk.
        assert_eq!(first.scanned_at, second.scanned_at);
        assert_eq!(first.bundles[0].bundle_id, second.bundles[0].bundle_id);
    }

    #[test]
    fn force_rescan_bypasses_cache_and_reuses_ids() {
        let tmp = tempdir_for_test();
        touch(&tmp, "a.jpg", b"x");

        let first = scan_folder(&tmp, false).unwrap();
        let original_id = first.bundles[0].bundle_id.clone();

        let forced = scan_folder(&tmp, true).unwrap();
        // Walk happened again — scanned_at advances.
        assert_ne!(forced.scanned_at, first.scanned_at);
        // But the bundle_id is preserved across rescans (basename match).
        assert_eq!(forced.bundles[0].bundle_id, original_id);
    }
}
