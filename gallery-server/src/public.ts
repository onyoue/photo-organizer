/**
 * Public endpoints — no auth, gid-only addressing. Mirrors the Worker's
 * public.ts; storage swaps to filesystem.
 */

import type { Decision, DefaultDecision, GalleryMeta } from "./types";
import {
  GID_RE,
  PID_RE,
  badRequest,
  gone,
  isExpired,
  json,
  notFound,
  readJson,
} from "./util";
import { ZipStreamWriter, dedupeFilenames } from "./zip";
import { renderGalleryHtml } from "./html";
import {
  clearFeedback,
  getAllFeedback,
  getGalleryMeta,
  headPhoto,
  openPhotoStream,
  setFeedback,
  type ServerEnv,
} from "./storage";

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
  env: ServerEnv,
  segs: string[],
): Promise<Response> {
  if (segs.length === 0) return notFound();
  const gid = segs[0];
  if (!GID_RE.test(gid)) return notFound();

  const meta = await getGalleryMeta(env, gid);
  if (!meta || !meta.finalized) return notFound();
  if (isExpired(meta.expires_at)) return gone();

  const action = segs[1];

  if (!action && req.method === "GET") return galleryHtml(env, gid, meta, false);
  if (action === "view" && req.method === "GET") return galleryHtml(env, gid, meta, true);

  if (action === "manifest" && req.method === "GET") {
    return json(await buildManifest(env, gid, meta), 200, { "cache-control": "no-store" });
  }
  if (action === "p" && segs[2] && req.method === "GET") {
    return photoProxy(env, gid, segs[2], meta);
  }
  if (action === "feedback" && req.method === "POST") {
    return setFeedbackResp(req, env, gid, meta);
  }
  if (action === "zip" && req.method === "GET") {
    const url = new URL(req.url);
    return zipStream(env, gid, meta, url.searchParams.get("pids"));
  }
  return notFound();
}

async function buildManifest(
  env: ServerEnv,
  gid: string,
  meta: GalleryMeta,
): Promise<PublicManifest> {
  return {
    name: meta.name,
    expires_at: meta.expires_at,
    default_decision: meta.default_decision,
    photos: meta.photos.map((p) => ({ pid: p.pid, filename: p.filename })),
    decisions: await getAllFeedback(env, gid),
  };
}

async function photoProxy(
  env: ServerEnv,
  gid: string,
  pid: string,
  meta: GalleryMeta,
): Promise<Response> {
  if (!PID_RE.test(pid)) return notFound();
  if (!meta.photos.some((p) => p.pid === pid)) return notFound();
  const head = await headPhoto(env, gid, pid);
  if (!head) return notFound();
  const { stream, contentType } = openPhotoStream(env, gid, pid);
  const headers = new Headers();
  headers.set("content-type", contentType || head.contentType);
  headers.set("content-length", String(head.size));
  headers.set("cache-control", "private, max-age=3600");
  headers.set("x-robots-tag", "noindex");
  return new Response(stream, { headers });
}

async function setFeedbackResp(
  req: Request,
  env: ServerEnv,
  gid: string,
  meta: GalleryMeta,
): Promise<Response> {
  const body = await readJson<FeedbackBody>(req, 1024);
  if (!body) return badRequest("invalid JSON body");
  if (typeof body.pid !== "string" || !PID_RE.test(body.pid)) return badRequest("invalid pid");
  if (!meta.photos.some((p) => p.pid === body.pid)) return badRequest("unknown pid");
  if (
    body.decision !== "ok" &&
    body.decision !== "ng" &&
    body.decision !== "fav" &&
    body.decision !== "clear"
  ) {
    return badRequest("decision must be ok, ng, fav, or clear");
  }
  if (body.decision === "clear") {
    await clearFeedback(env, gid, body.pid);
  } else {
    await setFeedback(env, gid, body.pid, body.decision);
  }
  return json({ pid: body.pid, decision: body.decision });
}

async function galleryHtml(
  env: ServerEnv,
  gid: string,
  meta: GalleryMeta,
  viewOnly: boolean,
): Promise<Response> {
  const decisions = await getAllFeedback(env, gid);
  const html = renderGalleryHtml(gid, meta, decisions, viewOnly);
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-robots-tag": "noindex",
      "cache-control": "no-store",
    },
  });
}

function zipStream(
  env: ServerEnv,
  gid: string,
  meta: GalleryMeta,
  pidsParam: string | null,
): Response {
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
          const head = await headPhoto(env, gid, photo.pid);
          if (!head) throw new Error(`photo ${photo.pid} missing in storage`);
          if (!head.crc32) {
            throw new Error(`photo ${photo.pid} has no CRC; re-upload required`);
          }
          const crc = parseInt(head.crc32, 16) >>> 0;
          const { stream: body } = openPhotoStream(env, gid, photo.pid);
          await writer.writeFile(controller, filenames[i]!, crc, head.size, body);
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
  const cleaned = s.replace(/[\r\n"\\\/]/g, "_").trim();
  return cleaned || "gallery";
}
