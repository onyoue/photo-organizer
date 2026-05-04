use std::fs;
use std::path::{Path, PathBuf};

use crate::error::AppResult;
use crate::models::settings::AppSettings;

const SETTINGS_FILE: &str = "settings.json";

pub fn settings_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(SETTINGS_FILE)
}

/// Read the persisted app settings. Returns defaults when the file is
/// missing or unreadable — this is per-user config, never required.
/// Legacy single-path values are migrated into the new list shape.
pub fn read(app_data_dir: &Path) -> AppSettings {
    let path = settings_path(app_data_dir);
    let Ok(bytes) = fs::read(&path) else {
        return AppSettings::default();
    };
    let parsed: AppSettings = serde_json::from_slice(&bytes).unwrap_or_default();
    parsed.migrate_legacy()
}

pub fn write(app_data_dir: &Path, settings: &AppSettings) -> AppResult<()> {
    fs::create_dir_all(app_data_dir)?;
    let path = settings_path(app_data_dir);
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::settings::RawDeveloperEntry;
    use ulid::Ulid;

    fn tempdir() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("photoorg_settings_{}", Ulid::new()));
        p
    }

    #[test]
    fn read_returns_default_when_absent() {
        let dir = tempdir();
        let s = read(&dir);
        assert!(s.raw_developers.is_empty());
        assert_eq!(s.active_raw_developer_index, 0);
        assert!(s.active_raw_developer().is_none());
    }

    #[test]
    fn round_trips_list_via_disk() {
        let dir = tempdir();
        let s = AppSettings {
            raw_developers: vec![
                RawDeveloperEntry {
                    name: "Lightroom".into(),
                    path: "C:\\lr.exe".into(),
                },
                RawDeveloperEntry {
                    name: "MyDevApp".into(),
                    path: "D:\\my-dev.exe".into(),
                },
            ],
            active_raw_developer_index: 1,
            raw_developer_path: None,
            gallery: Default::default(),
            welcome_seen: false,
        };
        write(&dir, &s).unwrap();
        let loaded = read(&dir);
        assert_eq!(loaded.raw_developers.len(), 2);
        assert_eq!(loaded.raw_developers[1].name, "MyDevApp");
        assert_eq!(loaded.active_raw_developer_index, 1);
        assert_eq!(loaded.active_raw_developer().unwrap().path, "D:\\my-dev.exe");
    }

    #[test]
    fn legacy_single_path_is_migrated_into_list() {
        // Reproduces a v1 settings.json that the user wrote before the list
        // shape existed.
        let dir = tempdir();
        fs::create_dir_all(&dir).unwrap();
        let json = r#"{"raw_developer_path": "C:\\old\\rawdev.exe"}"#;
        fs::write(settings_path(&dir), json).unwrap();

        let loaded = read(&dir);
        assert_eq!(loaded.raw_developers.len(), 1);
        assert_eq!(loaded.raw_developers[0].path, "C:\\old\\rawdev.exe");
        assert!(loaded.raw_developer_path.is_none(), "legacy field cleared");
        assert_eq!(loaded.active_raw_developer_index, 0);
    }

    #[test]
    fn migration_is_skipped_when_list_already_populated() {
        let dir = tempdir();
        fs::create_dir_all(&dir).unwrap();
        let json = r#"{
            "raw_developers": [{"name": "Keep", "path": "C:\\keep.exe"}],
            "active_raw_developer_index": 0,
            "raw_developer_path": "C:\\should-be-ignored.exe"
        }"#;
        fs::write(settings_path(&dir), json).unwrap();

        let loaded = read(&dir);
        assert_eq!(loaded.raw_developers.len(), 1);
        assert_eq!(loaded.raw_developers[0].path, "C:\\keep.exe");
        assert!(loaded.raw_developer_path.is_none());
    }

    #[test]
    fn empty_legacy_string_is_not_migrated() {
        let dir = tempdir();
        fs::create_dir_all(&dir).unwrap();
        let json = r#"{"raw_developer_path": "   "}"#;
        fs::write(settings_path(&dir), json).unwrap();

        let loaded = read(&dir);
        assert!(loaded.raw_developers.is_empty());
    }

    #[test]
    fn malformed_settings_falls_back_to_default() {
        let dir = tempdir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(settings_path(&dir), b"{not valid json").unwrap();
        let loaded = read(&dir);
        assert!(loaded.raw_developers.is_empty());
    }

    #[test]
    fn gallery_settings_round_trip() {
        use crate::models::settings::{Decision, GallerySettings};
        let dir = tempdir();
        let s = AppSettings {
            gallery: GallerySettings {
                worker_url: "https://photo-gallery.example.workers.dev/".into(),
                admin_token: "secret-123".into(),
                default_decision: Decision::Ng,
            },
            ..Default::default()
        };
        write(&dir, &s).unwrap();
        let loaded = read(&dir);
        assert_eq!(loaded.gallery.worker_url, "https://photo-gallery.example.workers.dev/");
        assert_eq!(loaded.gallery.base_url(), "https://photo-gallery.example.workers.dev");
        assert_eq!(loaded.gallery.admin_token, "secret-123");
        assert_eq!(loaded.gallery.default_decision, Decision::Ng);
        assert!(loaded.gallery.is_configured());
    }

    #[test]
    fn gallery_default_is_unconfigured() {
        let s = AppSettings::default();
        assert!(!s.gallery.is_configured());
    }

    #[test]
    fn old_settings_without_gallery_still_parse() {
        // A v3 settings.json (raw_developers + active_index) should still
        // load — the new `gallery` field comes back as default.
        let dir = tempdir();
        fs::create_dir_all(&dir).unwrap();
        let json = r#"{
            "raw_developers": [{"name": "x", "path": "y"}],
            "active_raw_developer_index": 0
        }"#;
        fs::write(settings_path(&dir), json).unwrap();
        let loaded = read(&dir);
        assert_eq!(loaded.raw_developers.len(), 1);
        assert!(!loaded.gallery.is_configured());
    }

    #[test]
    fn out_of_range_active_index_yields_no_active_entry() {
        let s = AppSettings {
            raw_developers: vec![RawDeveloperEntry {
                name: "Only".into(),
                path: "x".into(),
            }],
            active_raw_developer_index: 5,
            raw_developer_path: None,
            gallery: Default::default(),
            welcome_seen: false,
        };
        assert!(s.active_raw_developer().is_none());
    }
}
