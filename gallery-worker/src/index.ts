/**
 * Cullback gallery Worker
 *
 * Hosts time-limited photo galleries for client/model review.
 * Sister project to the Cullback desktop app; the desktop app uploads
 * developed JPGs here, models view/feedback on their phone, and the
 * desktop app pulls feedback back into bundle flags.
 *
 * Routes:
 *   GET    /                           liveness probe
 *
 *   --- admin (Bearer ADMIN_TOKEN, or Basic auth in a browser) -------
 *   GET    /admin/                     HTML index of every gallery
 *   PUT    /admin/<gid>                create gallery (JSON body)
 *   PUT    /admin/<gid>/photos/<pid>   upload photo bytes
 *   POST   /admin/<gid>/finalize       mark gallery viewable
 *   GET    /admin/<gid>/feedback       aggregated decisions
 *   GET    /admin/<gid>/views          read-receipt (first/last view + count)
 *   DELETE /admin/<gid>                delete gallery + photos
 *   GET    /admin/stats                R2 bytes + photo/gallery counts
 *   POST   /admin/stats/recompute      walk KV/R2 to rebuild the counter
 *
 *   --- public ------------------------------------------------------
 *   GET    /<gid>                      mobile gallery HTML (full)
 *   GET    /<gid>/view                 mobile gallery HTML (read-only)
 *   GET    /<gid>/manifest             gallery + photo list as JSON
 *   GET    /<gid>/p/<pid>              photo bytes (R2 proxy, expiry-checked)
 *   GET    /<gid>/zip                  ZIP stream of all photos
 *   POST   /<gid>/feedback             record a decision
 */

import { handleAdmin } from "./admin";
import { handlePublic } from "./public";
import type { Env } from "./types";
import { text } from "./util";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/" || path === "") {
      return text("cullback", 200);
    }

    const segs = path.split("/").filter(Boolean);

    if (segs[0] === "admin") {
      if (!isAdminAuthorized(req, env)) {
        // Send WWW-Authenticate so a browser landing on /admin/ shows the
        // native Basic-auth dialog. The desktop app keeps using Bearer
        // tokens and never sees this dialog — its 401 response stays an
        // ordinary "Unauthorized" body.
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "WWW-Authenticate": 'Basic realm="cullback-admin", charset="UTF-8"',
          },
        });
      }
      return handleAdmin(req, env, segs);
    }

    return handlePublic(req, env, segs);
  },
} satisfies ExportedHandler<Env>;

/// Accepts either the desktop app's Bearer token *or* a browser-issued
/// Basic-auth credential whose password matches ADMIN_TOKEN. Username on
/// the Basic side is ignored — browsers force the user to enter one even
/// though we only care about the token, so we just take whatever they
/// supply and validate the password half.
function isAdminAuthorized(req: Request, env: Env): boolean {
  const provided = req.headers.get("Authorization") ?? "";
  if (provided === `Bearer ${env.ADMIN_TOKEN}`) return true;
  if (provided.startsWith("Basic ")) {
    try {
      const decoded = atob(provided.slice("Basic ".length));
      const colon = decoded.indexOf(":");
      if (colon < 0) return false;
      const pass = decoded.slice(colon + 1);
      return pass === env.ADMIN_TOKEN;
    } catch {
      return false;
    }
  }
  return false;
}

export type { Env };
