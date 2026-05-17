use std::fs;
use std::path::Path;

use little_exif::exif_tag::ExifTag;
use little_exif::metadata::Metadata;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Cw,
    Ccw,
}

// EXIF Orientation transformation maps. Index 0 is unused (orientations
// are 1-indexed); index N gives the new orientation for an image
// currently at orientation N being rotated CW/CCW. Verified by tests
// below — CW⁴ and CW∘CCW are both identity.
const CW_MAP:  [u16; 9] = [0, 6, 7, 8, 5, 2, 3, 4, 1];
const CCW_MAP: [u16; 9] = [0, 8, 5, 6, 7, 4, 1, 2, 3];

#[derive(Debug, Clone, Serialize)]
pub struct RotateOutcome {
    pub path: String,
    pub status: String,        // "ok" | "skipped" | "error"
    pub error: Option<String>,
    /// Fresh mtime in RFC-3339 (matches BundleFile.mtime) so the
    /// frontend can patch its in-memory index after a successful write
    /// — needed so the thumbnail-cache effect re-runs with the new key.
    pub new_mtime: Option<String>,
    pub new_size: Option<u64>,
}

/// Mutate the Orientation EXIF tag on every supported image in `files`.
/// Only formats little_exif can round-trip are touched; RAWs and
/// sidecars are returned as "skipped" so the caller can surface them
/// in the UI (the photographer rotates RAW via their developer).
pub fn rotate_files(folder: &Path, files: &[String], dir: Direction) -> Vec<RotateOutcome> {
    files
        .iter()
        .map(|f| {
            let abs = folder.join(f);
            let path_str = f.clone();
            match rotate_one(&abs, dir) {
                Ok(Some((mtime, size))) => RotateOutcome {
                    path: path_str,
                    status: "ok".into(),
                    error: None,
                    new_mtime: Some(mtime),
                    new_size: Some(size),
                },
                Ok(None) => RotateOutcome {
                    path: path_str,
                    status: "skipped".into(),
                    error: Some("unsupported file type".into()),
                    new_mtime: None,
                    new_size: None,
                },
                Err(e) => RotateOutcome {
                    path: path_str,
                    status: "error".into(),
                    error: Some(e.to_string()),
                    new_mtime: None,
                    new_size: None,
                },
            }
        })
        .collect()
}

/// Returns Some((new_mtime, new_size)) when the file was rotated, None
/// when the extension is one we deliberately skip (RAW etc.).
fn rotate_one(path: &Path, dir: Direction) -> AppResult<Option<(String, u64)>> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    // little_exif explicitly supports JPEG, PNG, TIFF, JXL, HEIF, WebP.
    // RAW files are TIFF-like but writing them risks corrupting maker-
    // notes / non-standard IFD layout, so we skip them.
    if !matches!(
        ext.as_str(),
        "jpg" | "jpeg" | "png" | "heic" | "heif" | "webp" | "tif" | "tiff"
    ) {
        return Ok(None);
    }

    let mut meta = Metadata::new_from_path(path)
        .map_err(|e| AppError::Image(format!("read EXIF from {}: {e}", path.display())))?;

    let current = meta
        .get_tag(&ExifTag::Orientation(vec![]))
        .next()
        .and_then(|tag| match tag {
            ExifTag::Orientation(v) => v.first().copied(),
            _ => None,
        })
        .unwrap_or(1);

    let idx = current.clamp(1, 8) as usize;
    let next = match dir {
        Direction::Cw => CW_MAP[idx],
        Direction::Ccw => CCW_MAP[idx],
    };

    meta.set_tag(ExifTag::Orientation(vec![next]));
    meta.write_to_file(path)
        .map_err(|e| AppError::Image(format!("write EXIF to {}: {e}", path.display())))?;

    let metadata = fs::metadata(path)?;
    let size = metadata.len();
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339().into())
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

    Ok(Some((mtime, size)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cw_ccw_is_identity() {
        for o in 1u16..=8 {
            let after = CW_MAP[o as usize];
            let back = CCW_MAP[after as usize];
            assert_eq!(back, o, "CW→CCW must be identity for orientation {o}");
        }
    }

    #[test]
    fn cw_four_times_loops() {
        for o in 1u16..=8 {
            let mut cur = o;
            for _ in 0..4 {
                cur = CW_MAP[cur as usize];
            }
            assert_eq!(cur, o, "CW⁴ must be identity for orientation {o}");
        }
    }

    #[test]
    fn ccw_four_times_loops() {
        for o in 1u16..=8 {
            let mut cur = o;
            for _ in 0..4 {
                cur = CCW_MAP[cur as usize];
            }
            assert_eq!(cur, o, "CCW⁴ must be identity for orientation {o}");
        }
    }

    #[test]
    fn known_cw_transitions() {
        // Sanity-check against the EXIF spec rotation table.
        assert_eq!(CW_MAP[1], 6); // normal → 90° CW
        assert_eq!(CW_MAP[6], 3); // 90° CW → 180°
        assert_eq!(CW_MAP[3], 8); // 180° → 270° CW
        assert_eq!(CW_MAP[8], 1); // 270° CW → normal
    }
}
