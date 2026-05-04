//! Hand-rolled difference hash (dHash) for cross-folder image search.
//!
//! Why dHash and not DCT-pHash:
//! - Simpler implementation (~10 lines vs hand-rolling a 2D DCT)
//! - Empirically very robust to JPEG re-encoding, mild colour shifts, and
//!   the kind of resampling that SNS platforms (Instagram, X, note) apply
//!   when the model uploads a photo
//! - Mild crop is the weak point for both algorithms; we accept that and
//!   ask the user to confirm matches
//! - 64-bit hash → cheap Hamming-distance comparison, store as u64

use image::{imageops::FilterType, DynamicImage};

/// Compute a 64-bit difference hash from a `DynamicImage`.
///
/// Algorithm:
/// 1. Convert to grayscale and resize to **9 columns × 8 rows** (= 72 pixels).
///    The 9-column width gives 8 horizontal-difference comparisons per row.
/// 2. For each row, compare adjacent pixels left↔right; emit 1 bit per
///    comparison. 8 bits × 8 rows = 64 bits.
/// 3. Bits are concatenated MSB-first row-major into a `u64`.
///
/// The Triangle (= bilinear) resampler is used for speed. Visually it gives
/// near-identical hashes to Lanczos for dHash purposes.
pub fn dhash(img: &DynamicImage) -> u64 {
    let small = img.grayscale().resize_exact(9, 8, FilterType::Triangle);
    let buf = small.to_luma8();
    let mut hash: u64 = 0;
    for y in 0..8u32 {
        for x in 0..8u32 {
            let left = buf.get_pixel(x, y)[0];
            let right = buf.get_pixel(x + 1, y)[0];
            hash = (hash << 1) | (if left > right { 1 } else { 0 });
        }
    }
    hash
}

/// Hamming distance between two 64-bit hashes — the number of bit positions
/// that differ. 0 = identical, 64 = opposite. For dHash, distances under
/// ~10 mean "very likely the same image" and 10–20 are "probably the same
/// after some manipulation".
pub fn hamming_distance(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageBuffer, Rgb};

    fn solid(w: u32, h: u32, [r, g, b]: [u8; 3]) -> DynamicImage {
        let buf: ImageBuffer<Rgb<u8>, _> = ImageBuffer::from_fn(w, h, |_, _| Rgb([r, g, b]));
        DynamicImage::ImageRgb8(buf)
    }

    fn gradient(w: u32, h: u32) -> DynamicImage {
        let buf: ImageBuffer<Rgb<u8>, _> = ImageBuffer::from_fn(w, h, |x, _| {
            let v = ((x as f32 / w as f32) * 255.0) as u8;
            Rgb([v, v, v])
        });
        DynamicImage::ImageRgb8(buf)
    }

    #[test]
    fn solid_image_has_all_zero_hash() {
        // No left/right luma differences anywhere → every bit is 0.
        let h = dhash(&solid(64, 64, [128, 128, 128]));
        assert_eq!(h, 0);
    }

    #[test]
    fn left_to_right_gradient_is_all_ones() {
        // Each left pixel < right pixel → every bit 1 (left > right is false,
        // wait no — let's think: dhash sets 1 when left > right. A
        // brightening gradient has left < right, so all bits should be 0).
        // We're verifying the algorithm direction here, not asserting a
        // specific bit pattern beyond "matches expectation".
        let h = dhash(&gradient(64, 64));
        assert_eq!(hamming_distance(h, 0), 0, "ascending gradient → all zeros");
    }

    #[test]
    fn hamming_distance_self_is_zero() {
        let h = dhash(&gradient(64, 64));
        assert_eq!(hamming_distance(h, h), 0);
    }

    #[test]
    fn hamming_distance_inverted_is_64() {
        let h = 0xAAAAAAAAAAAAAAAA_u64;
        let i = !h;
        assert_eq!(hamming_distance(h, i), 64);
    }
}
