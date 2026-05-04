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
    /// 64-bit difference hash of the bundle's primary visual file (developed
    /// JPG → in-camera JPG → RAW preview, in that order). Stored in
    /// `.photoorg/index.json` so cross-folder image search can rank candidates
    /// without re-reading photos. Serialized as a 16-char hex string for
    /// JS-Number safety. None when computation failed (file missing, decode
    /// error, etc.).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "phash_hex_opt"
    )]
    pub phash: Option<u64>,
}

/// Serde adapter that round-trips `Option<u64>` through a 16-char hex string.
/// JavaScript's `Number` only safely represents integers up to 2^53, so a
/// raw 64-bit hash would lose bits crossing the Tauri IPC boundary. Hex
/// strings sidestep that without dragging in a BigInt-style alternative.
mod phash_hex_opt {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(
        value: &Option<u64>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            Some(v) => serializer.serialize_str(&format!("{:016x}", v)),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<u64>, D::Error> {
        let opt: Option<String> = Option::deserialize(deserializer)?;
        match opt {
            Some(s) => u64::from_str_radix(s.trim_start_matches("0x"), 16)
                .map(Some)
                .map_err(serde::de::Error::custom),
            None => Ok(None),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderIndex {
    pub version: u32,
    pub scanned_at: String,
    pub folder_path: String,
    pub folder_mtime: String,
    pub bundles: Vec<BundleSummary>,
}
