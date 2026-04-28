import type { BundleSummary } from "../types/bundle";

export type FilterMode =
  | "all"
  | "pick"
  | "reject"
  | "unrated"
  | "rated4plus"
  | "hasposts"
  | "noposts";

export const FILTER_LABELS: Record<FilterMode, string> = {
  all: "All",
  pick: "Pick",
  reject: "Reject",
  unrated: "Unrated",
  rated4plus: "4★+",
  hasposts: "Posted",
  noposts: "Not posted",
};

export const FILTER_MODES: FilterMode[] = [
  "all",
  "pick",
  "reject",
  "unrated",
  "rated4plus",
  "hasposts",
  "noposts",
];

export function applyFilter(
  bundles: BundleSummary[],
  mode: FilterMode,
  tag: string | null = null,
): BundleSummary[] {
  if (mode === "all" && !tag) return bundles;
  return bundles.filter((b) => matchMode(b, mode) && matchTag(b, tag));
}

function matchMode(b: BundleSummary, mode: FilterMode): boolean {
  switch (mode) {
    case "all":
      return true;
    case "pick":
      return b.flag === "pick";
    case "reject":
      return b.flag === "reject";
    case "unrated":
      // Sidecar doesn't store rating=0, but UI treats 0 as "no rating" too.
      return b.rating === undefined || b.rating === 0;
    case "rated4plus":
      return (b.rating ?? 0) >= 4;
    case "hasposts":
      return b.has_posts;
    case "noposts":
      return !b.has_posts;
  }
}

function matchTag(b: BundleSummary, tag: string | null): boolean {
  if (!tag) return true;
  return (b.tags ?? []).includes(tag);
}

/// Distinct tags across the given bundles, sorted alphabetically. Drives
/// the filter dropdown — no point offering a tag the user hasn't applied
/// yet in this folder.
export function distinctTags(bundles: BundleSummary[]): string[] {
  const seen = new Set<string>();
  for (const b of bundles) {
    for (const t of b.tags ?? []) seen.add(t);
  }
  return Array.from(seen).sort();
}
