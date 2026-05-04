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
