import { describe, expect, it } from "vitest";
import type { BundleFile, BundleSummary } from "../types/bundle";
import {
  previewVariants,
  selectPreviewFile,
  selectThumbnailSource,
} from "./preview";

function file(role: BundleFile["role"], path: string, mtime: string): BundleFile {
  return { role, path, size: 0, mtime };
}

function bundle(files: BundleFile[]): BundleSummary {
  return {
    bundle_id: "x",
    base_name: "x",
    files,
    has_posts: false,
    post_platforms: [],
    has_model_post: false,
  };
}

describe("selectPreviewFile", () => {
  it("falls back to the RAW file for a RAW-only bundle (resolved to embedded JPEG by ensure_preview_image_path)", () => {
    expect(selectPreviewFile(bundle([file("raw", "a.dng", "")]))).toBe("a.dng");
  });

  it("returns the in-camera JPG when no developed variant exists", () => {
    const b = bundle([
      file("raw", "a.dng", "2026-01-01T00:00:00Z"),
      file("jpeg", "a.jpg", "2026-01-01T00:00:00Z"),
    ]);
    expect(selectPreviewFile(b)).toBe("a.jpg");
  });

  it("prefers a developed variant over the in-camera JPG", () => {
    const b = bundle([
      file("jpeg", "a.jpg", "2026-01-01T00:00:00Z"),
      file("developed", "a_edit.jpg", "2026-02-01T00:00:00Z"),
    ]);
    expect(selectPreviewFile(b)).toBe("a_edit.jpg");
  });

  it("picks the most recently modified developed variant", () => {
    const b = bundle([
      file("developed", "a_v1.jpg", "2026-01-01T00:00:00Z"),
      file("developed", "a_v3.jpg", "2026-03-15T10:00:00Z"),
      file("developed", "a_v2.jpg", "2026-02-01T00:00:00Z"),
    ]);
    expect(selectPreviewFile(b)).toBe("a_v3.jpg");
  });

  it("falls back to in-camera when developed variants are mixed with older mtimes", () => {
    // Developed always wins regardless of mtime — preference is by role first.
    const b = bundle([
      file("jpeg", "a.jpg", "2030-01-01T00:00:00Z"),
      file("developed", "a_edit.jpg", "2026-01-01T00:00:00Z"),
    ]);
    expect(selectPreviewFile(b)).toBe("a_edit.jpg");
  });

  it("ignores raw and sidecar files when picking preview", () => {
    const b = bundle([
      file("raw", "a.dng", "2030-01-01T00:00:00Z"),
      file("sidecar", "a.dng.rawdev.json", "2030-01-01T00:00:00Z"),
      file("developed", "a_edit.jpg", "2026-01-01T00:00:00Z"),
    ]);
    expect(selectPreviewFile(b)).toBe("a_edit.jpg");
  });
});

describe("previewVariants", () => {
  it("orders developed newest-first, then in-camera last", () => {
    const b = bundle([
      file("raw", "a.dng", "2026-01-01T00:00:00Z"),
      file("developed", "a_v1.jpg", "2026-01-01T00:00:00Z"),
      file("developed", "a_v3.jpg", "2026-03-01T00:00:00Z"),
      file("developed", "a_v2.jpg", "2026-02-01T00:00:00Z"),
      file("jpeg", "a.jpg", "2026-01-01T00:00:00Z"),
    ]);
    expect(previewVariants(b).map((f) => f.path)).toEqual([
      "a_v3.jpg",
      "a_v2.jpg",
      "a_v1.jpg",
      "a.jpg",
    ]);
  });

  it("falls back to the single RAW for a RAW-only bundle", () => {
    expect(previewVariants(bundle([file("raw", "x.dng", "")])).map((f) => f.path)).toEqual(
      ["x.dng"],
    );
  });

  it("returns just in-camera when no developed exist", () => {
    const b = bundle([
      file("raw", "x.dng", ""),
      file("jpeg", "x.jpg", ""),
    ]);
    expect(previewVariants(b).map((f) => f.path)).toEqual(["x.jpg"]);
  });

  it("ignores sidecar files entirely", () => {
    const b = bundle([
      file("sidecar", "a.dng.rawdev.json", ""),
      file("developed", "a_edit.jpg", "2026-01-01T00:00:00Z"),
    ]);
    expect(previewVariants(b).map((f) => f.path)).toEqual(["a_edit.jpg"]);
  });

  it("first entry agrees with selectPreviewFile", () => {
    const b = bundle([
      file("jpeg", "a.jpg", "2030-01-01T00:00:00Z"),
      file("developed", "a_edit.jpg", "2026-01-01T00:00:00Z"),
    ]);
    expect(previewVariants(b)[0].path).toBe(selectPreviewFile(b));
  });

  it("excludes tiff files even though they share the JPG role bucket", () => {
    // TIFF gets the developed/jpeg role for organisational purposes, but
    // webview <img> can't render it — so it shouldn't appear when the user
    // cycles through preview variants.
    const b = bundle([
      file("developed", "a_v3.tiff", "2026-03-01T00:00:00Z"),
      file("developed", "a_v2.jpg", "2026-02-01T00:00:00Z"),
      file("developed", "a_v1.png", "2026-01-01T00:00:00Z"),
    ]);
    expect(previewVariants(b).map((f) => f.path)).toEqual([
      "a_v2.jpg",
      "a_v1.png",
    ]);
  });

  it("includes png alongside jpg as renderable", () => {
    const b = bundle([
      file("jpeg", "a.png", "2026-01-01T00:00:00Z"),
    ]);
    expect(selectPreviewFile(b)).toBe("a.png");
  });
});

describe("selectThumbnailSource", () => {
  it("includes tiff so TIFF-only bundles still get a thumbnail", () => {
    const b = bundle([file("jpeg", "a.tiff", "")]);
    expect(selectThumbnailSource(b)).toBe("a.tiff");
  });

  it("prefers latest developed regardless of extension", () => {
    const b = bundle([
      file("developed", "a_v1.jpg", "2026-01-01T00:00:00Z"),
      file("developed", "a_v2.tiff", "2026-03-01T00:00:00Z"),
      file("jpeg", "a.jpg", "2026-01-01T00:00:00Z"),
    ]);
    expect(selectThumbnailSource(b)).toBe("a_v2.tiff");
  });

  it("falls back to the RAW file for RAW-only bundles", () => {
    // The Rust thumbnail pipeline pulls the camera-embedded JPEG out of
    // the RAW via rawler, so handing it the raw path is correct.
    const b = bundle([file("raw", "a.arw", "2026-01-01T00:00:00Z")]);
    expect(selectThumbnailSource(b)).toBe("a.arw");
  });

  it("still prefers a JPG / developed file when one is present alongside RAW", () => {
    const b = bundle([
      file("raw", "a.arw", "2030-01-01T00:00:00Z"),
      file("jpeg", "a.jpg", "2026-01-01T00:00:00Z"),
    ]);
    expect(selectThumbnailSource(b)).toBe("a.jpg");
  });
});
