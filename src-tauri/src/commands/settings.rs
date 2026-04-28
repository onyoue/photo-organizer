use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::core::{app_settings, fileops};
use crate::error::{AppError, AppResult};
use crate::models::settings::AppSettings;

fn app_data_dir(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|e| AppError::InvalidArgument(format!("app_data_dir: {e}")))
}

#[tauri::command]
pub async fn get_app_settings(app: AppHandle) -> AppResult<AppSettings> {
    let dir = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || app_settings::read(&dir))
        .await
        .map_err(|e| AppError::InvalidArgument(format!("settings task: {e}")))
}

#[tauri::command]
pub async fn save_app_settings(app: AppHandle, settings: AppSettings) -> AppResult<()> {
    let dir = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || app_settings::write(&dir, &settings))
        .await
        .expect("settings save task panicked")
}

/// Open one or more files in the configured RAW developer. Falls back to
/// the OS default handler when no path is set, so the feature degrades
/// gracefully on a fresh install.
#[tauri::command]
pub async fn open_with_raw_developer(app: AppHandle, paths: Vec<String>) -> AppResult<()> {
    let dir = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let settings = app_settings::read(&dir);
        match settings.raw_developer_path {
            Some(exe) => spawn_external(&exe, &paths),
            None => {
                for p in &paths {
                    fileops::open_path(&PathBuf::from(p))?;
                }
                Ok(())
            }
        }
    })
    .await
    .expect("open task panicked")
}

fn spawn_external(exe: &str, paths: &[String]) -> AppResult<()> {
    use std::process::Command;
    let exe_path = PathBuf::from(exe);
    if !exe_path.exists() {
        return Err(AppError::InvalidArgument(format!(
            "RAW developer executable not found: {exe}"
        )));
    }
    let mut cmd = Command::new(&exe_path);
    for p in paths {
        cmd.arg(p);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()?;
    Ok(())
}
