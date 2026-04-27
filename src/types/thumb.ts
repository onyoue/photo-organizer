export type ThumbState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "ready"; path: string }
  | { kind: "error"; message: string };

export type ThumbMap = Record<string, ThumbState>;
