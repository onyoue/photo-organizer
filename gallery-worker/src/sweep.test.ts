import { describe, expect, it } from "vitest";
import {
  SWEEP_GRACE_DAYS,
  estimateKvDeletes,
  planSweep,
  type SweepCandidate,
} from "./sweep";

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-25T00:00:00Z");

/** expires_at that is `days` days in the past relative to NOW. */
function expiredDaysAgo(days: number): string {
  return new Date(NOW - days * DAY).toISOString();
}

function candidate(
  gid: string,
  expires_at: string,
  photo_count = 10,
): SweepCandidate {
  return { gid, expires_at, photo_count };
}

describe("estimateKvDeletes", () => {
  it("counts meta + read-receipt + one feedback key per photo", () => {
    expect(estimateKvDeletes(0)).toBe(2);
    expect(estimateKvDeletes(10)).toBe(12);
    expect(estimateKvDeletes(500)).toBe(502);
  });

  it("clamps a negative count rather than returning less than the fixed cost", () => {
    expect(estimateKvDeletes(-5)).toBe(2);
  });
});

describe("planSweep", () => {
  it("targets galleries whose grace period has fully elapsed", () => {
    const plan = planSweep(
      [candidate("A", expiredDaysAgo(SWEEP_GRACE_DAYS + 1))],
      NOW,
    );
    expect(plan.targets).toEqual(["A"]);
  });

  it("leaves a gallery alone while it is inside the grace period", () => {
    // Expired, but only yesterday — the photographer may still be pulling
    // feedback, which /admin/<gid>/feedback allows after expiry.
    const plan = planSweep([candidate("A", expiredDaysAgo(1))], NOW);
    expect(plan.targets).toEqual([]);
  });

  it("leaves unexpired galleries alone", () => {
    const future = new Date(NOW + 30 * DAY).toISOString();
    const plan = planSweep([candidate("A", future)], NOW);
    expect(plan.targets).toEqual([]);
  });

  it("never sweeps the desktop app's 期限なし galleries", () => {
    // share_gallery resolves expires_in_days=0 to now + 100 years.
    const hundredYears = new Date(NOW + 100 * 365 * DAY).toISOString();
    const plan = planSweep([candidate("A", hundredYears)], NOW);
    expect(plan.targets).toEqual([]);
  });

  it("skips records with an unparseable expires_at instead of deleting them", () => {
    // isExpired() treats garbage as expired — correct for gating access,
    // wrong for irreversible deletion.
    const plan = planSweep(
      [candidate("BAD", "not-a-date"), candidate("OK", expiredDaysAgo(99))],
      NOW,
    );
    expect(plan.targets).toEqual(["OK"]);
  });

  it("orders targets oldest-expiry first", () => {
    const plan = planSweep(
      [
        candidate("recent", expiredDaysAgo(SWEEP_GRACE_DAYS + 2)),
        candidate("ancient", expiredDaysAgo(SWEEP_GRACE_DAYS + 400)),
        candidate("middle", expiredDaysAgo(SWEEP_GRACE_DAYS + 30)),
      ],
      NOW,
    );
    expect(plan.targets).toEqual(["ancient", "middle", "recent"]);
  });

  it("stops at the KV delete budget and reports the remainder", () => {
    // Each 10-photo gallery costs 12 KV deletes; a budget of 30 fits two.
    const plan = planSweep(
      [
        candidate("a", expiredDaysAgo(40), 10),
        candidate("b", expiredDaysAgo(39), 10),
        candidate("c", expiredDaysAgo(38), 10),
      ],
      NOW,
      30,
    );
    expect(plan.targets).toEqual(["a", "b"]);
    expect(plan.kv_deletes_planned).toBe(24);
    expect(plan.skipped_for_budget).toBe(1);
  });

  it("takes the first target even when it alone exceeds the budget", () => {
    // Otherwise a single oversized gallery would stall the sweep forever.
    const plan = planSweep(
      [candidate("huge", expiredDaysAgo(40), 500)],
      NOW,
      10,
    );
    expect(plan.targets).toEqual(["huge"]);
    expect(plan.kv_deletes_planned).toBe(502);
    expect(plan.skipped_for_budget).toBe(0);
  });

  it("keeps scanning past an over-budget gallery for ones that still fit", () => {
    const plan = planSweep(
      [
        candidate("first", expiredDaysAgo(40), 5), // cost 7
        candidate("big", expiredDaysAgo(39), 100), // cost 102, doesn't fit
        candidate("small", expiredDaysAgo(38), 1), // cost 3, fits
      ],
      NOW,
      20,
    );
    expect(plan.targets).toEqual(["first", "small"]);
    expect(plan.skipped_for_budget).toBe(1);
  });

  it("returns an empty plan for no candidates", () => {
    expect(planSweep([], NOW)).toEqual({
      targets: [],
      skipped_for_budget: 0,
      kv_deletes_planned: 0,
    });
  });

  it("treats the grace boundary as inclusive", () => {
    // Exactly SWEEP_GRACE_DAYS old — cutoff comparison is `<=`, so it goes.
    const plan = planSweep(
      [candidate("A", expiredDaysAgo(SWEEP_GRACE_DAYS))],
      NOW,
    );
    expect(plan.targets).toEqual(["A"]);
  });
});
