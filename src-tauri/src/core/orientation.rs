use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::core::thumbnail;
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
    pub status: String, // "ok" | "skipped" | "error"
    pub error: Option<String>,
    /// Fresh mtime in RFC-3339 (matches BundleFile.mtime) so the
    /// frontend can patch its in-memory index after a successful write
    /// — needed so the thumbnail-cache effect re-runs with the new key.
    pub new_mtime: Option<String>,
    pub new_size: Option<u64>,
}

/// Mutate the Orientation EXIF tag on every supported image in `files`.
/// Only JPG/JPEG is handled (the overwhelmingly common case for the
/// culling workflow); RAWs / PNGs / sidecars are returned as "skipped"
/// so the caller can surface them.
pub fn rotate_files(folder: &Path, files: &[String], dir: Direction) -> Vec<RotateOutcome> {
    files
        .iter()
        .map(|f| {
            let abs = folder.join(f);
            let path_str = f.clone();
            match rotate_one(&abs, dir) {
                Ok(Some((mtime, size))) => {
                    // Bust the thumbnail cache for this file. The cache key
                    // uses mtime at *second* granularity, so a same-second
                    // rotation would otherwise re-serve the pre-rotation
                    // webp. Best-effort — a leftover stale webp would
                    // just mean the grid shows the old orientation until
                    // the next genuine mtime advance.
                    if let Some(thumb_path) = thumbnail::cached_thumb_path(folder, &abs) {
                        let _ = fs::remove_file(&thumb_path);
                    }
                    RotateOutcome {
                        path: path_str,
                        status: "ok".into(),
                        error: None,
                        new_mtime: Some(mtime),
                        new_size: Some(size),
                    }
                }
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

fn rotate_one(path: &Path, dir: Direction) -> AppResult<Option<(String, u64)>> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    if !matches!(ext.as_str(), "jpg" | "jpeg") {
        return Ok(None);
    }

    patch_jpg_orientation(path, dir)?;

    let meta = fs::metadata(path)?;
    let size = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

    Ok(Some((mtime, size)))
}

/// Surgical in-place patch of the Orientation tag in a JPEG's APP1 EXIF
/// segment. Only the two value bytes of tag 0x0112 are rewritten; the
/// rest of the file — including unknown segments, maker-notes, ICC
/// profiles, thumbnails — is preserved byte-for-byte. Returns an error
/// when the JPG has no APP1/EXIF segment or no Orientation tag.
fn patch_jpg_orientation(path: &Path, dir: Direction) -> AppResult<()> {
    let mut bytes = fs::read(path)?;

    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return Err(AppError::Image("not a JPEG (bad SOI)".into()));
    }

    // Walk JPEG segments looking for the APP1 marker (0xFFE1) whose data
    // begins with the literal ASCII "Exif\0\0". XMP and other APP1
    // variants are skipped. Stop at SOS (DA) / EOI (D9) — EXIF always
    // appears before image data.
    let mut i: usize = 2;
    let mut tiff_start: Option<usize> = None;
    while i + 4 <= bytes.len() {
        if bytes[i] != 0xFF {
            return Err(AppError::Image(format!(
                "malformed JPEG: expected marker prefix at offset {i}"
            )));
        }
        // Skip 0xFF padding (`FF FF FF ...` is allowed before a marker).
        let mut marker_at = i + 1;
        while marker_at < bytes.len() && bytes[marker_at] == 0xFF {
            marker_at += 1;
        }
        if marker_at >= bytes.len() {
            return Err(AppError::Image("truncated JPEG before marker".into()));
        }
        let marker = bytes[marker_at];

        if marker == 0xD9 || marker == 0xDA {
            break;
        }
        // Standalone markers without length: SOI (D8), TEM (01), RSTn
        // (D0..D7). EXIF won't be among these — just walk past.
        if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            i = marker_at + 1;
            continue;
        }

        // Length field follows the marker, 2 bytes big-endian, includes
        // itself but not the FF XX marker.
        if marker_at + 3 > bytes.len() {
            return Err(AppError::Image("truncated JPEG segment length".into()));
        }
        let length = u16::from_be_bytes([bytes[marker_at + 1], bytes[marker_at + 2]]) as usize;
        if length < 2 {
            return Err(AppError::Image("malformed JPEG segment length".into()));
        }
        let seg_data_start = marker_at + 3;
        let seg_data_end = marker_at + 1 + length;
        if seg_data_end > bytes.len() {
            return Err(AppError::Image("JPEG segment length past EOF".into()));
        }

        if marker == 0xE1 && (seg_data_end - seg_data_start) >= 6 {
            if &bytes[seg_data_start..seg_data_start + 6] == b"Exif\0\0" {
                tiff_start = Some(seg_data_start + 6);
                break;
            }
        }

        i = seg_data_end;
    }

    let tiff = tiff_start
        .ok_or_else(|| AppError::Image("JPEG has no EXIF (APP1) segment".into()))?;

    if tiff + 8 > bytes.len() {
        return Err(AppError::Image("EXIF segment truncated before TIFF header".into()));
    }

    let big_endian = match (bytes[tiff], bytes[tiff + 1]) {
        (0x49, 0x49) => false, // II = little
        (0x4D, 0x4D) => true,  // MM = big
        _ => return Err(AppError::Image("EXIF: bad endian marker".into())),
    };

    let read_u16 = |buf: &[u8]| -> u16 {
        if big_endian {
            u16::from_be_bytes([buf[0], buf[1]])
        } else {
            u16::from_le_bytes([buf[0], buf[1]])
        }
    };
    let read_u32 = |buf: &[u8]| -> u32 {
        if big_endian {
            u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]])
        } else {
            u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]])
        }
    };

    let magic = read_u16(&bytes[tiff + 2..]);
    if magic != 42 {
        return Err(AppError::Image(format!("EXIF: bad TIFF magic {magic}")));
    }

    let ifd0_offset = read_u32(&bytes[tiff + 4..]) as usize;
    let ifd0 = tiff + ifd0_offset;
    if ifd0 + 2 > bytes.len() {
        return Err(AppError::Image("EXIF: IFD0 offset out of range".into()));
    }
    let entry_count = read_u16(&bytes[ifd0..]) as usize;

    // Walk IFD0 entries looking for Orientation (0x0112). Each entry is
    // 12 bytes: tag_id (2), type (2), count (4), value/offset (4). For
    // SHORT with count=1 (Orientation's canonical form), the 2-byte
    // value is stored inline in the first 2 bytes of the value field.
    let mut value_pos: Option<(usize, u16)> = None;
    for n in 0..entry_count {
        let entry = ifd0 + 2 + n * 12;
        if entry + 12 > bytes.len() {
            return Err(AppError::Image("EXIF: IFD0 entries truncated".into()));
        }
        let tag_id = read_u16(&bytes[entry..]);
        if tag_id == 0x0112 {
            let current = read_u16(&bytes[entry + 8..]);
            value_pos = Some((entry + 8, current));
            break;
        }
    }

    let (value_offset, current) = value_pos.ok_or_else(|| {
        AppError::Image(
            "EXIF has no Orientation tag — rotate via an image editor instead".into(),
        )
    })?;

    let idx = current.clamp(1, 8) as usize;
    let next = match dir {
        Direction::Cw => CW_MAP[idx],
        Direction::Ccw => CCW_MAP[idx],
    };

    let value_bytes = if big_endian {
        next.to_be_bytes()
    } else {
        next.to_le_bytes()
    };
    bytes[value_offset] = value_bytes[0];
    bytes[value_offset + 1] = value_bytes[1];

    // Atomic write: tmp → rename, so a power loss can't leave a half-
    // written JPG that wouldn't even decode.
    let tmp = path.with_extension("jpg.rotate.tmp");
    fs::write(&tmp, &bytes)?;
    fs::rename(&tmp, path)?;

    Ok(())
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
        assert_eq!(CW_MAP[1], 6); // normal → 90° CW
        assert_eq!(CW_MAP[6], 3); // 90° CW → 180°
        assert_eq!(CW_MAP[3], 8); // 180° → 270° CW
        assert_eq!(CW_MAP[8], 1); // 270° CW → normal
    }

    /// Build a minimal valid JPEG with an APP1 EXIF segment containing a
    /// single IFD0 Orientation tag. Used by the patch tests to round-trip
    /// without needing a photo fixture on disk.
    fn make_jpg_with_orientation(orientation: u16, big_endian: bool) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&[0xFF, 0xD8]); // SOI

        let mut tiff = Vec::new();
        if big_endian {
            tiff.extend_from_slice(&[0x4D, 0x4D]);
            tiff.extend_from_slice(&42u16.to_be_bytes());
            tiff.extend_from_slice(&8u32.to_be_bytes());
            tiff.extend_from_slice(&1u16.to_be_bytes());
            tiff.extend_from_slice(&0x0112u16.to_be_bytes());
            tiff.extend_from_slice(&3u16.to_be_bytes());
            tiff.extend_from_slice(&1u32.to_be_bytes());
            tiff.extend_from_slice(&orientation.to_be_bytes());
            tiff.extend_from_slice(&[0, 0]);
            tiff.extend_from_slice(&0u32.to_be_bytes());
        } else {
            tiff.extend_from_slice(&[0x49, 0x49]);
            tiff.extend_from_slice(&42u16.to_le_bytes());
            tiff.extend_from_slice(&8u32.to_le_bytes());
            tiff.extend_from_slice(&1u16.to_le_bytes());
            tiff.extend_from_slice(&0x0112u16.to_le_bytes());
            tiff.extend_from_slice(&3u16.to_le_bytes());
            tiff.extend_from_slice(&1u32.to_le_bytes());
            tiff.extend_from_slice(&orientation.to_le_bytes());
            tiff.extend_from_slice(&[0, 0]);
            tiff.extend_from_slice(&0u32.to_le_bytes());
        }

        let app1_payload_len = 6 + tiff.len();
        let app1_seg_len = (app1_payload_len + 2) as u16;
        bytes.extend_from_slice(&[0xFF, 0xE1]);
        bytes.extend_from_slice(&app1_seg_len.to_be_bytes());
        bytes.extend_from_slice(b"Exif\0\0");
        bytes.extend_from_slice(&tiff);

        bytes.extend_from_slice(&[0xFF, 0xD9]); // EOI
        bytes
    }

    fn tempfile(name: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("cullback_orient_{}_{}.jpg", name, ulid::Ulid::new()));
        p
    }

    #[test]
    fn patches_little_endian_jpg() {
        let path = tempfile("le");
        fs::write(&path, make_jpg_with_orientation(1, false)).unwrap();
        patch_jpg_orientation(&path, Direction::Cw).unwrap();
        let bytes = fs::read(&path).unwrap();
        // Layout: SOI(2) + APP1 marker(2) + len(2) + "Exif\0\0"(6) +
        // TIFF header(8) + IFD0 entry-count(2) + entry-tag(2) + type(2)
        // + count(4) = 30 bytes before the value field.
        let value_pos = 2 + 2 + 2 + 6 + 8 + 2 + 2 + 2 + 4;
        let new = u16::from_le_bytes([bytes[value_pos], bytes[value_pos + 1]]);
        assert_eq!(new, 6, "CW from orientation 1 should land on 6");
        fs::remove_file(&path).ok();
    }

    #[test]
    fn patches_big_endian_jpg() {
        let path = tempfile("be");
        fs::write(&path, make_jpg_with_orientation(6, true)).unwrap();
        patch_jpg_orientation(&path, Direction::Cw).unwrap();
        let bytes = fs::read(&path).unwrap();
        let value_pos = 2 + 2 + 2 + 6 + 8 + 2 + 2 + 2 + 4;
        let new = u16::from_be_bytes([bytes[value_pos], bytes[value_pos + 1]]);
        assert_eq!(new, 3, "CW from orientation 6 should land on 3");
        fs::remove_file(&path).ok();
    }

    #[test]
    fn round_trip_cw_then_ccw_is_identity() {
        let path = tempfile("rt");
        let original = make_jpg_with_orientation(1, false);
        fs::write(&path, &original).unwrap();
        patch_jpg_orientation(&path, Direction::Cw).unwrap();
        patch_jpg_orientation(&path, Direction::Ccw).unwrap();
        let after = fs::read(&path).unwrap();
        assert_eq!(original, after, "CW then CCW must leave the file byte-identical");
        fs::remove_file(&path).ok();
    }
}
