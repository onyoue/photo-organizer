import type {
  CreateGalleryBody,
  DefaultDecision,
  Decision,
  Env,
  FeedbackResponse,
  GalleryMeta,
  PhotoEntry,
} from "./types";
import {
  GID_RE,
  PID_RE,
  badRequest,
  json,
  kvKeyForGallery,
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

  await env.GALLERY_BUCKET.put(r2KeyForPhoto(gid, pid), body, {
    httpMetadata: { contentType },
    customMetadata: {
      crc32: crc.toString(16).padStart(8, "0"),
      size: body.byteLength.toString(),
    },
  });
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
  // Meta
  await env.GALLERY_KV.delete(kvKeyForGallery(gid));

  return json({ gid, deleted: true });
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
