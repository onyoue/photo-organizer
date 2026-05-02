use serde::{Deserialize, Serialize};

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
/// feedback state; this struct just remembers what was sent and where.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GalleryRecord {
    pub gid: String,
    pub name: String,
    /// Public viewer URL — shareable link the photographer copied.
    pub url: String,
    pub created_at: String,
    pub expires_at: String,
    pub default_decision: Decision,
    pub photos: Vec<GalleryPhotoRecord>,
}

impl GalleryRecord {
    pub fn is_expired(&self, now: chrono::DateTime<chrono::Utc>) -> bool {
        match chrono::DateTime::parse_from_rfc3339(&self.expires_at) {
            Ok(t) => t.with_timezone(&chrono::Utc) <= now,
            Err(_) => true,
        }
    }
}
