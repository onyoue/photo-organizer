use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    X,
    Instagram,
    Note,
    Other,
}

impl Platform {
    pub fn as_str(&self) -> &'static str {
        match self {
            Platform::X => "x",
            Platform::Instagram => "instagram",
            Platform::Note => "note",
            Platform::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum PostBy {
    #[serde(rename = "self")]
    Self_,
    #[serde(rename = "model")]
    Model,
    #[serde(rename = "other")]
    Other,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Flag {
    /// Gallery FAV vote — model explicitly favourited at least one variant.
    Pick,
    /// Gallery OK vote — model touched the photo and confirmed (not FAV, not NG).
    Ok,
    /// Gallery NG vote — model rejected.
    Reject,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostRecord {
    pub id: String,
    pub platform: Platform,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub posted_at: Option<String>,
    pub by: PostBy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub posted_by_handle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleSidecar {
    pub version: u32,
    pub bundle_id: String,
    pub base_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rating: Option<u8>,
    /// Aggregate flag — derived from `feedback_by_model` when present, or
    /// set directly in single-model (legacy) mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flag: Option<Flag>,
    /// Per-model gallery feedback. Key is the gallery's `model_name`
    /// (empty string for galleries without a model name = anonymous).
    /// Absent on legacy single-flag sidecars; populated as soon as a
    /// model-tagged gallery's feedback gets applied.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub feedback_by_model: HashMap<String, Flag>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default)]
    pub posts: Vec<PostRecord>,
    pub created_at: String,
    pub updated_at: String,
}

impl BundleSidecar {
    /// True when nothing is set — caller should delete the file rather than write
    /// an empty record (see REQUIREMENTS §7.3).
    pub fn is_empty_payload(&self) -> bool {
        self.posts.is_empty()
            && self.tags.is_empty()
            && self.rating.is_none()
            && self.flag.is_none()
            && self.feedback_by_model.is_empty()
    }
}

/// Reduce per-model verdicts to a single aggregate flag using the same
/// precedence as the gallery feedback application: any FAV → Pick,
/// otherwise any NG → Reject, otherwise any OK → Ok, otherwise None.
pub fn aggregate_flag(map: &HashMap<String, Flag>) -> Option<Flag> {
    if map.values().any(|f| matches!(f, Flag::Pick)) {
        Some(Flag::Pick)
    } else if map.values().any(|f| matches!(f, Flag::Reject)) {
        Some(Flag::Reject)
    } else if map.values().any(|f| matches!(f, Flag::Ok)) {
        Some(Flag::Ok)
    } else {
        None
    }
}
