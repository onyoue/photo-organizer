import { describe, expect, it } from "vitest";
import { SHORTCUT_GROUPS } from "./shortcuts";

describe("SHORTCUT_GROUPS", () => {
  it("has at least one group with at least one item", () => {
    expect(SHORTCUT_GROUPS.length).toBeGreaterThan(0);
    for (const g of SHORTCUT_GROUPS) {
      expect(g.items.length).toBeGreaterThan(0);
    }
  });

  it("has no empty fields", () => {
    for (const g of SHORTCUT_GROUPS) {
      expect(g.title.trim()).not.toBe("");
      for (const i of g.items) {
        expect(i.keys.trim()).not.toBe("");
        expect(i.description.trim()).not.toBe("");
      }
    }
  });

  it("does not advertise the same key combo twice", () => {
    // A duplicate would mean the cheatsheet is lying about behaviour.
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const g of SHORTCUT_GROUPS) {
      for (const i of g.items) {
        if (seen.has(i.keys)) dups.push(i.keys);
        seen.add(i.keys);
      }
    }
    expect(dups).toEqual([]);
  });
});
