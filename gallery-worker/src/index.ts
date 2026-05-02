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
 *   PUT    /admin/<gid>                create gallery (JSON body)
 *   PUT    /admin/<gid>/photos/<pid>   upload photo bytes
 *   POST   /admin/<gid>/finalize       mark gallery viewable
 *   GET    /admin/<gid>/feedback       aggregated decisions
 *   DELETE /admin/<gid>                delete gallery + photos
 *
 *   --- public ------------------------------------------------------
 *   GET    /<gid>                      mobile gallery HTML
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
      return text("photo-gallery", 200);
    }

    const segs = path.split("/").filter(Boolean);

    if (segs[0] === "admin") {
      const provided = req.headers.get("Authorization");
      if (provided !== `Bearer ${env.ADMIN_TOKEN}`) {
        return text("Unauthorized", 401);
      }
      return handleAdmin(req, env, segs);
    }

    return handlePublic(req, env, segs);
  },
} satisfies ExportedHandler<Env>;

export type { Env };
