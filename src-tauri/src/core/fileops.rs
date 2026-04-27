use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

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

pub fn trash_files(folder: &Path, files: &[String]) -> AppResult<()> {
    let augmented = augment_with_sidecars(folder, files);
    if augmented.is_empty() {
        return Ok(());
    }
    let paths: Vec<PathBuf> = augmented.iter().map(|f| folder.join(f)).collect();
    trash::delete_all(paths.iter().map(|p| p.as_path()))
        .map_err(|e| AppError::Trash(e.to_string()))?;
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
    Ok(())
}

pub fn copy_files(folder: &Path, files: &[String], dest: &Path) -> AppResult<()> {
    validate_dest(folder, dest)?;
    let augmented = augment_with_sidecars(folder, files);

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
    Ok(())
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

        // Source kept intact (it's a copy).
        assert!(src.join("DSC_0123.JPG").exists());
        assert!(src.join("DSC_0123.photoorg.json").exists());
        // Destination got both.
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
        // RAW + JPG bundle → one shared sidecar should be moved exactly once.
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
        // Pre-flight should keep both source files in place.
        assert!(src.join("DSC_0123.JPG").exists());
        assert!(src.join("DSC_0123.photoorg.json").exists());
        // And not clobber the existing destination sidecar.
        assert_eq!(fs::read(dst.join("DSC_0123.photoorg.json")).unwrap(), b"old");
    }
}
