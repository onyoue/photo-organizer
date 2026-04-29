import { describe, expect, it } from "vitest";
import type { BundleFile, BundleSummary } from "../types/bundle";
import { selectPreviewFile } from "./preview";

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
  it("returns null for a RAW-only bundle (no preview source available)", () => {
    expect(selectPreviewFile(bundle([file("raw", "a.dng", "")]))).toBeNull();
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
