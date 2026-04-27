use std::fs;
use std::path::{Path, PathBuf};

use crate::error::AppResult;
use crate::models::sidecar::BundleSidecar;

pub const SIDECAR_VERSION: u32 = 1;
const SUFFIX: &str = ".photoorg.json";
const TMP_SUFFIX: &str = ".photoorg.json.tmp";

pub fn sidecar_path(folder: &Path, base_name: &str) -> PathBuf {
    folder.join(format!("{base_name}{SUFFIX}"))
}

pub fn read(folder: &Path, base_name: &str) -> AppResult<Option<BundleSidecar>> {
    let path = sidecar_path(folder, base_name);
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let parsed: BundleSidecar = serde_json::from_slice(&bytes)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    Ok(Some(parsed))
}

pub fn write(folder: &Path, sidecar: &BundleSidecar) -> AppResult<()> {
    let path = sidecar_path(folder, &sidecar.base_name);
    let bytes = serde_json::to_vec_pretty(sidecar)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let tmp = folder.join(format!("{}{TMP_SUFFIX}", sidecar.base_name));
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, path)?;
    Ok(())
}

pub fn delete(folder: &Path, base_name: &str) -> AppResult<()> {
    match fs::remove_file(sidecar_path(folder, base_name)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::sidecar::{PostBy, PostRecord, Platform};
    use ulid::Ulid;

    fn tempdir() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("photoorg_sidecar_{}", Ulid::new()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn sample(base: &str) -> BundleSidecar {
        BundleSidecar {
            version: SIDECAR_VERSION,
            bundle_id: Ulid::new().to_string(),
            base_name: base.to_string(),
            rating: None,
            flag: None,
            tags: vec![],
            posts: vec![PostRecord {
                id: Ulid::new().to_string(),
                platform: Platform::X,
                url: "https://x.com/me/status/1".into(),
                posted_at: None,
                by: PostBy::Self_,
                posted_by_handle: None,
                note: None,
            }],
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn round_trips_via_disk() {
        let dir = tempdir();
        let s = sample("DSC_0123");
        write(&dir, &s).unwrap();
        let loaded = read(&dir, "DSC_0123").unwrap().unwrap();
        assert_eq!(loaded.bundle_id, s.bundle_id);
        assert_eq!(loaded.posts.len(), 1);
        assert_eq!(loaded.posts[0].platform, Platform::X);
    }

    #[test]
    fn read_returns_none_when_absent() {
        let dir = tempdir();
        assert!(read(&dir, "missing").unwrap().is_none());
    }

    #[test]
    fn delete_is_idempotent() {
        let dir = tempdir();
        delete(&dir, "never_existed").unwrap();
        let s = sample("DSC_0500");
        write(&dir, &s).unwrap();
        assert!(sidecar_path(&dir, "DSC_0500").exists());
        delete(&dir, "DSC_0500").unwrap();
        assert!(!sidecar_path(&dir, "DSC_0500").exists());
        delete(&dir, "DSC_0500").unwrap();
    }

    #[test]
    fn empty_payload_round_trip_omits_optional_fields() {
        let mut s = sample("X");
        s.posts.clear();
        assert!(s.is_empty_payload());
        // Even if we wrote it (caller chooses not to), it should still parse back.
        let dir = tempdir();
        write(&dir, &s).unwrap();
        let loaded = read(&dir, "X").unwrap().unwrap();
        assert!(loaded.posts.is_empty());
        assert!(loaded.tags.is_empty());
    }
}
