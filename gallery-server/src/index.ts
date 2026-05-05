/**
 * Cullback gallery — self-hosted Bun server.
 *
 * One-process drop-in replacement for the Cloudflare Worker, intended to
 * sit behind a Cloudflare Tunnel (or any HTTPS reverse proxy) on the
 * photographer's own machine. Same routes, same desktop API contract.
 *
 * Routes (identical to the Worker's index.ts):
 *   GET  /                            liveness probe
 *   --- admin (Bearer ADMIN_TOKEN) ---
 *   PUT    /admin/<gid>               create gallery
 *   PUT    /admin/<gid>/photos/<pid>  upload photo
 *   POST   /admin/<gid>/finalize      finalize
 *   GET    /admin/<gid>/feedback      aggregated decisions
 *   DELETE /admin/<gid>               delete gallery + photos
 *   GET    /admin/stats               R2-equivalent storage usage
 *   POST   /admin/stats/recompute     rebuild stats from disk
 *   --- public ---
 *   GET    /<gid>                     mobile gallery HTML (full)
 *   GET    /<gid>/view                mobile gallery HTML (read-only)
 *   GET    /<gid>/manifest            JSON manifest
 *   GET    /<gid>/p/<pid>             photo bytes
 *   GET    /<gid>/zip                 ZIP stream
 *   POST   /<gid>/feedback            record a decision
 */

import { resolve } from "node:path";

import { handleAdmin } from "./admin";
import { handlePublic } from "./public";
import type { ServerEnv } from "./storage";
import { text } from "./util";

function loadEnv(): ServerEnv {
  const adminToken = process.env.ADMIN_TOKEN?.trim();
  if (!adminToken) {
    console.error(
      "ADMIN_TOKEN environment variable is required. " +
        "Generate one with `openssl rand -hex 32`, then set it in your .env or systemd unit.",
    );
    process.exit(1);
  }
  const dataDir = resolve(process.env.DATA_DIR?.trim() || "./data");
  return { adminToken, dataDir };
}

function loadPort(): number {
  const raw = process.env.PORT?.trim() || "8787";
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`Invalid PORT: ${raw}`);
    process.exit(1);
  }
  return n;
}

const env = loadEnv();
const port = loadPort();

const server = Bun.serve({
  port,
  hostname: "0.0.0.0",
  // Enough for ZIP downloads of large galleries; the per-upload cap is
  // enforced separately in admin.ts via Content-Length checks.
  maxRequestBodySize: 64 * 1024 * 1024,

  async fetch(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path === "/" || path === "") {
        return text("cullback", 200);
      }
      const segs = path.split("/").filter(Boolean);

      if (segs[0] === "admin") {
        const provided = req.headers.get("Authorization");
        if (provided !== `Bearer ${env.adminToken}`) {
          return text("Unauthorized", 401);
        }
        return await handleAdmin(req, env, segs);
      }
      return await handlePublic(req, env, segs);
    } catch (e) {
      console.error("[unhandled]", e);
      return text("Internal Server Error", 500);
    }
  },
});

console.log(
  `Cullback gallery server listening on http://${server.hostname}:${server.port}\n` +
    `  data dir: ${env.dataDir}\n` +
    `  expose externally via Cloudflare Tunnel / reverse proxy + HTTPS\n` +
    `  desktop app: set Worker URL = your public https://… URL`,
);
