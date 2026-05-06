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

/** Running totals stored in KV at `stats:totals`. Maintained by
 *  increment-on-success in the admin handlers; can be rebuilt with
 *  POST /admin/stats/recompute if it ever drifts. */
export interface StatsTotals {
  r2_bytes: number;
  photo_count: number;
  gallery_count: number;
  /** ISO-8601 timestamp of the last write to this object. */
  updated_at: string;
}

/** Response from GET /admin/stats — totals plus the free-tier ceiling
 *  the desktop UI compares against. */
export interface StatsResponse extends StatsTotals {
  r2_bytes_limit: number;
}

/** Per-gallery "read receipt" — set the first time a non-viewOnly
 *  request hits the gallery HTML, then updated on subsequent views.
 *  Stored in KV at `viewed:<gid>`. Photographer-side previews via
 *  `/<gid>/view` do not bump this. */
export interface ViewedRecord {
  first_viewed_at: string;
  last_viewed_at: string;
  view_count: number;
}
