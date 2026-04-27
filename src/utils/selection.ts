import type { BundleSummary } from "../types/bundle";

export function rangeIds(
  bundles: BundleSummary[],
  fromId: string,
  toId: string,
): string[] {
  const a = bundles.findIndex((b) => b.bundle_id === fromId);
  const b = bundles.findIndex((b) => b.bundle_id === toId);
  if (a < 0 || b < 0) return [];
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return bundles.slice(lo, hi + 1).map((x) => x.bundle_id);
}
