import type { BundleSummary } from "../types/bundle";

/**
 * Pick the file that best represents a bundle visually, in order of
 * preference:
 *
 *   1. The most-recently-modified developed JPG (the user is iterating in
 *      their RAW developer; the latest export is what they want to see).
 *   2. The in-camera JPG.
 *   3. Nothing — RAW-only bundles still have no preview source until we add
 *      embedded-preview extraction.
 *
 * mtime values are ISO 8601 strings, which sort lexicographically the same
 * as chronologically, so we can compare them directly.
 */
export function selectPreviewFile(b: BundleSummary): string | null {
  const developed = b.files
    .filter((f) => f.role === "developed")
    .sort((a, c) => c.mtime.localeCompare(a.mtime));
  if (developed.length > 0) return developed[0].path;
  const jpeg = b.files.find((f) => f.role === "jpeg");
  return jpeg?.path ?? null;
}
