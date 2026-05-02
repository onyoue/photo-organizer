import { describe, expect, it } from "vitest";
import { crc32, dedupeFilenames } from "./zip";

describe("crc32", () => {
  it("matches the canonical value for ASCII 'a'", () => {
    expect(crc32(new TextEncoder().encode("a"))).toBe(0xe8b7be43);
  });

  it("matches the canonical value for ASCII 'abc'", () => {
    expect(crc32(new TextEncoder().encode("abc"))).toBe(0x352441c2);
  });

  it("matches the canonical value for the empty string (initial XOR final)", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("is deterministic and unsigned (no negative values)", () => {
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const c = crc32(bytes);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(0xffffffff);
    expect(c).toBe(crc32(bytes));
  });
});

describe("dedupeFilenames", () => {
  it("leaves unique names alone", () => {
    expect(dedupeFilenames(["a.jpg", "b.jpg", "c.jpg"])).toEqual([
      "a.jpg",
      "b.jpg",
      "c.jpg",
    ]);
  });

  it("appends ' (n)' before the extension on collisions", () => {
    expect(dedupeFilenames(["a.jpg", "a.jpg", "a.jpg"])).toEqual([
      "a.jpg",
      "a (1).jpg",
      "a (2).jpg",
    ]);
  });

  it("treats collisions case-insensitively", () => {
    expect(dedupeFilenames(["DSC.JPG", "dsc.jpg"])).toEqual([
      "DSC.JPG",
      "dsc (1).jpg",
    ]);
  });

  it("handles names with no extension", () => {
    expect(dedupeFilenames(["raw", "raw"])).toEqual(["raw", "raw (1)"]);
  });

  it("does not treat leading dot as the extension boundary", () => {
    expect(dedupeFilenames([".hidden", ".hidden"])).toEqual([
      ".hidden",
      ".hidden (1)",
    ]);
  });
});
