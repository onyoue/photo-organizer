import { describe, expect, it } from "vitest";
import { renderGalleryHtml } from "./html";
import type { GalleryMeta } from "./types";

const BASE: GalleryMeta = {
  name: "Test gallery",
  created_at: "2026-05-01T00:00:00Z",
  expires_at: "2026-05-08T00:00:00Z",
  default_decision: "ok",
  finalized: true,
  photos: [
    { pid: "p1", filename: "DSC_0001.jpg", content_type: "image/jpeg" },
    { pid: "p2", filename: "DSC_0002.jpg", content_type: "image/jpeg" },
  ],
};

describe("renderGalleryHtml", () => {
  const GID = "01HX1234567890ABCDEFGHJKMN";

  it("renders a complete HTML document with the gallery name", () => {
    const html = renderGalleryHtml(GID, BASE, {});
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Test gallery</title>");
    expect(html).toContain(`href="/${GID}/zip"`);
  });

  it("escapes HTML in the gallery name (no script injection via name)", () => {
    const meta: GalleryMeta = { ...BASE, name: "<script>alert(1)</script>" };
    const html = renderGalleryHtml(GID, meta, {});
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("does not let </script> in the manifest break out of the inline script tag", () => {
    const meta: GalleryMeta = {
      ...BASE,
      name: "</script><script>alert(1)//",
    };
    const html = renderGalleryHtml(GID, meta, {});
    // Only legitimate </script> closings should appear: data + app code.
    // (Opening "<script>" inside the JSON string is inert — the HTML parser
    // stays in script-data state until it sees a real </script>.)
    const closings = html.match(/<\/script>/gi) ?? [];
    expect(closings.length).toBe(2);
  });

  it("inlines the manifest as JSON inside window.__G__", () => {
    const html = renderGalleryHtml(GID, BASE, { p1: "ng" });
    expect(html).toContain("window.__G__=");
    expect(html).toContain('"gid":"' + GID + '"');
    expect(html).toContain('"default_decision":"ok"');
    expect(html).toContain('"p1":"ng"');
  });

  it("strips per-photo content_type/size from the inlined manifest", () => {
    // The client only needs pid + filename; content_type and size live on
    // the R2 object itself. (A generic "image/jpeg" fallback string can
    // appear in the inline JS — that's a default for blob.type, not
    // leaked per-photo metadata.)
    const html = renderGalleryHtml(GID, BASE, {});
    expect(html).not.toContain("content_type");
    expect(html).not.toContain('"size":');
  });
});
