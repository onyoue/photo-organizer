use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppSettings {
    /// Absolute path to a custom RAW developer executable. The user is
    /// developing their own and wants Open RAW to launch *that*, not the
    /// OS default. None falls back to the OS handler.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_developer_path: Option<String>,
}
