/**
 * Admin endpoints (Bearer ADMIN_TOKEN). Mirrors the Worker's admin.ts
 * one-for-one — desktop's GalleryClient sends identical requests, the only
 * difference is the storage layer (filesystem here, R2/KV there).
 */

import type {
  CreateGalleryBody,
  Decision,
  DefaultDecision,
  FeedbackResponse,
  GalleryMeta,
  PhotoEntry,
  StatsResponse,
} from "./types";
import {
  GID_RE,
  PID_RE,
  R2_FREE_LIMIT_BYTES,
  badRequest,
  json,
  notFound,
  readJson,
  text,
} from "./util";
import { crc32 } from "./zip";
import {
  bumpStats,
  deleteAllPhotosForGallery,
  deleteFeedbackForGallery,
  deleteGalleryMeta,
  getAllFeedback,
  getGalleryMeta,
  headPhoto,
  putGalleryMeta,
  putPhoto,
  readStats,
  recomputeStatsFromDisk,
  type ServerEnv,
} from "./storage";

const MAX_PHOTOS = 500;
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;

export async function handleAdmin(
  req: Request,
  env: ServerEnv,
  segs: string[],
): Promise<Response> {
  const sub = segs[1];
  if (!sub) return notFound();

  if (sub === "stats") {
    const action = segs[2];
    if (!action && req.method === "GET") return getStats(env);
    if (action === "recompute" && req.method === "POST") return recomputeStats(env);
    return notFound();
  }

  if (!GID_RE.test(sub)) return notFound();
  const gid = sub;
  const action = segs[2];

  if (!action) {
    if (req.method === "PUT") return createGallery(req, env, gid);
    if (req.method === "DELETE") return deleteGallery(env, gid);
    return notFound();
  }
  if (action === "photos" && segs[3] && req.method === "PUT") {
    return uploadPhoto(req, env, gid, segs[3]);
  }
  if (action === "finalize" && req.method === "POST") {
    return finalizeGallery(env, gid);
  }
  if (action === "feedback" && req.method === "GET") {
    return getFeedback(env, gid);
  }
  return notFound();
}

// ---------- gallery lifecycle ----------------------------------------------

async function createGallery(req: Request, env: ServerEnv, gid: string): Promise<Response> {
  const body = await readJson<CreateGalleryBody>(req);
  if (!body) return badRequest("invalid JSON body");
  if (typeof body.name !== "string" || !body.name.trim()) return badRequest("name required");
  if (!isValidDefaultDecision(body.default_decision)) {
    return badRequest("default_decision must be 'ok' or 'ng'");
  }
  const expiresAt = Date.parse(body.expires_at);
  if (Number.isNaN(expiresAt)) return badRequest("expires_at must be ISO-8601");
  if (expiresAt <= Date.now()) return badRequest("expires_at must be in the future");
  if (!Array.isArray(body.photos) || body.photos.length === 0) {
    return badRequest("photos must be a non-empty array");
  }
  if (body.photos.length > MAX_PHOTOS) return badRequest(`too many photos (max ${MAX_PHOTOS})`);
  for (const p of body.photos) {
    if (!isValidPhotoEntry(p)) return badRequest(`invalid photo entry: ${JSON.stringify(p)}`);
  }
  if ((await getGalleryMeta(env, gid)) !== null) return text("Conflict", 409);

  const meta: GalleryMeta = {
    name: body.name.trim(),
    created_at: new Date().toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
    default_decision: body.default_decision,
    finalized: false,
    photos: body.photos.map(normalizePhotoEntry),
  };
  await putGalleryMeta(env, gid, meta);
  await bumpStats(env, { gallery_count: 1 });
  return json({ gid, finalized: false }, 201);
}

async function uploadPhoto(
  req: Request,
  env: ServerEnv,
  gid: string,
  pid: string,
): Promise<Response> {
  if (!PID_RE.test(pid)) return badRequest("invalid pid");
  const meta = await getGalleryMeta(env, gid);
  if (!meta) return notFound();
  const known = meta.photos.find((p) => p.pid === pid);
  if (!known) return badRequest("pid not declared at gallery creation");

  const len = req.headers.get("content-length");
  if (len && Number(len) > MAX_PHOTO_BYTES) return text("Payload Too Large", 413);

  const contentType = req.headers.get("content-type") ?? known.content_type;
  const body = await req.arrayBuffer();
  if (body.byteLength === 0) return badRequest("empty body");
  if (body.byteLength > MAX_PHOTO_BYTES) return text("Payload Too Large", 413);

  const previous = await headPhoto(env, gid, pid);
  const crc = crc32(new Uint8Array(body));
  await putPhoto(env, gid, pid, body, {
    contentType,
    size: body.byteLength,
    crc32: crc.toString(16).padStart(8, "0"),
  });
  const delta = body.byteLength - (previous?.size ?? 0);
  const photoDelta = previous ? 0 : 1;
  await bumpStats(env, { r2_bytes: delta, photo_count: photoDelta });
  return json({ pid, size: body.byteLength, crc32: crc.toString(16) });
}

async function finalizeGallery(env: ServerEnv, gid: string): Promise<Response> {
  const meta = await getGalleryMeta(env, gid);
  if (!meta) return notFound();
  if (meta.finalized) return json({ gid, finalized: true });
  for (const p of meta.photos) {
    const head = await headPhoto(env, gid, p.pid);
    if (!head) return badRequest(`photo missing in storage: ${p.pid}`);
  }
  meta.finalized = true;
  await putGalleryMeta(env, gid, meta);
  return json({ gid, finalized: true });
}

async function getFeedback(env: ServerEnv, gid: string): Promise<Response> {
  const meta = await getGalleryMeta(env, gid);
  if (!meta) return notFound();
  const decisions = await getAllFeedback(env, gid);
  const out: FeedbackResponse = {
    default_decision: meta.default_decision,
    decisions,
  };
  return json(out);
}

async function deleteGallery(env: ServerEnv, gid: string): Promise<Response> {
  const meta = await getGalleryMeta(env, gid);
  if (!meta) return notFound();
  // Sum bytes BEFORE delete so stats stay correct.
  let bytesRemoved = 0;
  let photosRemoved = 0;
  for (const p of meta.photos) {
    if (typeof p.size === "number") {
      bytesRemoved += p.size;
    } else {
      const head = await headPhoto(env, gid, p.pid);
      if (head) bytesRemoved += head.size;
    }
    photosRemoved++;
  }
  await deleteAllPhotosForGallery(env, gid);
  await deleteFeedbackForGallery(env, gid);
  await deleteGalleryMeta(env, gid);
  await bumpStats(env, {
    r2_bytes: -bytesRemoved,
    photo_count: -photosRemoved,
    gallery_count: -1,
  });
  return json({ gid, deleted: true });
}

// ---------- stats ----------------------------------------------------------

async function getStats(env: ServerEnv): Promise<Response> {
  const totals = await readStats(env);
  // Echo the same R2 free-tier ceiling the Worker reports so the desktop
  // UI's bar reads the same regardless of which backend it's pointed at.
  // Self-hosted users can still treat this as a soft "I'm using N GB" line.
  const out: StatsResponse = { ...totals, r2_bytes_limit: R2_FREE_LIMIT_BYTES };
  return json(out, 200, { "cache-control": "no-store" });
}

async function recomputeStats(env: ServerEnv): Promise<Response> {
  const totals = await recomputeStatsFromDisk(env);
  const out: StatsResponse = { ...totals, r2_bytes_limit: R2_FREE_LIMIT_BYTES };
  return json(out);
}

// ---------- validation helpers ---------------------------------------------

function isValidDefaultDecision(v: unknown): v is DefaultDecision {
  return v === "ok" || v === "ng";
}

function isValidPhotoEntry(p: unknown): p is PhotoEntry {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  if (typeof o.pid !== "string" || !PID_RE.test(o.pid)) return false;
  if (typeof o.filename !== "string" || !o.filename || o.filename.length > 200) return false;
  if (typeof o.content_type !== "string" || !o.content_type.startsWith("image/")) return false;
  if (o.size !== undefined && typeof o.size !== "number") return false;
  return true;
}

function normalizePhotoEntry(p: PhotoEntry): PhotoEntry {
  return {
    pid: p.pid,
    filename: p.filename,
    content_type: p.content_type,
    ...(p.size !== undefined ? { size: p.size } : {}),
  };
}

// Decision is referenced via the JSON return shape, but TS's
// noUnusedLocals would complain — keep the import live with this
// no-op type alias.
export type _DecisionReexport = Decision;
