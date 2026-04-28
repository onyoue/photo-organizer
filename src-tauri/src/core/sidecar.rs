use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::Deserialize;

use crate::error::AppResult;
use crate::models::sidecar::{BundleSidecar, Flag};

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

#[derive(Debug, Clone, Deserialize)]
pub struct BundleRef {
    pub bundle_id: String,
    pub base_name: String,
}

fn load_or_default(folder: &Path, bundle: &BundleRef) -> AppResult<BundleSidecar> {
    if let Some(s) = read(folder, &bundle.base_name)? {
        return Ok(s);
    }
    let now = Utc::now().to_rfc3339();
    Ok(BundleSidecar {
        version: SIDECAR_VERSION,
        bundle_id: bundle.bundle_id.clone(),
        base_name: bundle.base_name.clone(),
        rating: None,
        flag: None,
        tags: vec![],
        posts: vec![],
        created_at: now.clone(),
        updated_at: now,
    })
}

/// Apply a mutation to the bundle's sidecar — load (or build a fresh one),
/// run `update`, then write back (or delete if the mutation left the payload
/// empty per §7.3). `updated_at` is bumped automatically.
fn apply<F>(folder: &Path, bundle: &BundleRef, update: F) -> AppResult<()>
where
    F: FnOnce(&mut BundleSidecar),
{
    let mut sidecar = load_or_default(folder, bundle)?;
    update(&mut sidecar);
    sidecar.updated_at = Utc::now().to_rfc3339();
    if sidecar.is_empty_payload() {
        delete(folder, &sidecar.base_name)
    } else {
        write(folder, &sidecar)
    }
}

pub fn apply_rating(folder: &Path, bundle: &BundleRef, rating: Option<u8>) -> AppResult<()> {
    apply(folder, bundle, |s| s.rating = rating)
}

pub fn apply_flag(folder: &Path, bundle: &BundleRef, flag: Option<Flag>) -> AppResult<()> {
    apply(folder, bundle, |s| s.flag = flag)
}

pub fn apply_tags(folder: &Path, bundle: &BundleRef, tags: Vec<String>) -> AppResult<()> {
    apply(folder, bundle, |s| s.tags = tags)
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

    fn bref(name: &str) -> BundleRef {
        BundleRef {
            bundle_id: Ulid::new().to_string(),
            base_name: name.to_string(),
        }
    }

    #[test]
    fn apply_rating_creates_sidecar_when_absent() {
        let dir = tempdir();
        apply_rating(&dir, &bref("DSC_R1"), Some(4)).unwrap();
        let loaded = read(&dir, "DSC_R1").unwrap().unwrap();
        assert_eq!(loaded.rating, Some(4));
    }

    #[test]
    fn apply_rating_clears_to_none_and_deletes_empty_sidecar() {
        let dir = tempdir();
        let b = bref("DSC_R2");
        apply_rating(&dir, &b, Some(2)).unwrap();
        assert!(sidecar_path(&dir, "DSC_R2").exists());
        apply_rating(&dir, &b, None).unwrap();
        assert!(!sidecar_path(&dir, "DSC_R2").exists());
    }

    #[test]
    fn apply_rating_preserves_other_fields() {
        let dir = tempdir();
        let s = sample("DSC_R3");
        let original_post_id = s.posts[0].id.clone();
        write(&dir, &s).unwrap();
        let b = BundleRef {
            bundle_id: s.bundle_id.clone(),
            base_name: "DSC_R3".into(),
        };
        apply_rating(&dir, &b, Some(5)).unwrap();
        let loaded = read(&dir, "DSC_R3").unwrap().unwrap();
        assert_eq!(loaded.rating, Some(5));
        assert_eq!(loaded.posts.len(), 1);
        assert_eq!(loaded.posts[0].id, original_post_id);
    }

    #[test]
    fn apply_flag_toggles_through_states() {
        let dir = tempdir();
        let b = bref("DSC_F1");
        apply_flag(&dir, &b, Some(Flag::Pick)).unwrap();
        assert_eq!(read(&dir, "DSC_F1").unwrap().unwrap().flag, Some(Flag::Pick));
        apply_flag(&dir, &b, Some(Flag::Reject)).unwrap();
        assert_eq!(read(&dir, "DSC_F1").unwrap().unwrap().flag, Some(Flag::Reject));
        apply_flag(&dir, &b, None).unwrap();
        assert!(read(&dir, "DSC_F1").unwrap().is_none());
    }

    #[test]
    fn apply_tags_replaces_set() {
        let dir = tempdir();
        let b = bref("DSC_T1");
        apply_tags(&dir, &b, vec!["model:saki".into(), "shibuya".into()]).unwrap();
        let loaded = read(&dir, "DSC_T1").unwrap().unwrap();
        assert_eq!(loaded.tags, vec!["model:saki", "shibuya"]);
        // Replacing with empty should delete the (otherwise empty) sidecar.
        apply_tags(&dir, &b, vec![]).unwrap();
        assert!(read(&dir, "DSC_T1").unwrap().is_none());
    }
}
