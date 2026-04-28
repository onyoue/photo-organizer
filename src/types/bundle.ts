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
  flag?: Flag;
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
