export type ThumbState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "ready"; path: string }
  | { kind: "error"; message: string };

export type ThumbMap = Record<string, ThumbState>;

export interface ThumbnailRequest {
  bundle_id: string;
  file: string;
}

export interface ThumbnailReadyEvent {
  bundle_id: string;
  path: string | null;
  error: string | null;
}
