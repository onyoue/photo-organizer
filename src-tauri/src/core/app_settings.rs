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
pub fn read(app_data_dir: &Path) -> AppSettings {
    let path = settings_path(app_data_dir);
    let Ok(bytes) = fs::read(&path) else {
        return AppSettings::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
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
        assert!(s.raw_developer_path.is_none());
    }

    #[test]
    fn round_trips_via_disk() {
        let dir = tempdir();
        let s = AppSettings {
            raw_developer_path: Some("C:\\my\\raw_dev.exe".into()),
        };
        write(&dir, &s).unwrap();
        let loaded = read(&dir);
        assert_eq!(loaded.raw_developer_path.as_deref(), Some("C:\\my\\raw_dev.exe"));
    }

    #[test]
    fn malformed_settings_falls_back_to_default() {
        let dir = tempdir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(settings_path(&dir), b"{not valid json").unwrap();
        let loaded = read(&dir);
        assert!(loaded.raw_developer_path.is_none());
    }
}
