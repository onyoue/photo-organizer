import { describe, expect, it } from "vitest";
import { appendTag, removeTag } from "./tags";

describe("appendTag", () => {
  it("appends a trimmed tag", () => {
    expect(appendTag("  shibuya  ", [])).toEqual(["shibuya"]);
  });

  it("returns null for empty input", () => {
    expect(appendTag("", ["a"])).toBeNull();
    expect(appendTag("   ", ["a"])).toBeNull();
  });

  it("returns null for duplicate", () => {
    expect(appendTag("shibuya", ["shibuya"])).toBeNull();
  });

  it("preserves existing order", () => {
    expect(appendTag("c", ["a", "b"])).toEqual(["a", "b", "c"]);
  });

  it("treats different cases as distinct (no normalization beyond trim)", () => {
    // Tags are user-controlled; if someone wants 'Shibuya' alongside 'shibuya'
    // we shouldn't second-guess. Mirrors how Lightroom keywords behave.
    expect(appendTag("Shibuya", ["shibuya"])).toEqual(["shibuya", "Shibuya"]);
  });
});

describe("removeTag", () => {
  it("removes the matching tag, preserving order", () => {
    expect(removeTag("b", ["a", "b", "c"])).toEqual(["a", "c"]);
  });

  it("is a no-op for absent tag", () => {
    expect(removeTag("z", ["a", "b"])).toEqual(["a", "b"]);
  });
});
