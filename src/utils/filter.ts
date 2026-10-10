import type { BundleSummary } from "../types/bundle";

export type FilterMode =
  | "all"
  | "pick"
  | "ok"
  | "reject"
  | "hasposts"
  | "noposts"
  | "hasdeveloped";

export type RatingFilter = 0 | 1 | 2 | 3 | 4 | 5;

export const FILTER_LABELS: Record<FilterMode, string> = {
  all: "All",
  // Internal filter key is still "pick" for back-compat with existing
  // sidecars; the visible label tracks the gallery-feedback semantics.
  pick: "★ FAV",
  ok: "✓ OK",
  reject: "✕ NG",
  hasposts: "Posted",
  noposts: "Not posted",
  hasdeveloped: "Developed",
};

export const FILTER_MODES: FilterMode[] = [
  "all",
  "pick",
  "ok",
  "reject",
  "hasposts",
  "noposts",
  "hasdeveloped",
];

export function applyFilter(
  bundles: BundleSummary[],
  mode: FilterMode,
  tag: string | null = null,
  ratings: ReadonlySet<RatingFilter> = new Set(),
): BundleSummary[] {
  if (mode === "all" && !tag && ratings.size === 0) return bundles;
  return bundles.filter(
    (b) => matchMode(b, mode) && matchTag(b, tag) && matchRating(b, ratings),
  );
}

function matchMode(b: BundleSummary, mode: FilterMode): boolean {
  switch (mode) {
    case "all":
      return true;
    case "pick":
      return b.flag === "pick";
    case "ok":
      return b.flag === "ok";
    case "reject":
      return b.flag === "reject";
    case "hasposts":
      return b.has_posts;
    case "noposts":
      return !b.has_posts;
    case "hasdeveloped":
      return b.files.some((f) => f.role === "developed");
  }
}

function matchRating(
  b: BundleSummary,
  ratings: ReadonlySet<RatingFilter>,
): boolean {
  if (ratings.size === 0) return true;
  // Sidecars omit an unrated value; normalize it to 0 for the filter chip.
  return ratings.has((b.rating ?? 0) as RatingFilter);
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
