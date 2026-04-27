use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use exif::{In, Reader, Tag};
use image::imageops::FilterType;
use image::DynamicImage;

use crate::core::APP_DIR;
use crate::error::{AppError, AppResult};

const THUMB_LONG_EDGE: u32 = 320;
const THUMB_QUALITY: f32 = 80.0;
const THUMB_SUBDIR: &str = "thumbs";

pub fn thumb_dir(folder: &Path) -> PathBuf {
    folder.join(APP_DIR).join(THUMB_SUBDIR)
}

fn cache_key(file_path: &Path, size: u64, mtime: SystemTime) -> String {
    let mtime_secs = mtime
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut h = DefaultHasher::new();
    file_path.to_string_lossy().hash(&mut h);
    size.hash(&mut h);
    mtime_secs.hash(&mut h);
    format!("{:016x}", h.finish())
}

pub fn ensure_thumbnail(folder: &Path, source: &Path) -> AppResult<PathBuf> {
    let metadata = fs::metadata(source)?;
    let mtime = metadata.modified()?;
    let key = cache_key(source, metadata.len(), mtime);

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
    let img = image::open(input).map_err(|e| AppError::Image(e.to_string()))?;
    let orient = read_exif_orientation(input).unwrap_or(1);
    let oriented = apply_orientation(img, orient);
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
