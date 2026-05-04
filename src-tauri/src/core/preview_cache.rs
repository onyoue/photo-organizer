//! Browser-renderable preview cache for RAW files.
//!
//! The webview's <img> tag can't decode camera RAW (CR2/ARW/NEF/ORF/RAF/...).
//! For the preview pane and 100% zoom view, we extract the camera's embedded
//! preview JPEG (via the same `thumbnail::load_oriented_image` path used for
//! grid thumbnails), encode it to JPEG, and stash the result alongside the
//! existing thumbnail cache. The desktop UI then asks for an "ensured"
//! preview path and feeds whatever comes back to convertFileSrc.
//!
//! For non-RAW formats (JPG/PNG/TIFF/etc.) the source path is returned
//! as-is — those decode natively in the webview, no cache step needed.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::core::thumbnail;
use crate::core::APP_DIR;
use crate::error::{AppError, AppResult};

/// Long-edge cap for cached previews. Chosen to comfortably feed both the
/// fit view and 100% zoom on typical 4K monitors without ballooning the
/// cache. The largest embedded preview camera JPEGs ship at the sensor's
/// full resolution (24-50MP) — we don't need that for desktop preview.
const PREVIEW_LONG_EDGE: u32 = 2400;
const PREVIEW_QUALITY: u8 = 90;
const PREVIEW_SUBDIR: &str = "previews";

fn preview_dir(folder: &Path) -> PathBuf {
    folder.join(APP_DIR).join(PREVIEW_SUBDIR)
}

fn cache_key(file_name: &str, size: u64, mtime: SystemTime) -> String {
    let mtime_secs = mtime
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut h = DefaultHasher::new();
    file_name.hash(&mut h);
    size.hash(&mut h);
    mtime_secs.hash(&mut h);
    PREVIEW_LONG_EDGE.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// For a non-RAW source, return the source path unchanged. For a RAW source,
/// extract the embedded preview JPEG, save it to
/// `<folder>/.photoorg/previews/<hash>.jpg`, and return the cached path.
/// Subsequent calls hit the cache and return immediately.
pub fn ensure_preview_path(folder: &Path, source: &Path) -> AppResult<PathBuf> {
    if !thumbnail::is_raw_path(source) {
        return Ok(source.to_path_buf());
    }

    let metadata = fs::metadata(source)?;
    let mtime = metadata.modified()?;
    let file_name = source
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Image("invalid file name".into()))?;
    let key = cache_key(file_name, metadata.len(), mtime);
    let dir = preview_dir(folder);
    fs::create_dir_all(&dir)?;
    let cached = dir.join(format!("{key}.jpg"));
    if cached.exists() {
        return Ok(cached);
    }

    let oriented = thumbnail::load_oriented_image(source)?;
    let preview = oriented.resize(
        PREVIEW_LONG_EDGE,
        PREVIEW_LONG_EDGE,
        image::imageops::FilterType::Triangle,
    );
    let mut bytes: Vec<u8> = Vec::new();
    let mut cursor = Cursor::new(&mut bytes);
    preview
        .to_rgb8()
        .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
            &mut cursor,
            PREVIEW_QUALITY,
        ))
        .map_err(|e| AppError::Image(format!("encode preview JPEG: {e}")))?;

    let tmp = cached.with_extension("jpg.tmp");
    fs::write(&tmp, &bytes)?;
    fs::rename(&tmp, &cached)?;
    Ok(cached)
}
