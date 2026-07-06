import { describe, expect, it } from "vitest";
import {
  ancestorPaths,
  isPathWithin,
  parentPath,
  pathLabel,
} from "./path";

describe("path helpers", () => {
  it("finds Windows parents", () => {
    expect(parentPath("D:\\Photos\\2026\\Shoot")).toBe("D:\\Photos\\2026");
    expect(parentPath("D:\\Photos")).toBe("D:\\");
    expect(parentPath("D:\\")).toBeNull();
  });

  it("checks descendants across slash styles", () => {
    expect(isPathWithin("D:\\Photos\\2026", "D:/Photos")).toBe(true);
    expect(isPathWithin("D:\\PhotoArchive", "D:/Photos")).toBe(false);
  });

  it("labels roots and leaf folders", () => {
    expect(pathLabel("D:\\")).toBe("D:\\");
    expect(pathLabel("D:\\Photos\\2026")).toBe("2026");
  });

  it("builds ancestor chains from root to current", () => {
    expect(ancestorPaths("D:\\Photos", "D:\\Photos\\2026\\Shoot")).toEqual([
      "D:\\Photos",
      "D:\\Photos\\2026",
      "D:\\Photos\\2026\\Shoot",
    ]);
  });
});
