import type { BundleSummary } from "../types/bundle";
import type { Flag } from "../types/sidecar";

/// Apply a per-model (or legacy single-flag) update to a `BundleSummary`
/// in-memory, mirroring the Rust `patch_summary_flag` so the React state
/// stays consistent with what the sidecar will end up holding.
///
/// `modelKey === null` is the legacy path: writes go directly to the
/// top-level `flag` field on bundles that don't yet have a per-model map.
/// On bundles that already have a map, null is treated as the anonymous
/// bucket (key `""`).
///
/// Aggregate `flag` is re-derived from `feedback_by_model` whenever the
/// map is touched, with the same precedence as gallery feedback apply:
/// any FAV → pick, otherwise any NG → reject, otherwise any OK → ok.
export function patchBundleFlag(
  b: BundleSummary,
  flag: Flag | null,
  modelKey: string | null,
): BundleSummary {
  const existing = b.feedback_by_model ?? {};
  const hasMap = Object.keys(existing).length > 0;

  if (modelKey === null && !hasMap) {
    // Pure legacy path — set or clear the top-level flag, leave the map alone.
    return stripUndefined({
      ...b,
      flag: flag ?? undefined,
    });
  }

  const map: Record<string, Flag> = { ...existing };
  if (!hasMap && b.flag !== undefined) {
    // Migrate legacy flag to anonymous key on first per-model write.
    map[""] = b.flag;
  }

  const key = modelKey ?? "";
  if (flag !== null) {
    map[key] = flag;
  } else {
    delete map[key];
  }

  const aggregate = aggregateFlag(map);

  return stripUndefined({
    ...b,
    flag: aggregate,
    feedback_by_model: Object.keys(map).length > 0 ? map : undefined,
  });
}

function aggregateFlag(map: Record<string, Flag>): Flag | undefined {
  const values = Object.values(map);
  if (values.includes("pick")) return "pick";
  if (values.includes("reject")) return "reject";
  if (values.includes("ok")) return "ok";
  return undefined;
}

/// React state shouldn't carry explicit `undefined` keys — they survive
/// JSON round-trips and clutter equality checks. Strip them off.
function stripUndefined<T extends object>(obj: T): T {
  const out = { ...obj };
  for (const k of Object.keys(out) as (keyof T)[]) {
    if (out[k] === undefined) delete out[k];
  }
  return out;
}
