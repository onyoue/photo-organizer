import type {
  CreateGalleryBody,
  DefaultDecision,
  Decision,
  Env,
  FeedbackResponse,
  GalleryMeta,
  PhotoEntry,
  StatsResponse,
  StatsTotals,
  ViewedRecord,
} from "./types";
import {
  GID_RE,
  KV_KEY_STATS,
  PID_RE,
  R2_FREE_LIMIT_BYTES,
  badRequest,
  json,
  kvKeyForGallery,
  kvKeyForViewed,
  kvPrefixForFeedback,
  notFound,
  r2KeyForPhoto,
  readJson,
  text,
} from "./util";
import { crc32 } from "./zip";

const MAX_PHOTOS = 500;
const MAX_PHOTO_BYTES = 25 * 1024 * 1024; // per-file upload limit

export async function handleAdmin(
  req: Request,
  env: Env,
  segs: string[],
): Promise<Response> {
  // segs[0] === "admin"
  const sub = segs[1];
  if (!sub) return notFound();

  // Stats endpoints live under /admin/stats — handle before the GID
  // regex so "stats" doesn't get rejected as a malformed ULID.
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
  if (action === "views" && req.method === "GET") {
    return getViews(env, gid);
  }

  return notFound();
}

async function createGallery(req: Request, env: Env, gid: string): Promise<Response> {
  const body = await readJson<CreateGalleryBody>(req);
  if (!body) return badRequest("invalid JSON body");

  if (typeof body.name !== "string" || !body.name.trim()) {
    return badRequest("name required");
  }
  if (!isValidDefaultDecision(body.default_decision)) {
    return badRequest("default_decision must be 'ok' or 'ng'");
  }
  const expiresAt = Date.parse(body.expires_at);
  if (Number.isNaN(expiresAt)) {
    return badRequest("expires_at must be ISO-8601");
  }
  if (expiresAt <= Date.now()) {
    return badRequest("expires_at must be in the future");
  }
  if (!Array.isArray(body.photos) || body.photos.length === 0) {
    return badRequest("photos must be a non-empty array");
  }
  if (body.photos.length > MAX_PHOTOS) {
    return badRequest(`too many photos (max ${MAX_PHOTOS})`);
  }
  for (const p of body.photos) {
    if (!isValidPhotoEntry(p)) return badRequest(`invalid photo entry: ${JSON.stringify(p)}`);
  }
  // Prevent silent overwrites — if a gallery already exists, reject
  const existing = await env.GALLERY_KV.get(kvKeyForGallery(gid));
  if (existing) return text("Conflict", 409);

  const meta: GalleryMeta = {
    name: body.name.trim(),
    created_at: new Date().toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
    default_decision: body.default_decision,
    finalized: false,
    photos: body.photos.map(normalizePhotoEntry),
  };

  await env.GALLERY_KV.put(kvKeyForGallery(gid), JSON.stringify(meta));
  await bumpStats(env, { gallery_count: 1 });
  return json({ gid, finalized: false }, 201);
}

async function uploadPhoto(
  req: Request,
  env: Env,
  gid: string,
  pid: string,
): Promise<Response> {
  if (!PID_RE.test(pid)) return badRequest("invalid pid");

  const meta = await loadMeta(env, gid);
  if (!meta) return notFound();
  const known = meta.photos.find((p) => p.pid === pid);
  if (!known) return badRequest("pid not declared at gallery creation");

  const len = req.headers.get("content-length");
  if (len && Number(len) > MAX_PHOTO_BYTES) {
    return text("Payload Too Large", 413);
  }

  const contentType = req.headers.get("content-type") ?? known.content_type;
  const body = await req.arrayBuffer();
  if (body.byteLength === 0) return badRequest("empty body");
  if (body.byteLength > MAX_PHOTO_BYTES) return text("Payload Too Large", 413);

  // Pre-compute CRC-32 here (CPU cost paid per upload, ~few ms per MB).
  // Stored on the R2 object so the ZIP route can stream bytes without
  // touching CPU on the way out.
  const crc = crc32(new Uint8Array(body));

  // If a previous upload for this pid succeeded but the request was retried,
  // we'd otherwise double-count R2 bytes. Subtract the existing object's
  // size first so net delta is correct.
  const previous = await env.GALLERY_BUCKET.head(r2KeyForPhoto(gid, pid));
  await env.GALLERY_BUCKET.put(r2KeyForPhoto(gid, pid), body, {
    httpMetadata: { contentType },
    customMetadata: {
      crc32: crc.toString(16).padStart(8, "0"),
      size: body.byteLength.toString(),
    },
  });
  const delta = body.byteLength - (previous?.size ?? 0);
  const photoDelta = previous ? 0 : 1;
  await bumpStats(env, { r2_bytes: delta, photo_count: photoDelta });
  return json({ pid, size: body.byteLength, crc32: crc.toString(16) });
}

async function finalizeGallery(env: Env, gid: string): Promise<Response> {
  const meta = await loadMeta(env, gid);
  if (!meta) return notFound();
  if (meta.finalized) return json({ gid, finalized: true });

  // Verify each declared photo is actually in R2 — partial uploads should not finalize.
  for (const p of meta.photos) {
    const obj = await env.GALLERY_BUCKET.head(r2KeyForPhoto(gid, p.pid));
    if (!obj) return badRequest(`photo missing in storage: ${p.pid}`);
  }

  meta.finalized = true;
  await env.GALLERY_KV.put(kvKeyForGallery(gid), JSON.stringify(meta));
  return json({ gid, finalized: true });
}

/// Read receipt for the gallery — null when the model hasn't opened
/// it yet. The photographer's own /view path doesn't bump this counter.
async function getViews(env: Env, gid: string): Promise<Response> {
  const raw = await env.GALLERY_KV.get(kvKeyForViewed(gid));
  if (!raw) return json(null, 200, { "cache-control": "no-store" });
  try {
    const parsed = JSON.parse(raw) as ViewedRecord;
    return json(parsed, 200, { "cache-control": "no-store" });
  } catch {
    return json(null, 200, { "cache-control": "no-store" });
  }
}

async function getFeedback(env: Env, gid: string): Promise<Response> {
  const meta = await loadMeta(env, gid);
  if (!meta) return notFound();

  const decisions: Record<string, Decision> = {};
  let cursor: string | undefined;
  do {
    const page = await env.GALLERY_KV.list({
      prefix: kvPrefixForFeedback(gid),
      cursor,
    });
    for (const k of page.keys) {
      const pid = k.name.slice(kvPrefixForFeedback(gid).length);
      const v = await env.GALLERY_KV.get(k.name);
      if (v === "ok" || v === "ng" || v === "fav") decisions[pid] = v;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const out: FeedbackResponse = {
    default_decision: meta.default_decision,
    decisions,
  };
  return json(out);
}

async function deleteGallery(env: Env, gid: string): Promise<Response> {
  const meta = await loadMeta(env, gid);
  if (!meta) return notFound();

  // Sum bytes-to-decrement BEFORE delete. PhotoEntry.size is set by the
  // desktop client at create time — fall back to R2 head if missing.
  let bytesRemoved = 0;
  let photosRemoved = 0;
  for (const p of meta.photos) {
    if (typeof p.size === "number") {
      bytesRemoved += p.size;
    } else {
      const obj = await env.GALLERY_BUCKET.head(r2KeyForPhoto(gid, p.pid));
      if (obj) bytesRemoved += obj.size;
    }
    photosRemoved++;
  }

  // Photos
  for (const p of meta.photos) {
    await env.GALLERY_BUCKET.delete(r2KeyForPhoto(gid, p.pid));
  }
  // Feedback
  let cursor: string | undefined;
  do {
    const page = await env.GALLERY_KV.list({
      prefix: kvPrefixForFeedback(gid),
      cursor,
    });
    for (const k of page.keys) await env.GALLERY_KV.delete(k.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  // Meta + read-receipt counter
  await env.GALLERY_KV.delete(kvKeyForGallery(gid));
  await env.GALLERY_KV.delete(kvKeyForViewed(gid));

  await bumpStats(env, {
    r2_bytes: -bytesRemoved,
    photo_count: -photosRemoved,
    gallery_count: -1,
  });

  return json({ gid, deleted: true });
}

// ---------- stats -----------------------------------------------------------

async function getStats(env: Env): Promise<Response> {
  const totals = await readStats(env);
  const out: StatsResponse = {
    ...totals,
    r2_bytes_limit: R2_FREE_LIMIT_BYTES,
  };
  return json(out, 200, { "cache-control": "no-store" });
}

async function recomputeStats(env: Env): Promise<Response> {
  // Walk every gallery KV record and sum sizes from PhotoEntry.size — same
  // value the desktop client supplies at create time and that we'd otherwise
  // be tracking incrementally. Bounded by the gallery_count, so list calls
  // are cheap (a few thousand at most on this free tier).
  let r2_bytes = 0;
  let photo_count = 0;
  let gallery_count = 0;
  let cursor: string | undefined;
  do {
    const page = await env.GALLERY_KV.list({ prefix: "gallery:", cursor });
    for (const k of page.keys) {
      const raw = await env.GALLERY_KV.get(k.name);
      if (!raw) continue;
      let meta: GalleryMeta;
      try {
        meta = JSON.parse(raw) as GalleryMeta;
      } catch {
        continue;
      }
      gallery_count++;
      for (const p of meta.photos) {
        if (typeof p.size === "number") {
          r2_bytes += p.size;
        } else {
          // Pre-stats-tracking entry without a recorded size — fall back
          // to R2 head. Slow but only matters on the first recompute.
          const obj = await env.GALLERY_BUCKET.head(
            r2KeyForPhoto(k.name.slice("gallery:".length), p.pid),
          );
          if (obj) r2_bytes += obj.size;
        }
        photo_count++;
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const totals: StatsTotals = {
    r2_bytes,
    photo_count,
    gallery_count,
    updated_at: new Date().toISOString(),
  };
  await env.GALLERY_KV.put(KV_KEY_STATS, JSON.stringify(totals));
  const out: StatsResponse = {
    ...totals,
    r2_bytes_limit: R2_FREE_LIMIT_BYTES,
  };
  return json(out);
}

async function readStats(env: Env): Promise<StatsTotals> {
  const raw = await env.GALLERY_KV.get(KV_KEY_STATS);
  if (raw) {
    try {
      const s = JSON.parse(raw) as StatsTotals;
      // Coerce in case an older entry is missing fields.
      return {
        r2_bytes: typeof s.r2_bytes === "number" ? s.r2_bytes : 0,
        photo_count: typeof s.photo_count === "number" ? s.photo_count : 0,
        gallery_count: typeof s.gallery_count === "number" ? s.gallery_count : 0,
        updated_at: typeof s.updated_at === "string" ? s.updated_at : new Date(0).toISOString(),
      };
    } catch {
      /* fall through */
    }
  }
  return {
    r2_bytes: 0,
    photo_count: 0,
    gallery_count: 0,
    updated_at: new Date(0).toISOString(),
  };
}

/** Read–modify–write the stats counter. KV has no atomic increment; the
 *  single-photographer use case makes the race window negligible, and a
 *  drift can be repaired with POST /admin/stats/recompute. */
async function bumpStats(
  env: Env,
  delta: Partial<Pick<StatsTotals, "r2_bytes" | "photo_count" | "gallery_count">>,
): Promise<void> {
  const s = await readStats(env);
  if (delta.r2_bytes) s.r2_bytes = Math.max(0, s.r2_bytes + delta.r2_bytes);
  if (delta.photo_count) s.photo_count = Math.max(0, s.photo_count + delta.photo_count);
  if (delta.gallery_count) s.gallery_count = Math.max(0, s.gallery_count + delta.gallery_count);
  s.updated_at = new Date().toISOString();
  await env.GALLERY_KV.put(KV_KEY_STATS, JSON.stringify(s));
}

// ---------- helpers ---------------------------------------------------------

async function loadMeta(env: Env, gid: string): Promise<GalleryMeta | null> {
  const raw = await env.GALLERY_KV.get(kvKeyForGallery(gid));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GalleryMeta;
  } catch {
    return null;
  }
}

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
