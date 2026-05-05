use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::core::index_cache;
use crate::core::thumbnail;
use crate::error::{AppError, AppResult};

const SIDECAR_SUFFIX: &str = ".photoorg.json";

/// Given a list of bundle data files, return that list plus any
/// `<base_name>.photoorg.json` sidecar that exists on disk for the same
/// basename. The user expects post metadata to follow when they reorganise
/// their picks into select/ or delivery/ subfolders.
fn augment_with_sidecars(folder: &Path, files: &[String]) -> Vec<String> {
    let mut all: BTreeSet<String> = files.iter().cloned().collect();
    for f in files {
        let Some(stem) = Path::new(f).file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        // Don't recurse into the sidecar's own stem ("DSC_0123.photoorg") in
        // the unlikely case the caller already included one.
        if stem.ends_with(".photoorg") {
            continue;
        }
        let sidecar = format!("{stem}{SIDECAR_SUFFIX}");
        if folder.join(&sidecar).exists() {
            all.insert(sidecar);
        }
    }
    all.into_iter().collect()
}

/// Map each existing thumbnail cache file (under `<folder>/.photoorg/thumbs/`)
/// for the given data files. Computed BEFORE any destructive op so the
/// cache can be migrated/cleaned even after the source files are gone.
fn collect_existing_thumbs(folder: &Path, files: &[String]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for f in files {
        // Skip sidecars — they don't have thumbnails.
        if f.ends_with(SIDECAR_SUFFIX) {
            continue;
        }
        let source = folder.join(f);
        if let Some(thumb) = thumbnail::cached_thumb_path(folder, &source) {
            if thumb.exists() {
                out.push(thumb);
            }
        }
    }
    out
}

pub fn trash_files(folder: &Path, files: &[String]) -> AppResult<()> {
    // Compute cache paths BEFORE trashing — afterwards the source files
    // are gone and we can no longer derive their hashes.
    let orphan_thumbs = collect_existing_thumbs(folder, files);

    let augmented = augment_with_sidecars(folder, files);
    if augmented.is_empty() {
        return Ok(());
    }
    let paths: Vec<PathBuf> = augmented.iter().map(|f| folder.join(f)).collect();
    trash::delete_all(paths.iter().map(|p| p.as_path()))
        .map_err(|e| AppError::Trash(e.to_string()))?;

    // Best-effort thumb cleanup — derived data, no need to surface failures.
    for thumb in orphan_thumbs {
        let _ = fs::remove_file(thumb);
    }
    // Drop the trashed files from the cached folder index so the next
    // app launch doesn't render placeholder tiles for files that no
    // longer exist. NTFS occasionally fails to bump folder mtime on a
    // shell-level recycle, which would otherwise let the stale cache
    // survive — same write-through pattern we use after sidecar updates.
    let _ = patch_cache_remove_files(folder, files);
    Ok(())
}

fn validate_dest(folder: &Path, dest: &Path) -> AppResult<()> {
    if !dest.is_dir() {
        return Err(AppError::NotADirectory(dest.display().to_string()));
    }
    let folder_canon = folder.canonicalize().unwrap_or_else(|_| folder.to_path_buf());
    let dest_canon = dest.canonicalize().unwrap_or_else(|_| dest.to_path_buf());
    if folder_canon == dest_canon {
        return Err(AppError::SameSourceAndDestination);
    }
    Ok(())
}

pub fn move_files(folder: &Path, files: &[String], dest: &Path) -> AppResult<()> {
    validate_dest(folder, dest)?;
    let augmented = augment_with_sidecars(folder, files);
    let thumbs_to_migrate = collect_existing_thumbs(folder, files);

    // Pre-flight: refuse if any destination already exists, so we don't move
    // some and then bail halfway.
    for file in &augmented {
        let dst = dest.join(file);
        if dst.exists() {
            return Err(AppError::DestinationExists(dst.display().to_string()));
        }
    }

    for file in &augmented {
        let src = folder.join(file);
        let dst = dest.join(file);
        if fs::rename(&src, &dst).is_err() {
            // Cross-volume rename fails on Windows / Linux — fall back to copy + remove.
            fs::copy(&src, &dst)?;
            fs::remove_file(&src)?;
        }
    }

    migrate_thumbs(&thumbs_to_migrate, dest, MigrateMode::Move);
    // Source folder no longer holds these files — same cache-update
    // rationale as trash_files.
    let _ = patch_cache_remove_files(folder, files);
    Ok(())
}

pub fn copy_files(folder: &Path, files: &[String], dest: &Path) -> AppResult<()> {
    validate_dest(folder, dest)?;
    let augmented = augment_with_sidecars(folder, files);
    let thumbs_to_migrate = collect_existing_thumbs(folder, files);

    for file in &augmented {
        let dst = dest.join(file);
        if dst.exists() {
            return Err(AppError::DestinationExists(dst.display().to_string()));
        }
    }

    for file in &augmented {
        let src = folder.join(file);
        let dst = dest.join(file);
        fs::copy(&src, &dst)?;
    }

    migrate_thumbs(&thumbs_to_migrate, dest, MigrateMode::Copy);
    Ok(())
}

/// Drop the given files from the cached folder index, removing any bundles
/// they leave empty. Used after destructive ops (trash / move-out) so that
/// a next-launch cache read doesn't surface placeholder tiles for files
/// that aren't on disk anymore. Best-effort — a missing or unreadable cache
/// is fine, the next scan rebuilds it.
fn patch_cache_remove_files(folder: &Path, removed: &[String]) -> AppResult<()> {
    let Some(mut cached) = index_cache::read(folder) else {
        return Ok(());
    };
    let removed_set: HashSet<&str> = removed.iter().map(|s| s.as_str()).collect();
    let mut touched = false;
    for b in &mut cached.bundles {
        let before = b.files.len();
        b.files.retain(|f| !removed_set.contains(f.path.as_str()));
        if b.files.len() != before {
            touched = true;
        }
    }
    let bundle_count = cached.bundles.len();
    cached.bundles.retain(|b| !b.files.is_empty());
    if cached.bundles.len() != bundle_count {
        touched = true;
    }
    if touched {
        index_cache::write(folder, &cached)?;
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum MigrateMode {
    Move,
    Copy,
}

fn migrate_thumbs(src_thumbs: &[PathBuf], dest_folder: &Path, mode: MigrateMode) {
    if src_thumbs.is_empty() {
        return;
    }
    // Path-independent cache keys mean the destination filename is the same
    // as the source filename — just rename/copy into the destination's
    // .photoorg/thumbs/ directory.
    let dest_thumb_dir = thumbnail::thumb_dir(dest_folder);
    if fs::create_dir_all(&dest_thumb_dir).is_err() {
        return;
    }
    for src_thumb in src_thumbs {
        let Some(name) = src_thumb.file_name() else { continue };
        let dst_thumb = dest_thumb_dir.join(name);
        if dst_thumb.exists() {
            continue; // Don't clobber a fresher cache entry at the destination.
        }
        match mode {
            MigrateMode::Move => {
                if fs::rename(src_thumb, &dst_thumb).is_err() {
                    let _ = fs::copy(src_thumb, &dst_thumb)
                        .and_then(|_| fs::remove_file(src_thumb));
                }
            }
            MigrateMode::Copy => {
                let _ = fs::copy(src_thumb, &dst_thumb);
            }
        }
    }
}

pub fn open_path(path: &Path) -> AppResult<()> {
    use std::process::Command;

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW suppresses the brief cmd console flash.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        Command::new("cmd")
            .args(["/c", "start", "", &path.to_string_lossy()])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(path).spawn()?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open").arg(path).spawn()?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;
    use ulid::Ulid;

    fn tempdir() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("photoorg_fileops_{}", Ulid::new()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn touch(dir: &Path, name: &str, contents: &[u8]) {
        let mut f = File::create(dir.join(name)).unwrap();
        f.write_all(contents).unwrap();
    }

    fn make_jpg(dir: &Path, name: &str) {
        // Real JPG so thumbnail::ensure_thumbnail succeeds.
        let buf: image::ImageBuffer<image::Rgb<u8>, _> =
            image::ImageBuffer::from_fn(40, 40, |_, _| image::Rgb([10u8, 200, 30]));
        buf.save(dir.join(name)).unwrap();
    }

    #[test]
    fn copy_files_to_new_dir() {
        let src = tempdir();
        let dst = tempdir();
        touch(&src, "a.txt", b"hello");
        touch(&src, "b.txt", b"world");

        copy_files(&src, &["a.txt".to_string(), "b.txt".to_string()], &dst).unwrap();

        assert!(src.join("a.txt").exists());
        assert!(dst.join("a.txt").exists());
        assert!(dst.join("b.txt").exists());
        assert_eq!(fs::read(dst.join("a.txt")).unwrap(), b"hello");
    }

    #[test]
    fn copy_refuses_existing_destination() {
        let src = tempdir();
        let dst = tempdir();
        touch(&src, "a.txt", b"x");
        touch(&dst, "a.txt", b"y");

        let err = copy_files(&src, &["a.txt".to_string()], &dst).unwrap_err();
        assert!(matches!(err, AppError::DestinationExists(_)));
        assert_eq!(fs::read(src.join("a.txt")).unwrap(), b"x");
        assert_eq!(fs::read(dst.join("a.txt")).unwrap(), b"y");
    }

    #[test]
    fn move_files_relocates() {
        let src = tempdir();
        let dst = tempdir();
        touch(&src, "a.txt", b"hello");
        touch(&src, "b.txt", b"world");

        move_files(&src, &["a.txt".to_string(), "b.txt".to_string()], &dst).unwrap();

        assert!(!src.join("a.txt").exists());
        assert!(!src.join("b.txt").exists());
        assert!(dst.join("a.txt").exists());
        assert!(dst.join("b.txt").exists());
    }

    #[test]
    fn move_refuses_same_dir() {
        let src = tempdir();
        touch(&src, "a.txt", b"x");
        let err = move_files(&src, &["a.txt".to_string()], &src).unwrap_err();
        assert!(matches!(err, AppError::SameSourceAndDestination));
    }

    #[test]
    fn move_takes_sidecar_with_it() {
        let src = tempdir();
        let dst = tempdir();
        touch(&src, "DSC_0123.JPG", b"img");
        touch(&src, "DSC_0123.photoorg.json", b"{}");

        move_files(&src, &["DSC_0123.JPG".to_string()], &dst).unwrap();

        assert!(!src.join("DSC_0123.JPG").exists());
        assert!(!src.join("DSC_0123.photoorg.json").exists());
        assert!(dst.join("DSC_0123.JPG").exists());
        assert!(dst.join("DSC_0123.photoorg.json").exists());
    }

    #[test]
    fn copy_takes_sidecar_with_it() {
        let src = tempdir();
        let dst = tempdir();
        touch(&src, "DSC_0123.JPG", b"img");
        touch(&src, "DSC_0123.photoorg.json", b"{}");

        copy_files(&src, &["DSC_0123.JPG".to_string()], &dst).unwrap();

        assert!(src.join("DSC_0123.JPG").exists());
        assert!(src.join("DSC_0123.photoorg.json").exists());
        assert!(dst.join("DSC_0123.JPG").exists());
        assert!(dst.join("DSC_0123.photoorg.json").exists());
    }

    #[test]
    fn move_works_when_no_sidecar_exists() {
        let src = tempdir();
        let dst = tempdir();
        touch(&src, "DSC_0123.JPG", b"img");

        move_files(&src, &["DSC_0123.JPG".to_string()], &dst).unwrap();

        assert!(dst.join("DSC_0123.JPG").exists());
        assert!(!dst.join("DSC_0123.photoorg.json").exists());
    }

    #[test]
    fn move_dedupes_sidecar_when_bundle_has_multiple_files() {
        let src = tempdir();
        let dst = tempdir();
        touch(&src, "DSC_0123.DNG", b"raw");
        touch(&src, "DSC_0123.JPG", b"jpg");
        touch(&src, "DSC_0123.photoorg.json", b"{}");

        move_files(
            &src,
            &["DSC_0123.DNG".to_string(), "DSC_0123.JPG".to_string()],
            &dst,
        )
        .unwrap();

        assert!(dst.join("DSC_0123.DNG").exists());
        assert!(dst.join("DSC_0123.JPG").exists());
        assert!(dst.join("DSC_0123.photoorg.json").exists());
    }

    #[test]
    fn move_collision_on_sidecar_aborts_before_data_moves() {
        let src = tempdir();
        let dst = tempdir();
        touch(&src, "DSC_0123.JPG", b"img");
        touch(&src, "DSC_0123.photoorg.json", b"new");
        touch(&dst, "DSC_0123.photoorg.json", b"old");

        let err = move_files(&src, &["DSC_0123.JPG".to_string()], &dst).unwrap_err();
        assert!(matches!(err, AppError::DestinationExists(_)));
        assert!(src.join("DSC_0123.JPG").exists());
        assert!(src.join("DSC_0123.photoorg.json").exists());
        assert_eq!(fs::read(dst.join("DSC_0123.photoorg.json")).unwrap(), b"old");
    }

    #[test]
    fn move_migrates_thumbnail_cache() {
        let src = tempdir();
        let dst = tempdir();
        make_jpg(&src, "DSC_0500.JPG");
        let src_thumb = thumbnail::ensure_thumbnail(&src, &src.join("DSC_0500.JPG")).unwrap();
        assert!(src_thumb.exists(), "precondition: src thumb exists");
        let thumb_filename = src_thumb.file_name().unwrap().to_owned();

        move_files(&src, &["DSC_0500.JPG".to_string()], &dst).unwrap();

        assert!(!src_thumb.exists(), "src thumb should be gone after move");
        let dst_thumb = thumbnail::thumb_dir(&dst).join(&thumb_filename);
        assert!(dst_thumb.exists(), "dst thumb should exist after move");
    }

    #[test]
    fn copy_duplicates_thumbnail_cache() {
        let src = tempdir();
        let dst = tempdir();
        make_jpg(&src, "DSC_0501.JPG");
        let src_thumb = thumbnail::ensure_thumbnail(&src, &src.join("DSC_0501.JPG")).unwrap();
        let thumb_filename = src_thumb.file_name().unwrap().to_owned();

        copy_files(&src, &["DSC_0501.JPG".to_string()], &dst).unwrap();

        assert!(src_thumb.exists(), "src thumb should remain after copy");
        assert!(thumbnail::thumb_dir(&dst).join(&thumb_filename).exists());
    }

    #[test]
    fn trash_cleans_orphan_thumbnail() {
        let src = tempdir();
        make_jpg(&src, "DSC_0502.JPG");
        let src_thumb = thumbnail::ensure_thumbnail(&src, &src.join("DSC_0502.JPG")).unwrap();
        assert!(src_thumb.exists());

        // Note: this actually moves the data file to the OS recycle bin.
        // Fine for a test — trash is recoverable.
        trash_files(&src, &["DSC_0502.JPG".to_string()]).unwrap();

        assert!(!src_thumb.exists(), "thumb should be cleaned up after trash");
    }

    #[test]
    fn trash_drops_files_from_cached_index() {
        use crate::core::scanner::scan_folder;

        let src = tempdir();
        make_jpg(&src, "DSC_0600.JPG");
        make_jpg(&src, "DSC_0601.JPG");
        // Build the cache by running a real scan.
        let idx_before = scan_folder(&src, false).unwrap();
        assert_eq!(idx_before.bundles.len(), 2);

        trash_files(&src, &["DSC_0600.JPG".to_string()]).unwrap();

        // Cache must reflect the deletion without needing a re-scan; reading
        // the cache directly is what the *next launch* would do.
        let cached = index_cache::read(&src).expect("cache present");
        let names: Vec<&str> = cached.bundles.iter().map(|b| b.base_name.as_str()).collect();
        assert_eq!(names, vec!["DSC_0601"]);
    }

    #[test]
    fn move_drops_files_from_source_cached_index() {
        use crate::core::scanner::scan_folder;

        let src = tempdir();
        let dst = tempdir();
        make_jpg(&src, "DSC_0700.JPG");
        make_jpg(&src, "DSC_0701.JPG");
        let idx_before = scan_folder(&src, false).unwrap();
        assert_eq!(idx_before.bundles.len(), 2);

        move_files(&src, &["DSC_0700.JPG".to_string()], &dst).unwrap();

        let cached = index_cache::read(&src).expect("cache present");
        let names: Vec<&str> = cached.bundles.iter().map(|b| b.base_name.as_str()).collect();
        assert_eq!(names, vec!["DSC_0701"]);
    }
}
