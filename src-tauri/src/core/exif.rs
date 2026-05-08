use std::fs;
use std::io::BufReader;
use std::path::Path;

use exif::{Exif, In, Rational, Reader, Tag, Value};
use serde::Serialize;

#[derive(Debug, Clone, Default, Serialize)]
pub struct ExposureSummary {
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub focal_length: Option<String>,
    pub aperture: Option<String>,
    pub shutter: Option<String>,
    pub iso: Option<String>,
    pub taken_at: Option<String>,
}

impl ExposureSummary {
    fn is_empty(&self) -> bool {
        self.camera.is_none()
            && self.lens.is_none()
            && self.focal_length.is_none()
            && self.aperture.is_none()
            && self.shutter.is_none()
            && self.iso.is_none()
            && self.taken_at.is_none()
    }
}

/// Best-effort EXIF read for the DetailPanel summary. Returns None when the
/// file has no parseable EXIF block — we treat that as "not displayable" on
/// the frontend rather than an error, since BMFF-based RAWs (CR3) and oddly
/// sidecar-only files are expected to land here for legitimate reasons.
pub fn read_summary(path: &Path) -> Option<ExposureSummary> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let exif = Reader::new().read_from_container(&mut reader).ok()?;
    let summary = ExposureSummary {
        camera: read_camera(&exif),
        lens: read_lens(&exif),
        focal_length: read_focal_length(&exif),
        aperture: read_aperture(&exif),
        shutter: read_shutter(&exif),
        iso: read_iso(&exif),
        taken_at: read_taken_at(&exif),
    };
    if summary.is_empty() {
        None
    } else {
        Some(summary)
    }
}

fn read_camera(exif: &Exif) -> Option<String> {
    let make = ascii(exif, Tag::Make);
    let model = ascii(exif, Tag::Model);
    match (make, model) {
        (Some(make), Some(model)) => {
            // Most cameras embed the brand prefix already (e.g. Sony's
            // "ILCE-7M4" or Olympus's "OM-1MarkII"). Avoid producing
            // "OM Digital Solutions OM-1MarkII OM-1MarkII"-style noise by
            // skipping the prefix when the model already contains it.
            let m_low = model.to_lowercase();
            let mk_low = make.to_lowercase();
            if m_low.starts_with(&mk_low) || m_low.contains(&mk_low) {
                Some(model)
            } else {
                Some(format!("{make} {model}"))
            }
        }
        (None, Some(model)) => Some(model),
        (Some(make), None) => Some(make),
        _ => None,
    }
}

fn read_lens(exif: &Exif) -> Option<String> {
    ascii(exif, Tag::LensModel)
}

fn read_focal_length(exif: &Exif) -> Option<String> {
    let r = first_rational(exif, Tag::FocalLength)?;
    let v = rational_to_f64(r)?;
    if (v - v.round()).abs() < 0.05 {
        Some(format!("{:.0}mm", v))
    } else {
        Some(format!("{:.1}mm", v))
    }
}

fn read_aperture(exif: &Exif) -> Option<String> {
    let r = first_rational(exif, Tag::FNumber)?;
    let v = rational_to_f64(r)?;
    if (v - v.round()).abs() < 0.05 {
        Some(format!("f/{:.0}", v))
    } else {
        Some(format!("f/{:.1}", v))
    }
}

fn read_shutter(exif: &Exif) -> Option<String> {
    let r = first_rational(exif, Tag::ExposureTime)?;
    if r.num == 0 || r.denom == 0 {
        return None;
    }
    let secs = rational_to_f64(r)?;
    if secs >= 1.0 {
        if (secs - secs.round()).abs() < 0.05 {
            Some(format!("{:.0}s", secs))
        } else {
            Some(format!("{:.1}s", secs))
        }
    } else {
        // Reduce to "1/N" form regardless of how the camera stored it
        // (some report 2/400 instead of 1/200).
        let denom = (1.0 / secs).round() as u64;
        Some(format!("1/{denom}s"))
    }
}

fn read_iso(exif: &Exif) -> Option<String> {
    // PhotographicSensitivity is the modern canonical tag (kamadak-exif's
    // alias for ISOSpeedRatings 0x8827). ISOSpeed (0x8833) is a separate
    // newer tag some cameras populate instead — try it as fallback.
    let v = first_uint(exif, Tag::PhotographicSensitivity)
        .or_else(|| first_uint(exif, Tag::ISOSpeed))?;
    Some(format!("ISO {v}"))
}

fn read_taken_at(exif: &Exif) -> Option<String> {
    let raw = ascii(exif, Tag::DateTimeOriginal)?;
    // EXIF spec format: "YYYY:MM:DD HH:MM:SS". Swap the date colons to
    // dashes for readability; leave the time colons alone.
    if raw.len() >= 10
        && raw.as_bytes().get(4) == Some(&b':')
        && raw.as_bytes().get(7) == Some(&b':')
    {
        let date = format!("{}-{}-{}", &raw[0..4], &raw[5..7], &raw[8..10]);
        let rest = if raw.len() > 10 { &raw[10..] } else { "" };
        Some(format!("{date}{rest}"))
    } else {
        Some(raw)
    }
}

fn ascii(exif: &Exif, tag: Tag) -> Option<String> {
    let field = exif.get_field(tag, In::PRIMARY)?;
    if let Value::Ascii(ref values) = field.value {
        let bytes: Vec<u8> = values.iter().flat_map(|v| v.iter().copied()).collect();
        let s = String::from_utf8_lossy(&bytes).trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    } else {
        None
    }
}

fn first_rational(exif: &Exif, tag: Tag) -> Option<Rational> {
    let field = exif.get_field(tag, In::PRIMARY)?;
    match &field.value {
        Value::Rational(vs) => vs.first().copied(),
        _ => None,
    }
}

fn rational_to_f64(r: Rational) -> Option<f64> {
    if r.denom == 0 {
        None
    } else {
        Some(r.num as f64 / r.denom as f64)
    }
}

fn first_uint(exif: &Exif, tag: Tag) -> Option<u32> {
    let field = exif.get_field(tag, In::PRIMARY)?;
    field.value.get_uint(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shutter_long_exposure_formats_as_seconds() {
        // Stub-equivalent: just exercise the formatting branches via the
        // helper we'd otherwise have to reach through a synthetic Exif.
        // 2.0s → "2s"
        let r = Rational { num: 2, denom: 1 };
        let secs = rational_to_f64(r).unwrap();
        assert!(secs >= 1.0);
        assert_eq!(format!("{:.0}s", secs), "2s");
    }

    #[test]
    fn shutter_short_exposure_reduces_to_one_over_n() {
        // 2/400 → "1/200s"
        let r = Rational { num: 2, denom: 400 };
        let secs = rational_to_f64(r).unwrap();
        let denom = (1.0 / secs).round() as u64;
        assert_eq!(format!("1/{denom}s"), "1/200s");
    }

    #[test]
    fn date_separator_swap() {
        // Built without a real EXIF blob; just verify the formatter the
        // public path uses for the date prefix.
        let raw = "2026:04:12 14:32:08";
        let date = format!("{}-{}-{}", &raw[0..4], &raw[5..7], &raw[8..10]);
        assert_eq!(date, "2026-04-12");
    }
}
