import type { Flag } from "./sidecar";

export type FileRole = "raw" | "jpeg" | "sidecar" | "developed" | "unknown";

export interface BundleFile {
  role: FileRole;
  path: string;
  size: number;
  mtime: string;
}

export interface BundleSummary {
  bundle_id: string;
  base_name: string;
  files: BundleFile[];
  has_posts: boolean;
  post_platforms: string[];
  has_model_post: boolean;
  rating?: number;
  /** Aggregate flag derived from `feedback_by_model` (any FAV → pick / any
   *  NG → reject / any OK → ok), or set directly in legacy single-flag mode. */
  flag?: Flag;
  /** Per-model gallery verdicts. Empty / absent for legacy bundles whose
   *  flag was set before per-model support landed. */
  feedback_by_model?: Record<string, Flag>;
  tags?: string[];
  /** 64-bit difference hash, hex-encoded as 16 chars. Computed during scan
   *  for cross-folder pHash search; the desktop UI never decodes this —
   *  it just round-trips back to the Rust search command. Absent when
   *  computation failed (file missing, decode error, etc.). */
  phash?: string;
  /** dHash of the centered 1:1 crop of the same source. Pairs with `phash`
   *  to keep cropped SNS uploads (Instagram especially) within search
   *  reach. Absent on bundles last hashed before the schema addition. */
  phash_square?: string;
}

export interface BundleRef {
  bundle_id: string;
  base_name: string;
}

export interface FolderIndex {
  version: number;
  scanned_at: string;
  folder_path: string;
  folder_mtime: string;
  bundles: BundleSummary[];
}
