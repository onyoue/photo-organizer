use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RawDeveloperEntry {
    pub name: String,
    pub path: String,
}

/// Per-photo verdict from the gallery viewer. `Fav` is an explicit
/// "I love this one" signal layered on top of the binary OK/NG —
/// only valid as a per-photo decision, never as a gallery default.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Ok,
    Ng,
    Fav,
}

impl Default for Decision {
    fn default() -> Self {
        Self::Ok
    }
}

/// Configuration for shared photo galleries hosted on a Cloudflare Worker
/// (see gallery-worker/). Empty fields disable the share feature; the
/// desktop app refuses to upload if either URL or token is missing.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct GallerySettings {
    /// Base URL of the deployed Worker, e.g. https://photo-gallery.x.workers.dev
    /// (no trailing slash).
    #[serde(default)]
    pub worker_url: String,
    /// Shared secret matching the Worker's ADMIN_TOKEN. Sent as
    /// Authorization: Bearer <token> on all admin endpoints.
    #[serde(default)]
    pub admin_token: String,
    /// What an unflagged photo means in the gallery — usually "ok" so the
    /// model only has to tap the photos they want to flag.
    #[serde(default)]
    pub default_decision: Decision,
}

impl GallerySettings {
    pub fn is_configured(&self) -> bool {
        !self.worker_url.trim().is_empty() && !self.admin_token.trim().is_empty()
    }

    /// Worker URL with any trailing slash stripped, suitable for path concat.
    pub fn base_url(&self) -> &str {
        self.worker_url.trim_end_matches('/')
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppSettings {
    /// Configured RAW developer apps. The user can register more than one
    /// (e.g. their stable Lightroom + their in-progress dev binary) and
    /// switch between them with Shift+R at runtime.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub raw_developers: Vec<RawDeveloperEntry>,

    /// Index into `raw_developers` of the developer currently bound to R /
    /// the Open RAW button. Out-of-range values are treated as "no entry"
    /// and fall through to the OS default.
    #[serde(default)]
    pub active_raw_developer_index: usize,

    /// Legacy single-path field — read at load time and migrated into
    /// `raw_developers[0]` if the new list is empty, never written back.
    /// Kept on the type so existing settings.json files still parse.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_developer_path: Option<String>,

    /// Photo gallery share configuration (Cloudflare Worker URL + token).
    #[serde(default)]
    pub gallery: GallerySettings,

    /// Set to true after the user dismisses the first-run welcome dialog.
    /// New installs default to false → dialog shows once, "閉じる" flips
    /// this to true and saves immediately so subsequent launches go
    /// straight into the app.
    #[serde(default)]
    pub welcome_seen: bool,
}

impl AppSettings {
    /// Promote a legacy single-path field into the list shape. Idempotent —
    /// if the new list already has entries, the legacy field is just dropped.
    pub fn migrate_legacy(mut self) -> Self {
        if self.raw_developers.is_empty() {
            if let Some(legacy) = self.raw_developer_path.take() {
                if !legacy.trim().is_empty() {
                    self.raw_developers.push(RawDeveloperEntry {
                        name: "RAW developer".to_string(),
                        path: legacy,
                    });
                    self.active_raw_developer_index = 0;
                }
            }
        } else {
            // Already on the new shape; the legacy field is redundant.
            self.raw_developer_path = None;
        }
        self
    }

    /// The developer entry the next Open-RAW invocation should target, or
    /// None when nothing is configured (caller falls back to the OS default).
    pub fn active_raw_developer(&self) -> Option<&RawDeveloperEntry> {
        self.raw_developers.get(self.active_raw_developer_index)
    }
}
