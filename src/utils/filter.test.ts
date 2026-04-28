import { describe, expect, it } from "vitest";
import type { BundleSummary } from "../types/bundle";
import { applyFilter } from "./filter";

let id = 0;
function bundle(overrides: Partial<BundleSummary> = {}): BundleSummary {
  id += 1;
  return {
    bundle_id: `b${id}`,
    base_name: `b${id}`,
    files: [],
    has_posts: false,
    post_platforms: [],
    has_model_post: false,
    ...overrides,
  };
}

describe("applyFilter", () => {
  it("returns the input unchanged for 'all'", () => {
    const bs = [bundle(), bundle(), bundle()];
    expect(applyFilter(bs, "all")).toEqual(bs);
  });

  it("filters by pick flag", () => {
    const bs = [
      bundle({ flag: "pick" }),
      bundle({ flag: "reject" }),
      bundle(),
    ];
    expect(applyFilter(bs, "pick")).toHaveLength(1);
    expect(applyFilter(bs, "pick")[0].flag).toBe("pick");
  });

  it("filters by reject flag", () => {
    const bs = [bundle({ flag: "pick" }), bundle({ flag: "reject" })];
    expect(applyFilter(bs, "reject")).toHaveLength(1);
    expect(applyFilter(bs, "reject")[0].flag).toBe("reject");
  });

  it("treats both undefined and 0 rating as unrated", () => {
    const bs = [
      bundle(),
      bundle({ rating: 0 }),
      bundle({ rating: 1 }),
      bundle({ rating: 5 }),
    ];
    expect(applyFilter(bs, "unrated")).toHaveLength(2);
  });

  it("includes ratings 4 and above for rated4plus", () => {
    const bs = [
      bundle({ rating: 3 }),
      bundle({ rating: 4 }),
      bundle({ rating: 5 }),
      bundle(),
    ];
    expect(applyFilter(bs, "rated4plus")).toHaveLength(2);
  });

  it("filters by has-posts", () => {
    const bs = [
      bundle({ has_posts: true }),
      bundle({ has_posts: true }),
      bundle(),
    ];
    expect(applyFilter(bs, "hasposts")).toHaveLength(2);
    expect(applyFilter(bs, "noposts")).toHaveLength(1);
  });

  it("preserves order", () => {
    const a = bundle({ rating: 4, base_name: "A" });
    const b = bundle({ rating: 4, base_name: "B" });
    const c = bundle({ rating: 4, base_name: "C" });
    expect(applyFilter([a, b, c], "rated4plus").map((x) => x.base_name)).toEqual([
      "A",
      "B",
      "C",
    ]);
  });
});
