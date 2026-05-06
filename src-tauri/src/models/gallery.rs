use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::core::gallery_client::ViewedRecord;
use crate::models::settings::Decision;

/// Local record of one photo inside a created gallery. Lets the desktop
/// app map `pid` (used in feedback responses) back to the bundle the
/// photographer originally selected.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GalleryPhotoRecord {
    pub pid: String,
    pub bundle_id: String,
    pub source_path: String,
    pub filename: String,
    pub size: u64,
    pub content_type: String,
}

/// Local record of a gallery created by this app. Stored as an entry in
/// `app_data_dir/galleries.json`. The Worker is the source of truth for
/// feedback state; this struct just remembers what was sent and where,
/// plus a snapshot of the last fetched decisions so the dialog can show
/// state across app restarts without re-fetching.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GalleryRecord {
    pub gid: String,
    pub name: String,
    /// Public viewer URL — shareable link the photographer copied.
    pub url: String,
    pub created_at: String,
    pub expires_at: String,
    pub default_decision: Decision,
    /// Source folder path the photos were uploaded from. Lets the apply
    /// step warn when a different folder is currently open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_folder: Option<String>,
    /// Optional model name attached at share time. Drives per-model
    /// feedback bucketing on apply — bundles store decisions under this
    /// key in their sidecar's `feedback_by_model` map. Empty / None for
    /// galleries shared without a specific model (e.g. group / pair
    /// gallery duplicated to each recipient).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_name: Option<String>,
    pub photos: Vec<GalleryPhotoRecord>,
    /// Last fetched per-pid decisions from the Worker. Kept here so the
    /// galleries dialog can display state without re-running fetch_feedback
    /// after every app restart.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub last_decisions: HashMap<String, Decision>,
    /// ISO-8601 timestamp of the last successful feedback fetch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_fetched_at: Option<String>,
    /// Cached read-receipt from the Worker. `None` either when the model
    /// hasn't opened the gallery yet or when this record predates the
    /// view-tracking feature; the dialog tells the user "未閲覧" in both
    /// cases. Refreshed during `fetch_gallery_feedback`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_views: Option<ViewedRecord>,
}

