/**
 * Expiry sweep planning.
 *
 * The fetch handler only *gates* expired galleries (`isExpired` → 410 Gone).
 * Nothing about passing `expires_at` frees the R2 bytes, so without a sweep
 * storage grows monotonically until the photographer deletes each gallery by
 * hand. The cron trigger in wrangler.toml calls `sweepExpiredGalleries`
 * (admin.ts) once a day; this module holds the pure decision logic so it can
 * be unit-tested without a KV/R2 binding.
 */

/** Days after `expires_at` before a gallery becomes sweepable.
 *
 *  Expiry closes the model's access immediately, but `GET /admin/<gid>/feedback`
 *  deliberately does *not* check expiry — the photographer can still pull
 *  decisions in after the link goes dead. Sweeping is irreversible (photos,
 *  feedback and read-receipt all go), so we leave a week of slack for that
 *  late fetch. Set to 0 to reclaim the moment expiry passes. */
export const SWEEP_GRACE_DAYS = 7;

/** KV deletes one sweep run is allowed to spend.
 *
 *  The free tier allows 1,000 KV deletes/day (see CLOUDFLARE.md) and one
 *  gallery costs `2 + photos` of them (meta + read-receipt + up to one
 *  feedback key per photo). Capping at 800 leaves headroom for the
 *  photographer's own deletes on the same day; whatever doesn't fit is
 *  reported as `skipped_for_budget` and picked up by the next run. */
export const SWEEP_KV_DELETE_BUDGET = 800;

const DAY_MS = 86_400_000;

export interface SweepCandidate {
  gid: string;
  expires_at: string;
  /** Photo count, used to estimate the gallery's KV delete cost. */
  photo_count: number;
}

export interface SweepPlan {
  /** gids to purge, oldest expiry first. */
  targets: string[];
  /** Expired galleries left for the next run because the budget ran out. */
  skipped_for_budget: number;
  /** Estimated KV deletes the targets will spend. */
  kv_deletes_planned: number;
}

export interface SweepResult {
  /** Galleries examined (every `gallery:*` record in KV). */
  scanned: number;
  swept: string[];
  failed: { gid: string; error: string }[];
  skipped_for_budget: number;
  bytes_reclaimed: number;
}

/** Worst-case KV deletes for one gallery: its meta, its read-receipt, and up
 *  to one feedback key per photo. Over-estimates when the model only rated
 *  some photos, which is the safe direction for a budget. */
export function estimateKvDeletes(photo_count: number): number {
  return 2 + Math.max(0, photo_count);
}

/**
 * Decide which galleries this run should purge.
 *
 * A gallery qualifies when `expires_at + SWEEP_GRACE_DAYS` has passed.
 * Deliberately *not* reusing `isExpired` from util.ts: that helper treats an
 * unparseable timestamp as expired, which is the right call for gating access
 * but the wrong one for irreversible deletion — a malformed record should be
 * left alone for a human to look at, not swept. Galleries created with the
 * desktop app's "期限なし" option sit ~100 years out and never qualify.
 *
 * Oldest expiry first, so a backlog drains in the order it accumulated
 * instead of starving the oldest entries.
 */
export function planSweep(
  candidates: SweepCandidate[],
  now: number = Date.now(),
  kvBudget: number = SWEEP_KV_DELETE_BUDGET,
): SweepPlan {
  const cutoff = now - SWEEP_GRACE_DAYS * DAY_MS;

  const due = candidates
    .map((c) => ({ c, t: Date.parse(c.expires_at) }))
    .filter(({ t }) => !Number.isNaN(t) && t <= cutoff)
    .sort((a, b) => a.t - b.t);

  const targets: string[] = [];
  let kv_deletes_planned = 0;
  let skipped_for_budget = 0;

  for (const { c } of due) {
    const cost = estimateKvDeletes(c.photo_count);
    // Always take the first target even if it alone blows the budget —
    // otherwise one oversized gallery would stall the sweep forever.
    if (targets.length > 0 && kv_deletes_planned + cost > kvBudget) {
      skipped_for_budget++;
      continue;
    }
    targets.push(c.gid);
    kv_deletes_planned += cost;
  }

  return { targets, skipped_for_budget, kv_deletes_planned };
}
