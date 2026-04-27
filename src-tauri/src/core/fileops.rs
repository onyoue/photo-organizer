use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

pub fn trash_files(paths: &[PathBuf]) -> AppResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
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

    // Pre-flight: refuse if any destination already exists, so we don't move some
    // and then bail halfway.
    for file in files {
        let dst = dest.join(file);
        if dst.exists() {
            return Err(AppError::DestinationExists(dst.display().to_string()));
        }
    }

    for file in files {
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

    for file in files {
        let dst = dest.join(file);
        if dst.exists() {
            return Err(AppError::DestinationExists(dst.display().to_string()));
        }
    }

    for file in files {
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
        // Source unchanged.
        assert_eq!(fs::read(src.join("a.txt")).unwrap(), b"x");
        // Destination not overwritten.
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
}
