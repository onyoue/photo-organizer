/**
 * Filesystem-backed storage layer.
 *
 * The Worker version of this app talks to Cloudflare R2 (photo bytes) and
 * Cloudflare KV (gallery metadata + per-photo decisions). The self-hosted
 * server replaces both with on-disk files under `DATA_DIR`. No SQLite, no
 * external service — just an open directory the user can `tar` for backup.
 *
 * Layout under `DATA_DIR`:
 *
 *   photos/<gid>/<pid>             raw photo bytes
 *   photos/<gid>/<pid>.meta.json   small companion: { contentType, size, crc32 }
 *   galleries/<gid>.json           GalleryMeta (mirrors KV `gallery:<gid>`)
 *   feedback/<gid>/<pid>           one of: "ok" | "ng" | "fav"
 *   stats.json                     aggregated counters
 *
 * Atomic writes use `write tmp -> rename`. Reads pre-check existence and
 * return null on miss — same shape as KV.get / R2.get returning undefined.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Decision, GalleryMeta, StatsTotals } from "./types";

export interface ServerEnv {
  /** Absolute path to the data directory. */
  dataDir: string;
  /** Bearer token for /admin/* routes. */
  adminToken: string;
}

/// Photo metadata mirrors what the Worker stored under R2 customMetadata.
export interface PhotoStoredMeta {
  contentType: string;
  size: number;
  /** 8-char zero-padded hex of the precomputed CRC-32. The ZIP route relies
   *  on this so it can stream the bytes through without doing a CRC pass. */
  crc32: string;
}

// ---------- helpers ---------------------------------------------------------

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function atomicWrite(path: string, data: Uint8Array | string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// ---------- gallery meta (= KV gallery:<gid>) -------------------------------

function galleryPath(env: ServerEnv, gid: string): string {
  return join(env.dataDir, "galleries", `${gid}.json`);
}

export async function getGalleryMeta(env: ServerEnv, gid: string): Promise<GalleryMeta | null> {
  return readJson<GalleryMeta>(galleryPath(env, gid));
}

export async function putGalleryMeta(env: ServerEnv, gid: string, meta: GalleryMeta): Promise<void> {
  await ensureDir(join(env.dataDir, "galleries"));
  await atomicWrite(galleryPath(env, gid), JSON.stringify(meta, null, 2));
}

export async function deleteGalleryMeta(env: ServerEnv, gid: string): Promise<void> {
  const path = galleryPath(env, gid);
  if (existsSync(path)) await rm(path);
}

// ---------- photo bytes (= R2) ----------------------------------------------

function photoBytesPath(env: ServerEnv, gid: string, pid: string): string {
  return join(env.dataDir, "photos", gid, pid);
}
function photoMetaPath(env: ServerEnv, gid: string, pid: string): string {
  return `${photoBytesPath(env, gid, pid)}.meta.json`;
}

export async function putPhoto(
  env: ServerEnv,
  gid: string,
  pid: string,
  bytes: ArrayBuffer | Uint8Array,
  meta: PhotoStoredMeta,
): Promise<void> {
  await ensureDir(join(env.dataDir, "photos", gid));
  const buf = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  await atomicWrite(photoBytesPath(env, gid, pid), buf);
  await atomicWrite(photoMetaPath(env, gid, pid), JSON.stringify(meta));
}

/// Returns null when the photo doesn't exist on disk.
export async function headPhoto(
  env: ServerEnv,
  gid: string,
  pid: string,
): Promise<PhotoStoredMeta | null> {
  return readJson<PhotoStoredMeta>(photoMetaPath(env, gid, pid));
}

/// Streams the photo body. Throws if the file doesn't exist — caller should
/// `headPhoto` first when "missing" is a normal outcome.
export function openPhotoStream(env: ServerEnv, gid: string, pid: string): {
  stream: ReadableStream<Uint8Array>;
  size: number;
  contentType: string;
} {
  // Caller must have already established the file exists via headPhoto.
  // Bun.file gives us a streaming view that backpressures correctly for
  // the ZIP route's per-chunk emit pattern.
  const file = Bun.file(photoBytesPath(env, gid, pid));
  return {
    stream: file.stream(),
    size: file.size,
    contentType: file.type || "application/octet-stream",
  };
}

export async function deletePhoto(env: ServerEnv, gid: string, pid: string): Promise<void> {
  const bytes = photoBytesPath(env, gid, pid);
  const meta = photoMetaPath(env, gid, pid);
  if (existsSync(bytes)) await rm(bytes);
  if (existsSync(meta)) await rm(meta);
}

export async function deleteAllPhotosForGallery(env: ServerEnv, gid: string): Promise<void> {
  const dir = join(env.dataDir, "photos", gid);
  if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
}

// ---------- feedback (= KV feedback:<gid>:<pid>) ----------------------------

function feedbackDir(env: ServerEnv, gid: string): string {
  return join(env.dataDir, "feedback", gid);
}

function feedbackPath(env: ServerEnv, gid: string, pid: string): string {
  return join(feedbackDir(env, gid), pid);
}

export async function setFeedback(
  env: ServerEnv,
  gid: string,
  pid: string,
  decision: Decision,
): Promise<void> {
  await ensureDir(feedbackDir(env, gid));
  await atomicWrite(feedbackPath(env, gid, pid), decision);
}

export async function clearFeedback(env: ServerEnv, gid: string, pid: string): Promise<void> {
  const path = feedbackPath(env, gid, pid);
  if (existsSync(path)) await rm(path);
}

export async function getAllFeedback(
  env: ServerEnv,
  gid: string,
): Promise<Record<string, Decision>> {
  const dir = feedbackDir(env, gid);
  if (!existsSync(dir)) return {};
  const out: Record<string, Decision> = {};
  for (const pid of await readdir(dir)) {
    try {
      const value = (await readFile(join(dir, pid), "utf8")).trim();
      if (value === "ok" || value === "ng" || value === "fav") {
        out[pid] = value;
      }
    } catch {
      // skip unreadable entries
    }
  }
  return out;
}

export async function deleteFeedbackForGallery(env: ServerEnv, gid: string): Promise<void> {
  const dir = feedbackDir(env, gid);
  if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
}

// ---------- stats counter (= KV stats:totals) -------------------------------

const ZERO_STATS: StatsTotals = {
  r2_bytes: 0,
  photo_count: 0,
  gallery_count: 0,
  updated_at: new Date(0).toISOString(),
};

function statsPath(env: ServerEnv): string {
  return join(env.dataDir, "stats.json");
}

export async function readStats(env: ServerEnv): Promise<StatsTotals> {
  const cur = await readJson<StatsTotals>(statsPath(env));
  if (!cur) return { ...ZERO_STATS };
  return {
    r2_bytes: typeof cur.r2_bytes === "number" ? cur.r2_bytes : 0,
    photo_count: typeof cur.photo_count === "number" ? cur.photo_count : 0,
    gallery_count: typeof cur.gallery_count === "number" ? cur.gallery_count : 0,
    updated_at: typeof cur.updated_at === "string" ? cur.updated_at : new Date(0).toISOString(),
  };
}

export async function writeStats(env: ServerEnv, stats: StatsTotals): Promise<void> {
  await ensureDir(env.dataDir);
  await atomicWrite(statsPath(env), JSON.stringify(stats, null, 2));
}

export async function bumpStats(
  env: ServerEnv,
  delta: Partial<Pick<StatsTotals, "r2_bytes" | "photo_count" | "gallery_count">>,
): Promise<void> {
  const s = await readStats(env);
  if (delta.r2_bytes) s.r2_bytes = Math.max(0, s.r2_bytes + delta.r2_bytes);
  if (delta.photo_count) s.photo_count = Math.max(0, s.photo_count + delta.photo_count);
  if (delta.gallery_count) s.gallery_count = Math.max(0, s.gallery_count + delta.gallery_count);
  s.updated_at = new Date().toISOString();
  await writeStats(env, s);
}

/// Walk all gallery JSONs + photo metadata and rebuild the stats counter
/// from scratch. Used by POST /admin/stats/recompute when the running
/// counter has drifted (it shouldn't, but the desktop UI exposes a button
/// for parity with the Worker's recompute path).
export async function recomputeStatsFromDisk(env: ServerEnv): Promise<StatsTotals> {
  const galleriesDir = join(env.dataDir, "galleries");
  let r2_bytes = 0;
  let photo_count = 0;
  let gallery_count = 0;
  if (existsSync(galleriesDir)) {
    for (const f of await readdir(galleriesDir)) {
      if (!f.endsWith(".json")) continue;
      const meta = await readJson<GalleryMeta>(join(galleriesDir, f));
      if (!meta) continue;
      gallery_count += 1;
      for (const p of meta.photos) {
        photo_count += 1;
        if (typeof p.size === "number") {
          r2_bytes += p.size;
        } else {
          // Unrecorded size — fall back to disk stat. Slow path, only
          // hit on legacy entries from before size was tracked.
          const gid = f.replace(/\.json$/, "");
          const path = photoBytesPath(env, gid, p.pid);
          if (existsSync(path)) {
            r2_bytes += (await stat(path)).size;
          }
        }
      }
    }
  }
  const totals: StatsTotals = {
    r2_bytes,
    photo_count,
    gallery_count,
    updated_at: new Date().toISOString(),
  };
  await writeStats(env, totals);
  return totals;
}

// ---------- iteration ------------------------------------------------------

/// Yields every gid that has a gallery file on disk. Used by recompute.
export async function listGalleryIds(env: ServerEnv): Promise<string[]> {
  const dir = join(env.dataDir, "galleries");
  if (!existsSync(dir)) return [];
  return (await readdir(dir))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}
