use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};
use crate::models::gallery::GalleryRecord;

const GALLERIES_FILE: &str = "galleries.json";

pub fn galleries_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(GALLERIES_FILE)
}

/// Read all locally tracked galleries. Returns an empty vec when the file
/// is missing or unparseable — galleries are best-effort tracking, the
/// Worker remains the source of truth for what actually exists on the
/// server.
pub fn read(app_data_dir: &Path) -> Vec<GalleryRecord> {
    let p = galleries_path(app_data_dir);
    let Ok(bytes) = fs::read(&p) else { return Vec::new(); };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

pub fn write(app_data_dir: &Path, records: &[GalleryRecord]) -> AppResult<()> {
    fs::create_dir_all(app_data_dir)?;
    let p = galleries_path(app_data_dir);
    let bytes = serde_json::to_vec_pretty(records)
        .map_err(|e| AppError::InvalidArgument(format!("serialize galleries: {e}")))?;
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, p)?;
    Ok(())
}

/// Insert or replace a record by gid (gid uniqueness is enforced).
pub fn upsert(app_data_dir: &Path, record: GalleryRecord) -> AppResult<()> {
    let mut all = read(app_data_dir);
    all.retain(|g| g.gid != record.gid);
    all.push(record);
    write(app_data_dir, &all)
}

pub fn remove(app_data_dir: &Path, gid: &str) -> AppResult<()> {
    let mut all = read(app_data_dir);
    let before = all.len();
    all.retain(|g| g.gid != gid);
    if all.len() == before {
        return Ok(());
    }
    write(app_data_dir, &all)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::gallery::{GalleryPhotoRecord, GalleryRecord};
    use crate::models::settings::Decision;
    use ulid::Ulid;

    fn tempdir() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("photoorg_galleries_{}", Ulid::new()));
        p
    }

    fn sample(gid: &str) -> GalleryRecord {
        GalleryRecord {
            gid: gid.to_string(),
            name: "Test".into(),
            url: format!("https://x.workers.dev/{gid}"),
            created_at: "2026-05-01T00:00:00Z".into(),
            expires_at: "2026-05-08T00:00:00Z".into(),
            default_decision: Decision::Ok,
            photos: vec![GalleryPhotoRecord {
                pid: "p001".into(),
                bundle_id: "b1".into(),
                source_path: "C:/x/a.jpg".into(),
                filename: "a.jpg".into(),
                size: 1234,
                content_type: "image/jpeg".into(),
            }],
        }
    }

    #[test]
    fn read_returns_empty_when_absent() {
        let dir = tempdir();
        assert!(read(&dir).is_empty());
    }

    #[test]
    fn upsert_adds_then_replaces() {
        let dir = tempdir();
        upsert(&dir, sample("01HX1234567890ABCDEFGHJKM1")).unwrap();
        upsert(&dir, sample("01HX1234567890ABCDEFGHJKM2")).unwrap();
        assert_eq!(read(&dir).len(), 2);

        let mut updated = sample("01HX1234567890ABCDEFGHJKM1");
        updated.name = "Replaced".into();
        upsert(&dir, updated).unwrap();
        let all = read(&dir);
        assert_eq!(all.len(), 2, "replace, not duplicate");
        let edited = all.iter().find(|g| g.gid == "01HX1234567890ABCDEFGHJKM1").unwrap();
        assert_eq!(edited.name, "Replaced");
    }

    #[test]
    fn remove_drops_entry_by_gid() {
        let dir = tempdir();
        upsert(&dir, sample("01HX1234567890ABCDEFGHJKM1")).unwrap();
        upsert(&dir, sample("01HX1234567890ABCDEFGHJKM2")).unwrap();
        remove(&dir, "01HX1234567890ABCDEFGHJKM1").unwrap();
        let all = read(&dir);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].gid, "01HX1234567890ABCDEFGHJKM2");
    }

    #[test]
    fn remove_unknown_gid_is_noop() {
        let dir = tempdir();
        upsert(&dir, sample("01HX1234567890ABCDEFGHJKM1")).unwrap();
        remove(&dir, "01HX1234567890ABCDEFGHJKMxx").unwrap();
        assert_eq!(read(&dir).len(), 1);
    }

    #[test]
    fn malformed_galleries_falls_back_to_empty() {
        let dir = tempdir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(galleries_path(&dir), b"{not valid json").unwrap();
        assert!(read(&dir).is_empty());
    }
}
