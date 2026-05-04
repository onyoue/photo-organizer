use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::models::sidecar::Flag;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileRole {
    Raw,
    Jpeg,
    Sidecar,
    Developed,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleFile {
    pub role: FileRole,
    pub path: String,
    pub size: u64,
    pub mtime: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleSummary {
    pub bundle_id: String,
    pub base_name: String,
    pub files: Vec<BundleFile>,
    /// Sidecar-derived: any posts recorded for this bundle.
    #[serde(default)]
    pub has_posts: bool,
    /// Sidecar-derived: distinct platforms ("x", "instagram", "note", "other").
    #[serde(default)]
    pub post_platforms: Vec<String>,
    /// Sidecar-derived: at least one post is by the model rather than the
    /// photographer — rendered with a dashed visual cue (REQUIREMENTS F3.4).
    #[serde(default)]
    pub has_model_post: bool,
    /// Sidecar-derived 1..=5 rating, None for unrated (REQUIREMENTS F4.1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rating: Option<u8>,
    /// Sidecar-derived aggregate flag (any FAV → pick / any NG → reject /
    /// any OK → ok). For multi-model bundles this is a reduction of
    /// `feedback_by_model`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flag: Option<Flag>,
    /// Per-model gallery verdicts. Empty for legacy single-flag bundles.
    /// Key is the gallery's `model_name` (empty string for galleries that
    /// were shared without one).
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub feedback_by_model: HashMap<String, Flag>,
    /// Sidecar-derived freeform tags (REQUIREMENTS F4.2).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderIndex {
    pub version: u32,
    pub scanned_at: String,
    pub folder_path: String,
    pub folder_mtime: String,
    pub bundles: Vec<BundleSummary>,
}
