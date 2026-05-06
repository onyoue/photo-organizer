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

export interface ViewedRecord {
  first_viewed_at: string;
  last_viewed_at: string;
  view_count: number;
}

export interface GalleryRecord {
  gid: string;
  name: string;
  url: string;
  created_at: string;
  expires_at: string;
  default_decision: Decision;
  /** Source folder the photos came from. Used to warn the user if they
   * try to apply feedback while a different folder is open. */
  source_folder?: string;
  /** Optional model name attached at share time. Drives per-model
   *  feedback bucketing on apply. Empty / absent for galleries shared
   *  without a specific model. */
  model_name?: string;
  photos: GalleryPhotoRecord[];
  /** Cached per-pid decisions from the last successful feedback fetch. */
  last_decisions?: Record<string, Decision>;
  /** ISO-8601 timestamp of the last successful feedback fetch. */
  last_fetched_at?: string;
  /** Cached read-receipt — `undefined` when the model hasn't opened the
   *  gallery yet, or when this record predates the view-tracking field. */
  last_views?: ViewedRecord;
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
  /** Optional model name. When set, decisions returned by this gallery
   *  are bucketed under this key in `feedback_by_model`. */
  model_name?: string;
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

/** Worker-tracked free-tier usage. Returned by `get_gallery_stats`. */
export interface GalleryStats {
  r2_bytes: number;
  photo_count: number;
  gallery_count: number;
  /** ISO-8601 timestamp of the Worker's last counter write. */
  updated_at: string;
  /** R2 free-tier ceiling, echoed back so the UI doesn't hard-code it. */
  r2_bytes_limit: number;
}
