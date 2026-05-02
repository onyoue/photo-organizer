export interface Env {
  GALLERY_BUCKET: R2Bucket;
  GALLERY_KV: KVNamespace;
  ADMIN_TOKEN: string;
}

export type Decision = "ok" | "ng" | "fav";

/** Subset valid as a gallery's default — a per-photo "fav" default would
 * be nonsense (favourite implies an explicit choice). */
export type DefaultDecision = "ok" | "ng";

export interface PhotoEntry {
  pid: string;          // short identifier from the desktop app, used in URLs
  filename: string;     // original filename, used as ZIP entry name
  content_type: string; // image/jpeg, image/png, ...
  size?: number;
}

export interface GalleryMeta {
  name: string;
  created_at: string;       // ISO-8601
  expires_at: string;       // ISO-8601
  default_decision: DefaultDecision;
  finalized: boolean;
  photos: PhotoEntry[];
}

export interface CreateGalleryBody {
  name: string;
  expires_at: string;
  default_decision: DefaultDecision;
  photos: PhotoEntry[];
}

export interface FeedbackResponse {
  default_decision: DefaultDecision;
  decisions: Record<string, Decision>;
}
