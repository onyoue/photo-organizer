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
    Pick,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flag: Option<Flag>,
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
    }
}
