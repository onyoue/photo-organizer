use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use exif::{In, Reader, Tag};
use image::imageops::FilterType;
use image::DynamicImage;
use rawler::decoders::RawDecodeParams;
use rawler::rawsource::RawSource;

use crate::core::APP_DIR;
use crate::error::{AppError, AppResult};

/// Extensions handled via the camera-RAW path. Lower-case, no leading dot.
/// We try `rawler::Decoder::preview_image` first (typically 1920px+ embedded
/// JPEG) and fall back to `thumbnail_image` (160-240px) when preview is
/// unavailable. Anything not in this list goes through `image::open`.
const RAW_EXTENSIONS: &[&str] = &[
    "arw", "cr2", "cr3", "nef", "nrw", "dng", "raf", "orf",
    // ORI is OM Digital's handheld high-res ORF variant. Same internal
    // structure, same fallback path.
    "ori",
    "rw2", "pef", "srw", "raw", "3fr", "fff",
];

// Long-edge target for the cached thumbnail. The L tile is 320 CSS px wide;
// with object-fit: cover on a 3:2 photo that visually crops the long edge to
// about 480 px, and a 2x DPI display doubles that again. 800 keeps L tiles
// crisp on Retina / 200% Windows scaling, with headroom on 1x.
const THUMB_LONG_EDGE: u32 = 800;
const THUMB_QUALITY: f32 = 80.0;
const THUMB_SUBDIR: &str = "thumbs";

pub fn thumb_dir(folder: &Path) -> PathBuf {
    folder.join(APP_DIR).join(THUMB_SUBDIR)
}

fn cache_key(file_name: &str, size: u64, mtime: SystemTime) -> String {
    let mtime_secs = mtime
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut h = DefaultHasher::new();
    // Path-independent: the same file (by name/size/mtime) lands at the same
    // cache key whether it lives in `shoot_2026/` or `shoot_2026/select/`.
    // That lets us migrate the cached webp by simple rename when the user
    // moves bundles between folders.
    file_name.hash(&mut h);
    size.hash(&mut h);
    mtime_secs.hash(&mut h);
    // Including the long-edge target means tweaking THUMB_LONG_EDGE (this
    // happened when 320 → 800 to fix high-DPI blur) automatically invalidates
    // every cache entry — they get a different hash and re-render lazily.
    THUMB_LONG_EDGE.hash(&mut h);
    format!("{:016x}", h.finish())
}

fn key_for_file(source: &Path) -> AppResult<String> {
    let metadata = fs::metadata(source)?;
    let mtime = metadata.modified()?;
    let file_name = source
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Image("invalid file name".into()))?;
    Ok(cache_key(file_name, metadata.len(), mtime))
}

/// The path where the cached thumbnail *would* live for the given source file,
/// or None when metadata can't be read (e.g., the source file is gone). This
/// is what fileops uses to follow the cache when bundles get reorganised.
pub fn cached_thumb_path(folder: &Path, source: &Path) -> Option<PathBuf> {
    let key = key_for_file(source).ok()?;
    Some(thumb_dir(folder).join(format!("{key}.webp")))
}

pub fn ensure_thumbnail(folder: &Path, source: &Path) -> AppResult<PathBuf> {
    let key = key_for_file(source)?;
    let dir = thumb_dir(folder);
    fs::create_dir_all(&dir)?;
    let out = dir.join(format!("{key}.webp"));
    if out.exists() {
        return Ok(out);
    }

    generate_thumbnail(source, &out)?;
    Ok(out)
}

fn generate_thumbnail(input: &Path, output: &Path) -> AppResult<()> {
    let oriented = load_oriented_image(input)?;
    let resized = oriented.resize(THUMB_LONG_EDGE, THUMB_LONG_EDGE, FilterType::Triangle);
    let rgb = resized.to_rgb8();
    let (w, h) = (rgb.width(), rgb.height());
    let encoder = webp::Encoder::from_rgb(rgb.as_raw(), w, h);
    let webp_data = encoder.encode(THUMB_QUALITY);

    // Atomic write: tmp -> rename, so partial files never appear at the cache path.
    let tmp = output.with_extension("webp.tmp");
    fs::write(&tmp, &*webp_data)?;
    fs::rename(&tmp, output)?;
    Ok(())
}

/// Public helper used by the phash module: load `path` as a `DynamicImage`,
/// going through the RAW preview path for camera-RAW extensions. Same logic
/// as the thumbnail pipeline so the cached webp and the computed phash
/// always reflect the same source bytes.
pub fn load_for_hashing(path: &Path) -> AppResult<DynamicImage> {
    load_source_image(path)
}

/// True when `path` is a camera-RAW file we route through rawler / the
/// embedded-JPEG fallback. Exposed for the preview-cache module so it
/// uses the same classification.
pub fn is_raw_path(path: &Path) -> bool {
    is_raw_extension(path)
}

/// Load + EXIF-orient an image at `path`. Single-step variant of
/// `load_source_image` followed by orientation correction; shared between
/// the thumbnail and preview-cache pipelines so both end up with the same
/// rotation.
pub fn load_oriented_image(path: &Path) -> AppResult<DynamicImage> {
    let img = load_source_image(path)?;
    let orient = read_exif_orientation(path).unwrap_or(1);
    Ok(apply_orientation(img, orient))
}

fn is_raw_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .map(|s| RAW_EXTENSIONS.iter().any(|raw| raw.eq_ignore_ascii_case(s)))
        .unwrap_or(false)
}

fn load_source_image(path: &Path) -> AppResult<DynamicImage> {
    if is_raw_extension(path) {
        load_raw_preview(path)
    } else {
        image::open(path).map_err(|e| AppError::Image(e.to_string()))
    }
}

/// Pull the camera-embedded preview / thumbnail JPEG out of a RAW file.
///
/// Strategy, in order:
///   1. `rawler::Decoder::preview_image` — the format-aware path; gives the
///      full-resolution embedded JPEG when the decoder implements it.
///   2. `rawler::Decoder::thumbnail_image` — smaller embedded thumbnail.
///   3. Manual SOI scan — for decoders that don't override either of the
///      above (e.g. ORF / RAF), walk the file looking for `FF D8 FF` JPEG
///      start markers and pick the one that decodes to the largest image.
///      Slower than rawler's path but format-agnostic, so we get something
///      usable for any RAW that ships an embedded JPEG (which is essentially
///      all of them — the camera needs it for its own back-of-screen preview).
fn load_raw_preview(path: &Path) -> AppResult<DynamicImage> {
    let source = RawSource::new(path)
        .map_err(|e| AppError::Image(format!("RAW open {}: {e}", path.display())))?;
    let decoder = rawler::get_decoder(&source)
        .map_err(|e| AppError::Image(format!("RAW decoder: {e}")))?;
    let params = RawDecodeParams::default();
    if let Ok(Some(img)) = decoder.preview_image(&source, &params) {
        return Ok(img);
    }
    if let Ok(Some(img)) = decoder.thumbnail_image(&source, &params) {
        return Ok(img);
    }
    // Decoder didn't implement either preview path; fall back to the
    // manual JPEG-SOI sweep over the rawsource bytes.
    if let Some(img) = extract_largest_embedded_jpeg(source.buf()) {
        return Ok(img);
    }
    Err(AppError::Image(format!(
        "no embedded preview in RAW: {}",
        path.display()
    )))
}

/// Walk `bytes` looking for JPEG Start-of-Image markers (`FF D8 FF`) and
/// decode each candidate, returning the one with the largest pixel area.
/// Bounded to the first 16 MiB of the file so we don't scan into the
/// RAW pixel array on big files (typical embedded previews live in the
/// first 1–4 MiB).
fn extract_largest_embedded_jpeg(bytes: &[u8]) -> Option<DynamicImage> {
    const SCAN_LIMIT: usize = 16 * 1024 * 1024;
    let limit = bytes.len().min(SCAN_LIMIT);
    let mut best: Option<DynamicImage> = None;
    let mut best_area: u64 = 0;
    let mut i: usize = 0;
    while i + 3 < limit {
        if bytes[i] == 0xFF && bytes[i + 1] == 0xD8 && bytes[i + 2] == 0xFF {
            // image::load_from_memory stops at the first complete JPEG and
            // is tolerant of trailing data — perfect for our case where
            // bytes[i..] continues into TIFF metadata or other JPEGs.
            if let Ok(img) = image::load_from_memory(&bytes[i..]) {
                let area = u64::from(img.width()) * u64::from(img.height());
                if area > best_area {
                    best_area = area;
                    best = Some(img);
                }
            }
            // Advance past the SOI bytes regardless of decode success — the
            // 2-byte hop skips this marker without missing potentially
            // overlapping SOIs in pathological files.
            i += 2;
        } else {
            i += 1;
        }
    }
    best
}

fn read_exif_orientation(path: &Path) -> Option<u32> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let exif = Reader::new().read_from_container(&mut reader).ok()?;
    exif.get_field(Tag::Orientation, In::PRIMARY)?
        .value
        .get_uint(0)
}

fn apply_orientation(img: DynamicImage, orient: u32) -> DynamicImage {
    match orient {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageBuffer;
    use ulid::Ulid;

    fn tempdir_for_test() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("photoorg_thumb_{}", Ulid::new()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn generates_webp_thumbnail_and_caches() {
        let tmp = tempdir_for_test();
        let jpg = tmp.join("test.jpg");
        let buf: ImageBuffer<image::Rgb<u8>, _> = ImageBuffer::from_fn(400, 200, |x, y| {
            image::Rgb([(x % 255) as u8, (y % 255) as u8, 0u8])
        });
        buf.save(&jpg).unwrap();

        let thumb = ensure_thumbnail(&tmp, &jpg).unwrap();
        assert!(thumb.exists());
        let bytes = fs::read(&thumb).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WEBP");

        let mtime_first = fs::metadata(&thumb).unwrap().modified().unwrap();
        let again = ensure_thumbnail(&tmp, &jpg).unwrap();
        assert_eq!(again, thumb);
        let mtime_second = fs::metadata(&thumb).unwrap().modified().unwrap();
        assert_eq!(mtime_first, mtime_second, "second call should not regenerate");
    }
}
