export type Platform = "x" | "instagram" | "note" | "other";
export type PostBy = "self" | "model" | "other";
export type Flag = "pick" | "ok" | "reject";

export interface PostRecord {
  id: string;
  platform: Platform;
  url: string;
  posted_at?: string;
  by: PostBy;
  posted_by_handle?: string;
  note?: string;
}

export interface BundleSidecar {
  version: number;
  bundle_id: string;
  base_name: string;
  rating?: number;
  flag?: Flag;
  /** Per-model gallery verdicts. Key is the gallery's `model_name`
   *  (empty string for galleries shared without one). Aggregate `flag`
   *  above is derived from this when present. */
  feedback_by_model?: Record<string, Flag>;
  tags: string[];
  posts: PostRecord[];
  created_at: string;
  updated_at: string;
}

export const PLATFORM_LABELS: Record<Platform, string> = {
  x: "X",
  instagram: "Instagram",
  note: "note",
  other: "Other",
};

export const POST_BY_LABELS: Record<PostBy, string> = {
  self: "Self",
  model: "Model",
  other: "Other",
};
