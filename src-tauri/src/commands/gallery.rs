use std::path::PathBuf;

use chrono::{Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use ulid::Ulid;

use crate::core::gallery_client::{CreateGalleryBody, CreatePhotoEntry, GalleryClient};
use crate::core::{app_settings, gallery_store};
use crate::error::{AppError, AppResult};
use crate::models::gallery::{GalleryPhotoRecord, GalleryRecord};
use crate::models::settings::Decision;

const MAX_PHOTOS: usize = 500;
const MAX_DAYS: u32 = 365;
const PROGRESS_EVENT: &str = "gallery-share-progress";

fn app_data_dir(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|e| AppError::InvalidArgument(format!("app_data_dir: {e}")))
}

#[derive(Debug, Deserialize)]
pub struct ShareGalleryArgs {
    pub name: String,
    pub expires_in_days: u32,
    pub default_decision: Decision,
    pub photos: Vec<ShareGalleryPhoto>,
}

#[derive(Debug, Deserialize)]
pub struct ShareGalleryPhoto {
    pub bundle_id: String,
    pub source_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ShareGalleryResult {
    pub gid: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
struct ShareProgressEvent {
    gid: String,
    current: usize,
    total: usize,
    filename: String,
}

#[tauri::command]
pub async fn share_gallery(
    app: AppHandle,
    args: ShareGalleryArgs,
) -> AppResult<ShareGalleryResult> {
    if args.photos.is_empty() {
        return Err(AppError::InvalidArgument("no photos to share".into()));
    }
    if args.photos.len() > MAX_PHOTOS {
        return Err(AppError::InvalidArgument(format!(
            "too many photos (max {MAX_PHOTOS})"
        )));
    }
    if args.expires_in_days == 0 || args.expires_in_days > MAX_DAYS {
        return Err(AppError::InvalidArgument(
            "expires_in_days must be between 1 and 365".into(),
        ));
    }
    if args.name.trim().is_empty() {
        return Err(AppError::InvalidArgument("gallery name is required".into()));
    }

    let dir = app_data_dir(&app)?;
    let settings = {
        let dir = dir.clone();
        tauri::async_runtime::spawn_blocking(move || app_settings::read(&dir))
            .await
            .map_err(|e| AppError::InvalidArgument(format!("settings task: {e}")))?
    };

    let client = GalleryClient::new(&settings.gallery)?;
    let base_url = settings.gallery.base_url().to_string();

    let gid = Ulid::new().to_string();
    let now = Utc::now();
    let expires_at = now + ChronoDuration::days(args.expires_in_days as i64);

    let mut photo_records: Vec<GalleryPhotoRecord> = Vec::with_capacity(args.photos.len());
    let mut create_entries: Vec<CreatePhotoEntry> = Vec::with_capacity(args.photos.len());

    for (i, p) in args.photos.iter().enumerate() {
        let path = PathBuf::from(&p.source_path);
        let metadata = std::fs::metadata(&path).map_err(|e| {
            AppError::InvalidArgument(format!("cannot stat {}: {e}", p.source_path))
        })?;
        let size = metadata.len();
        let filename = path
            .file_name()
            .ok_or_else(|| {
                AppError::InvalidArgument(format!("invalid path: {}", p.source_path))
            })?
            .to_string_lossy()
            .to_string();
        let content_type = guess_content_type(&filename).to_string();
        let pid = format!("p{:03}", i + 1);

        photo_records.push(GalleryPhotoRecord {
            pid: pid.clone(),
            bundle_id: p.bundle_id.clone(),
            source_path: p.source_path.clone(),
            filename: filename.clone(),
            size,
            content_type: content_type.clone(),
        });
        create_entries.push(CreatePhotoEntry {
            pid,
            filename,
            content_type,
            size,
        });
    }

    let create_body = CreateGalleryBody {
        name: args.name.clone(),
        expires_at: expires_at.to_rfc3339(),
        default_decision: args.default_decision,
        photos: create_entries,
    };
    client.create_gallery(&gid, &create_body).await?;

    let total = photo_records.len();
    for (i, photo) in photo_records.iter().enumerate() {
        // Read each photo on the blocking pool — file size can be a few
        // MB and we don't want to stall the async runtime.
        let path = PathBuf::from(&photo.source_path);
        let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(&path))
            .await
            .map_err(|e| AppError::InvalidArgument(format!("read task: {e}")))??;

        let _ = app.emit(
            PROGRESS_EVENT,
            ShareProgressEvent {
                gid: gid.clone(),
                current: i + 1,
                total,
                filename: photo.filename.clone(),
            },
        );

        client
            .upload_photo(&gid, &photo.pid, &photo.content_type, bytes)
            .await
            .map_err(|e| {
                // If a single upload blows up, ask the Worker to drop the
                // partial gallery so the photographer can just retry without
                // leaving orphans.
                let client = client_for_cleanup(&settings.gallery);
                let gid_clone = gid.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(c) = client {
                        let _ = c.delete_gallery(&gid_clone).await;
                    }
                });
                e
            })?;
    }

    client.finalize(&gid).await?;

    let url = format!("{}/{}", base_url, gid);
    let record = GalleryRecord {
        gid: gid.clone(),
        name: args.name,
        url: url.clone(),
        created_at: now.to_rfc3339(),
        expires_at: expires_at.to_rfc3339(),
        default_decision: args.default_decision,
        photos: photo_records,
    };

    {
        let dir = dir.clone();
        tauri::async_runtime::spawn_blocking(move || gallery_store::upsert(&dir, record))
            .await
            .map_err(|e| AppError::InvalidArgument(format!("save task: {e}")))??;
    }

    Ok(ShareGalleryResult { gid, url })
}

#[tauri::command]
pub async fn list_galleries(app: AppHandle) -> AppResult<Vec<GalleryRecord>> {
    let dir = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || gallery_store::read(&dir))
        .await
        .map_err(|e| AppError::InvalidArgument(format!("read task: {e}")))
}

#[derive(Debug, Clone, Serialize)]
pub struct GalleryFeedbackEntry {
    pub bundle_id: String,
    pub pid: String,
    pub decision: Decision,
    /// True iff the model explicitly chose this decision (vs. inheriting
    /// from the gallery's default).
    pub explicit: bool,
}

#[tauri::command]
pub async fn fetch_gallery_feedback(
    app: AppHandle,
    gid: String,
) -> AppResult<Vec<GalleryFeedbackEntry>> {
    let dir = app_data_dir(&app)?;
    let settings = {
        let dir = dir.clone();
        tauri::async_runtime::spawn_blocking(move || app_settings::read(&dir))
            .await
            .map_err(|e| AppError::InvalidArgument(format!("settings task: {e}")))?
    };

    let client = GalleryClient::new(&settings.gallery)?;
    let resp = client.fetch_feedback(&gid).await?;

    let local = {
        let dir = dir.clone();
        let gid = gid.clone();
        tauri::async_runtime::spawn_blocking(move || {
            gallery_store::read(&dir).into_iter().find(|g| g.gid == gid)
        })
        .await
        .map_err(|e| AppError::InvalidArgument(format!("read task: {e}")))?
    };
    let local = local.ok_or_else(|| {
        AppError::InvalidArgument("gallery not found in local store".into())
    })?;

    let mut out = Vec::with_capacity(local.photos.len());
    for photo in &local.photos {
        let explicit = resp.decisions.contains_key(&photo.pid);
        let decision = resp
            .decisions
            .get(&photo.pid)
            .copied()
            .unwrap_or(resp.default_decision);
        out.push(GalleryFeedbackEntry {
            bundle_id: photo.bundle_id.clone(),
            pid: photo.pid.clone(),
            decision,
            explicit,
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn delete_gallery(app: AppHandle, gid: String) -> AppResult<()> {
    let dir = app_data_dir(&app)?;
    let settings = {
        let dir = dir.clone();
        tauri::async_runtime::spawn_blocking(move || app_settings::read(&dir))
            .await
            .map_err(|e| AppError::InvalidArgument(format!("settings task: {e}")))?
    };

    if settings.gallery.is_configured() {
        let client = GalleryClient::new(&settings.gallery)?;
        client.delete_gallery(&gid).await?;
    }

    tauri::async_runtime::spawn_blocking(move || gallery_store::remove(&dir, &gid))
        .await
        .map_err(|e| AppError::InvalidArgument(format!("remove task: {e}")))?
}

fn guess_content_type(filename: &str) -> &'static str {
    let lower = filename.to_ascii_lowercase();
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".tif") || lower.ends_with(".tiff") {
        "image/tiff"
    } else {
        "application/octet-stream"
    }
}

fn client_for_cleanup(settings: &crate::models::settings::GallerySettings) -> Option<GalleryClient> {
    GalleryClient::new(settings).ok()
}
