import type { Decision, DefaultDecision, Env, GalleryMeta, ViewedRecord } from "./types";
import {
  GID_RE,
  PID_RE,
  badRequest,
  gone,
  isExpired,
  json,
  kvKeyForFeedback,
  kvKeyForGallery,
  kvKeyForViewed,
  kvPrefixForFeedback,
  notFound,
  r2KeyForPhoto,
  readJson,
} from "./util";
import { ZipStreamWriter, dedupeFilenames } from "./zip";
import { renderGalleryHtml } from "./html";

interface PublicPhoto {
  pid: string;
  filename: string;
}

interface PublicManifest {
  name: string;
  expires_at: string;
  default_decision: DefaultDecision;
  photos: PublicPhoto[];
  decisions: Record<string, Decision>;
}

interface FeedbackBody {
  pid: string;
  decision: "ok" | "ng" | "fav" | "clear";
}

export async function handlePublic(
  req: Request,
  env: Env,
  segs: string[],
): Promise<Response> {
  if (segs.length === 0) return notFound();
  const gid = segs[0];
  if (!GID_RE.test(gid)) return notFound();

  const meta = await loadMeta(env, gid);
  if (!meta || !meta.finalized) return notFound();
  if (isExpired(meta.expires_at)) return gone();

  const action = segs[1];

  if (!action && req.method === "GET") return galleryHtml(env, gid, meta, false);

  // Read-only variant for the photographer's own preview — same gallery,
  // same photos, but the rendered HTML hides the OK/NG/FAV buttons so an
  // accidental tap can't overwrite a model's verdict.
  if (action === "view" && req.method === "GET") {
    return galleryHtml(env, gid, meta, true);
  }

  if (action === "manifest" && req.method === "GET") {
    return json(await buildManifest(env, gid, meta), 200, {
      "cache-control": "no-store",
    });
  }

  if (action === "p" && segs[2] && req.method === "GET") {
    return photoProxy(req, env, gid, segs[2], meta);
  }

  if (action === "feedback" && req.method === "POST") {
    return setFeedback(req, env, gid, meta);
  }

  if (action === "zip" && req.method === "GET") {
    const url = new URL(req.url);
    const pidsParam = url.searchParams.get("pids");
    return zipStream(env, gid, meta, pidsParam);
  }

  return notFound();
}

async function loadDecisions(
  env: Env,
  gid: string,
): Promise<Record<string, Decision>> {
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
  return decisions;
}

async function buildManifest(
  env: Env,
  gid: string,
  meta: GalleryMeta,
): Promise<PublicManifest> {
  return {
    name: meta.name,
    expires_at: meta.expires_at,
    default_decision: meta.default_decision,
    photos: meta.photos.map((p) => ({ pid: p.pid, filename: p.filename })),
    decisions: await loadDecisions(env, gid),
  };
}

// Photos uploaded under /<gid>/p/<pid> are immutable — pid is unique per
// upload and the desktop app never re-puts the same key — so we hand the
// browser a 7-day cache window with the `immutable` hint so it doesn't
// even bother revalidating until expiry. `private` keeps Cloudflare's
// edge cache out of the loop, so an admin-deleted gallery stops serving
// to anyone whose local cache hasn't seen the photo yet.
const PHOTO_CACHE_CONTROL = "private, max-age=604800, immutable";

async function photoProxy(
  req: Request,
  env: Env,
  gid: string,
  pid: string,
  meta: GalleryMeta,
): Promise<Response> {
  if (!PID_RE.test(pid)) return notFound();
  if (!meta.photos.some((p) => p.pid === pid)) return notFound();

  const r2Key = r2KeyForPhoto(gid, pid);
  const ifNoneMatch = req.headers.get("If-None-Match");

  // When the browser revalidates with If-None-Match, push the etag check
  // down into R2 — if the etag still matches the stored object, R2 hands
  // us back metadata only (no body bytes streamed) and we turn that into
  // a 304. Saves both Worker egress and R2 read bytes on the cold-cache
  // revalidation path.
  const obj = ifNoneMatch
    ? await env.GALLERY_BUCKET.get(r2Key, {
        onlyIf: { etagDoesNotMatch: ifNoneMatch },
      })
    : await env.GALLERY_BUCKET.get(r2Key);
  if (!obj) return notFound();

  // R2.get with onlyIf returns R2Object (no body) when the precondition
  // matches and R2ObjectBody otherwise. TypeScript's narrowing across that
  // union is fragile, so we just check for `body` and cast.
  const body = (obj as R2ObjectBody).body;
  if (!body) {
    return new Response(null, {
      status: 304,
      headers: {
        etag: obj.httpEtag,
        "cache-control": PHOTO_CACHE_CONTROL,
      },
    });
  }

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", PHOTO_CACHE_CONTROL);
  headers.set("x-robots-tag", "noindex");

  return new Response(body, { headers });
}

async function setFeedback(
  req: Request,
  env: Env,
  gid: string,
  meta: GalleryMeta,
): Promise<Response> {
  const body = await readJson<FeedbackBody>(req, 1024);
  if (!body) return badRequest("invalid JSON body");
  if (typeof body.pid !== "string" || !PID_RE.test(body.pid)) {
    return badRequest("invalid pid");
  }
  if (!meta.photos.some((p) => p.pid === body.pid)) {
    return badRequest("unknown pid");
  }
  if (
    body.decision !== "ok" &&
    body.decision !== "ng" &&
    body.decision !== "fav" &&
    body.decision !== "clear"
  ) {
    return badRequest("decision must be ok, ng, fav, or clear");
  }

  const key = kvKeyForFeedback(gid, body.pid);
  if (body.decision === "clear") {
    await env.GALLERY_KV.delete(key);
  } else {
    await env.GALLERY_KV.put(key, body.decision);
  }
  return json({ pid: body.pid, decision: body.decision });
}

async function galleryHtml(
  env: Env,
  gid: string,
  meta: GalleryMeta,
  viewOnly: boolean,
): Promise<Response> {
  const decisions = await loadDecisions(env, gid);
  const html = renderGalleryHtml(gid, meta, decisions, viewOnly);
  // Read-receipt tracking — photographer's own /view path doesn't bump.
  // Failure here must not block the model from getting the HTML.
  if (!viewOnly) {
    try {
      await recordView(env, gid);
    } catch {
      /* best-effort; the gallery page is more important than the counter */
    }
  }
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-robots-tag": "noindex",
      "cache-control": "no-store",
    },
  });
}

/// Record a view of <gid> in KV. Skips the write entirely when the last
/// recorded view was within `RATE_LIMIT_SECONDS` so a model who refreshes
/// or bounces between Photos/back-button doesn't burn through the
/// 1k-writes/day KV budget. The first-view timestamp is preserved across
/// updates; only `last_viewed_at` and `view_count` are bumped.
async function recordView(env: Env, gid: string): Promise<void> {
  const RATE_LIMIT_SECONDS = 60;
  const key = kvKeyForViewed(gid);
  const raw = await env.GALLERY_KV.get(key);
  const now = Date.now();
  let next: ViewedRecord;
  if (raw) {
    let cur: ViewedRecord | null = null;
    try {
      cur = JSON.parse(raw) as ViewedRecord;
    } catch {
      cur = null;
    }
    if (cur) {
      const lastTs = Date.parse(cur.last_viewed_at);
      if (!Number.isNaN(lastTs) && now - lastTs < RATE_LIMIT_SECONDS * 1000) {
        return; // recent enough — don't burn a KV write
      }
      next = {
        first_viewed_at: cur.first_viewed_at,
        last_viewed_at: new Date(now).toISOString(),
        view_count: (cur.view_count ?? 0) + 1,
      };
    } else {
      next = {
        first_viewed_at: new Date(now).toISOString(),
        last_viewed_at: new Date(now).toISOString(),
        view_count: 1,
      };
    }
  } else {
    next = {
      first_viewed_at: new Date(now).toISOString(),
      last_viewed_at: new Date(now).toISOString(),
      view_count: 1,
    };
  }
  await env.GALLERY_KV.put(key, JSON.stringify(next));
}

function zipStream(
  env: Env,
  gid: string,
  meta: GalleryMeta,
  pidsParam: string | null,
): Response {
  // Optional ?pids= filter — model selected a subset on the gallery page
  // and we ZIP only those. Photos are kept in their declared (newest-first)
  // order regardless of the order pids appear in the query.
  let photoSubset = meta.photos;
  if (pidsParam) {
    const requested = new Set(
      pidsParam.split(",").map((s) => s.trim()).filter(Boolean),
    );
    photoSubset = meta.photos.filter((p) => requested.has(p.pid));
  }
  const filenames = dedupeFilenames(photoSubset.map((p) => p.filename));
  const downloadName = `${sanitizeForDisposition(meta.name)}.zip`;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const writer = new ZipStreamWriter();
        for (let i = 0; i < photoSubset.length; i++) {
          const photo = photoSubset[i]!;
          const obj = await env.GALLERY_BUCKET.get(r2KeyForPhoto(gid, photo.pid));
          if (!obj) throw new Error(`photo ${photo.pid} missing in storage`);

          const crcHex = obj.customMetadata?.crc32;
          if (!crcHex) {
            throw new Error(`photo ${photo.pid} has no CRC; re-upload required`);
          }
          const crc = parseInt(crcHex, 16) >>> 0;
          const size = obj.size;

          await writer.writeFile(controller, filenames[i]!, crc, size, obj.body);
        }
        writer.finalize(controller);
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${downloadName}"`,
      "x-robots-tag": "noindex",
    },
  });
}

function sanitizeForDisposition(s: string): string {
  // Strip CR/LF and quotes; replace path separators. Anything else is fine
  // — Content-Disposition allows UTF-8 with the right encoding, and modern
  // browsers handle quoted ASCII-ish names well enough.
  const cleaned = s.replace(/[\r\n"\\\/]/g, "_").trim();
  return cleaned || "gallery";
}

async function loadMeta(env: Env, gid: string): Promise<GalleryMeta | null> {
  const raw = await env.GALLERY_KV.get(kvKeyForGallery(gid));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GalleryMeta;
  } catch {
    return null;
  }
}
