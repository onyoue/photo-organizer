import type { BundleFile, BundleSummary } from "../types/bundle";

/// Extensions Chromium-based webviews render directly via <img>. TIFF lives
/// in JPG-role bundles for organisation but isn't in this set — webview
/// would draw a broken-image icon for it.
const RENDERABLE_IMAGE = /\.(jpe?g|png)$/i;

function jpgRoleSorted(b: BundleSummary): {
  developed: BundleFile[];
  inCamera: BundleFile[];
} {
  // mtime values are ISO 8601 strings, which sort lexicographically the same
  // as chronologically — direct string compare works.
  const developed = b.files
    .filter((f) => f.role === "developed")
    .sort((a, c) => c.mtime.localeCompare(a.mtime));
  const inCamera = b.files.filter((f) => f.role === "jpeg");
  return { developed, inCamera };
}

/**
 * All preview-able variants in a bundle, ordered for ↑/↓ cycling. Index 0 is
 * the auto-pick (latest developed → in-camera fallback); subsequent
 * developed variants follow in mtime-descending order, with the in-camera
 * appended last when present. Filters to formats the webview can actually
 * render — TIFFs are bundled but excluded here to spare the user a broken
 * preview icon.
 */
export function previewVariants(b: BundleSummary): BundleFile[] {
  const { developed, inCamera } = jpgRoleSorted(b);
  return [...developed, ...inCamera].filter((f) =>
    RENDERABLE_IMAGE.test(f.path),
  );
}

/**
 * Pick the file that best represents a bundle visually. Equivalent to
 * `previewVariants(b)[0]` — exported as its own function so the call sites
 * read clearly even when they only care about the auto-selection.
 */
export function selectPreviewFile(b: BundleSummary): string | null {
  return previewVariants(b)[0]?.path ?? null;
}

/**
 * Pick the file to feed the thumbnail generator. Wider net than
 * `selectPreviewFile`: TIFFs are decodable on the backend (image crate has
 * the `tiff` feature) and the resulting webp is universally renderable, so
 * a TIFF-only bundle still gets a tile thumbnail. RAW-only bundles also
 * fall through here — the backend uses rawler to extract the camera-embedded
 * preview JPEG without doing a full RAW decode.
 */
export function selectThumbnailSource(b: BundleSummary): string | null {
  const { developed, inCamera } = jpgRoleSorted(b);
  if (developed[0]) return developed[0].path;
  if (inCamera[0]) return inCamera[0].path;
  // RAW-only bundle: hand the RAW path to the backend; rawler pulls the
  // embedded JPEG preview out for us.
  const raw = b.files.find((f) => f.role === "raw");
  return raw?.path ?? null;
}
