use serde::{Deserialize, Serialize};

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderIndex {
    pub version: u32,
    pub scanned_at: String,
    pub folder_path: String,
    pub folder_mtime: String,
    pub bundles: Vec<BundleSummary>,
}
