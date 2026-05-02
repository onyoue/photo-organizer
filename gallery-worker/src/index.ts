/**
 * photo-gallery Worker
 *
 * Hosts time-limited photo galleries for client/model review.
 * Sister project to the desktop photo-organizer; the desktop app uploads
 * developed JPGs here, models view/feedback on their phone, and the
 * desktop app pulls feedback back into bundle flags.
 *
 * Routes:
 *   GET    /                           liveness probe
 *
 *   --- admin (Bearer ADMIN_TOKEN) ----------------------------------
 *   POST   /admin/gallery              create gallery from JSON body
 *   PUT    /admin/<gid>/photos/<pid>   upload photo (body=bytes, X-Filename header)
 *   POST   /admin/<gid>/finalize       mark gallery ready for viewing
 *   GET    /admin/<gid>/feedback       aggregated per-photo decisions
 *   DELETE /admin/<gid>                delete gallery + all photos
 *
 *   --- public ------------------------------------------------------
 *   GET    /<gid>                      mobile gallery HTML
 *   GET    /<gid>/manifest             gallery + photo list as JSON
 *   GET    /<gid>/p/<pid>              photo bytes (R2 proxy, expiry-checked)
 *   GET    /<gid>/zip                  ZIP stream of all photos
 *   POST   /<gid>/feedback             record a decision (per-tap)
 */

export interface Env {
  GALLERY_BUCKET: R2Bucket;
  GALLERY_KV: KVNamespace;
  ADMIN_TOKEN: string;
}

const GID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/; // ULID alphabet

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/" || path === "") {
      return text("photo-gallery", 200);
    }

    if (path.startsWith("/admin/")) {
      const provided = req.headers.get("Authorization");
      if (provided !== `Bearer ${env.ADMIN_TOKEN}`) {
        return text("Unauthorized", 401);
      }
      return handleAdmin(req, env, path);
    }

    return handlePublic(req, env, path);
  },
} satisfies ExportedHandler<Env>;

// ---------- admin -----------------------------------------------------------

async function handleAdmin(req: Request, _env: Env, path: string): Promise<Response> {
  // TODO: dispatch to per-route handlers
  // POST   /admin/gallery
  // PUT    /admin/<gid>/photos/<pid>
  // POST   /admin/<gid>/finalize
  // GET    /admin/<gid>/feedback
  // DELETE /admin/<gid>
  void req;
  void path;
  return text("admin not implemented", 501);
}

// ---------- public ----------------------------------------------------------

async function handlePublic(req: Request, _env: Env, path: string): Promise<Response> {
  const segs = path.split("/").filter(Boolean);
  if (segs.length === 0) return text("Not Found", 404);

  const gid = segs[0];
  if (!GID_RE.test(gid)) return text("Not Found", 404);

  // TODO: dispatch to per-route handlers
  // GET  /<gid>
  // GET  /<gid>/manifest
  // GET  /<gid>/p/<pid>
  // GET  /<gid>/zip
  // POST /<gid>/feedback
  void req;
  return text("public not implemented", 501);
}

// ---------- helpers ---------------------------------------------------------

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
