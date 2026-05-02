import type { Decision, Env, GalleryMeta } from "./types";
import {
  GID_RE,
  PID_RE,
  badRequest,
  gone,
  isExpired,
  json,
  kvKeyForFeedback,
  kvKeyForGallery,
  kvPrefixForFeedback,
  notFound,
  r2KeyForPhoto,
  readJson,
} from "./util";
import { ZipStreamWriter, dedupeFilenames } from "./zip";

interface PublicPhoto {
  pid: string;
  filename: string;
}

interface PublicManifest {
  name: string;
  expires_at: string;
  default_decision: Decision;
  photos: PublicPhoto[];
  decisions: Record<string, Decision>;
}

interface FeedbackBody {
  pid: string;
  decision: "ok" | "ng" | "clear";
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

  if (!action && req.method === "GET") return galleryHtml(gid, meta);

  if (action === "manifest" && req.method === "GET") {
    return json(await buildManifest(env, gid, meta), 200, {
      "cache-control": "no-store",
    });
  }

  if (action === "p" && segs[2] && req.method === "GET") {
    return photoProxy(env, gid, segs[2], meta);
  }

  if (action === "feedback" && req.method === "POST") {
    return setFeedback(req, env, gid, meta);
  }

  if (action === "zip" && req.method === "GET") {
    return zipStream(env, gid, meta);
  }

  return notFound();
}

async function buildManifest(
  env: Env,
  gid: string,
  meta: GalleryMeta,
): Promise<PublicManifest> {
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
      if (v === "ok" || v === "ng") decisions[pid] = v;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return {
    name: meta.name,
    expires_at: meta.expires_at,
    default_decision: meta.default_decision,
    photos: meta.photos.map((p) => ({ pid: p.pid, filename: p.filename })),
    decisions,
  };
}

async function photoProxy(
  env: Env,
  gid: string,
  pid: string,
  meta: GalleryMeta,
): Promise<Response> {
  if (!PID_RE.test(pid)) return notFound();
  if (!meta.photos.some((p) => p.pid === pid)) return notFound();

  const obj = await env.GALLERY_BUCKET.get(r2KeyForPhoto(gid, pid));
  if (!obj) return notFound();

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", "private, max-age=3600");
  headers.set("x-robots-tag", "noindex");

  return new Response(obj.body, { headers });
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
  if (body.decision !== "ok" && body.decision !== "ng" && body.decision !== "clear") {
    return badRequest("decision must be ok, ng, or clear");
  }

  const key = kvKeyForFeedback(gid, body.pid);
  if (body.decision === "clear") {
    await env.GALLERY_KV.delete(key);
  } else {
    await env.GALLERY_KV.put(key, body.decision);
  }
  return json({ pid: body.pid, decision: body.decision });
}

function galleryHtml(_gid: string, meta: GalleryMeta): Response {
  // TODO: full mobile UI in a follow-up commit.
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(meta.name)}</title>` +
      `<p>Gallery viewer not yet implemented. ${meta.photos.length} photos.</p>`,
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-robots-tag": "noindex",
      },
    },
  );
}

function zipStream(env: Env, gid: string, meta: GalleryMeta): Response {
  const filenames = dedupeFilenames(meta.photos.map((p) => p.filename));
  const downloadName = `${sanitizeForDisposition(meta.name)}.zip`;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const writer = new ZipStreamWriter();
        for (let i = 0; i < meta.photos.length; i++) {
          const photo = meta.photos[i]!;
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&#39;",
  );
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
