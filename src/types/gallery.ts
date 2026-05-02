import type { Decision } from "./settings";

export type { Decision };

export interface GalleryPhotoRecord {
  pid: string;
  bundle_id: string;
  source_path: string;
  filename: string;
  size: number;
  content_type: string;
}

export interface GalleryRecord {
  gid: string;
  name: string;
  url: string;
  created_at: string;
  expires_at: string;
  default_decision: Decision;
  photos: GalleryPhotoRecord[];
}

export interface GalleryFeedbackEntry {
  bundle_id: string;
  pid: string;
  decision: Decision;
  /** True iff the model made an explicit choice (vs inheriting the default). */
  explicit: boolean;
}

export interface ShareGalleryPhoto {
  bundle_id: string;
  source_path: string;
}

export interface ShareGalleryArgs {
  /** Absolute folder path; per-photo source_path values are resolved against it. */
  folder: string;
  name: string;
  expires_in_days: number;
  default_decision: Decision;
  photos: ShareGalleryPhoto[];
}

export interface ShareGalleryResult {
  gid: string;
  url: string;
}

export interface ShareProgressEvent {
  gid: string;
  current: number;
  total: number;
  filename: string;
}
