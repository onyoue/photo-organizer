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
}

export interface FolderIndex {
  version: number;
  scanned_at: string;
  folder_path: string;
  bundles: BundleSummary[];
}
