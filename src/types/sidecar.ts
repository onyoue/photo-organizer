export type Platform = "x" | "instagram" | "note" | "other";
export type PostBy = "self" | "model" | "other";
export type Flag = "pick" | "reject";

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
