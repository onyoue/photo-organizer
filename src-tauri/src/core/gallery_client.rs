use std::collections::HashMap;
use std::time::Duration;

use reqwest::{Client, Response, StatusCode};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::models::settings::{Decision, GallerySettings};

/// Body sent to PUT /admin/<gid> on the Worker. Mirrors the Worker's
/// CreateGalleryBody / PhotoEntry types — kept in sync by hand.
#[derive(Debug, Clone, Serialize)]
pub struct CreateGalleryBody {
    pub name: String,
    pub expires_at: String,
    pub default_decision: Decision,
    pub photos: Vec<CreatePhotoEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreatePhotoEntry {
    pub pid: String,
    pub filename: String,
    pub content_type: String,
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FeedbackResponse {
    pub default_decision: Decision,
    pub decisions: HashMap<String, Decision>,
}

/// Mirrors the Worker's StatsResponse (running totals + the free-tier
/// R2 ceiling so the desktop UI doesn't have to hard-code it).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GalleryStats {
    pub r2_bytes: u64,
    pub photo_count: u64,
    pub gallery_count: u64,
    pub updated_at: String,
    pub r2_bytes_limit: u64,
}

/// Mirrors the Worker's ViewedRecord — read-receipt for one gallery.
/// `None` from the worker means the model hasn't opened the page yet.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ViewedRecord {
    pub first_viewed_at: String,
    pub last_viewed_at: String,
    pub view_count: u32,
}

/// Thin reqwest wrapper that knows how to talk to the gallery Worker.
/// Constructed from `GallerySettings`; bails out early if the user has
/// not configured a worker URL or admin token.
pub struct GalleryClient {
    base_url: String,
    token: String,
    http: Client,
}

impl GalleryClient {
    pub fn new(settings: &GallerySettings) -> AppResult<Self> {
        if !settings.is_configured() {
            return Err(AppError::InvalidArgument(
                "gallery worker URL or admin token is not set".into(),
            ));
        }
        let http = Client::builder()
            .timeout(Duration::from_secs(180))
            .build()
            .map_err(|e| AppError::InvalidArgument(format!("http client: {e}")))?;
        Ok(Self {
            base_url: settings.base_url().to_string(),
            token: settings.admin_token.clone(),
            http,
        })
    }

    pub async fn create_gallery(&self, gid: &str, body: &CreateGalleryBody) -> AppResult<()> {
        let url = format!("{}/admin/{}", self.base_url, gid);
        let resp = self
            .http
            .put(&url)
            .bearer_auth(&self.token)
            .json(body)
            .send()
            .await
            .map_err(io_err)?;
        ensure_success(resp).await
    }

    pub async fn upload_photo(
        &self,
        gid: &str,
        pid: &str,
        content_type: &str,
        bytes: Vec<u8>,
    ) -> AppResult<()> {
        let url = format!("{}/admin/{}/photos/{}", self.base_url, gid, pid);
        let resp = self
            .http
            .put(&url)
            .bearer_auth(&self.token)
            .header(reqwest::header::CONTENT_TYPE, content_type)
            .body(bytes)
            .send()
            .await
            .map_err(io_err)?;
        ensure_success(resp).await
    }

    pub async fn finalize(&self, gid: &str) -> AppResult<()> {
        let url = format!("{}/admin/{}/finalize", self.base_url, gid);
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(io_err)?;
        ensure_success(resp).await
    }

    pub async fn fetch_feedback(&self, gid: &str) -> AppResult<FeedbackResponse> {
        let url = format!("{}/admin/{}/feedback", self.base_url, gid);
        let resp = self
            .http
            .get(&url)
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(io_err)?;
        let resp = ensure_success_returning(resp).await?;
        resp.json::<FeedbackResponse>().await.map_err(io_err)
    }

    pub async fn fetch_views(&self, gid: &str) -> AppResult<Option<ViewedRecord>> {
        let url = format!("{}/admin/{}/views", self.base_url, gid);
        let resp = self
            .http
            .get(&url)
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(io_err)?;
        let resp = ensure_success_returning(resp).await?;
        // Worker returns the JSON value `null` (not an empty body) when the
        // gallery has no recorded views yet — `Option::deserialize` handles
        // that natively.
        resp.json::<Option<ViewedRecord>>().await.map_err(io_err)
    }

    pub async fn fetch_stats(&self) -> AppResult<GalleryStats> {
        let url = format!("{}/admin/stats", self.base_url);
        let resp = self
            .http
            .get(&url)
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(io_err)?;
        let resp = ensure_success_returning(resp).await?;
        resp.json::<GalleryStats>().await.map_err(io_err)
    }

    pub async fn recompute_stats(&self) -> AppResult<GalleryStats> {
        let url = format!("{}/admin/stats/recompute", self.base_url);
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(io_err)?;
        let resp = ensure_success_returning(resp).await?;
        resp.json::<GalleryStats>().await.map_err(io_err)
    }

    pub async fn delete_gallery(&self, gid: &str) -> AppResult<()> {
        let url = format!("{}/admin/{}", self.base_url, gid);
        let resp = self
            .http
            .delete(&url)
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(io_err)?;
        // 404 here is fine — Worker has already lost the gallery (e.g. it
        // was deleted out-of-band or expired and swept). Treat as success.
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(());
        }
        ensure_success(resp).await
    }
}

fn io_err(e: reqwest::Error) -> AppError {
    AppError::InvalidArgument(format!("gallery http: {e}"))
}

async fn ensure_success(resp: Response) -> AppResult<()> {
    let status = resp.status();
    if status.is_success() {
        return Ok(());
    }
    let body = resp.text().await.unwrap_or_default();
    Err(AppError::InvalidArgument(format!(
        "gallery worker returned {status}: {}",
        body.chars().take(200).collect::<String>()
    )))
}

async fn ensure_success_returning(resp: Response) -> AppResult<Response> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let body = resp.text().await.unwrap_or_default();
    Err(AppError::InvalidArgument(format!(
        "gallery worker returned {status}: {}",
        body.chars().take(200).collect::<String>()
    )))
}
