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

/** Browser session: after a successful Basic-auth login we set this cookie
 *  so subsequent /admin/* requests skip the auth dialog entirely. Scoped
 *  to /admin so it never rides along on public /<gid>/view requests, and
 *  marked HttpOnly+Secure+SameSite=Lax so it stays out of JS / cross-site
 *  contexts. Some browsers (Safari especially) don't reliably persist
 *  Basic-auth credentials, so without this every tab/restart re-prompts. */
const SESSION_COOKIE_NAME = "cullback_admin";
const SESSION_COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 days

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/" || path === "") {
      return text("cullback", 200);
    }

    const segs = path.split("/").filter(Boolean);

    if (segs[0] === "admin") {
      const method = authenticateAdmin(req, env);
      if (method === null) {
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
      const response = await handleAdmin(req, env, segs);
      // Promote a fresh Basic-auth login to a cookie session. Bearer
      // (desktop app) and cookie (returning browser) responses pass
      // through unchanged.
      if (method === "basic") return attachSessionCookie(response, env);
      return response;
    }

    return handlePublic(req, env, segs);
  },
} satisfies ExportedHandler<Env>;

type AuthMethod = "bearer" | "basic" | "cookie";

/// Accepts the desktop app's Bearer token, a browser-issued Basic-auth
/// credential whose password matches ADMIN_TOKEN, or a returning-browser
/// session cookie holding ADMIN_TOKEN. Returns which method succeeded so
/// the fetch handler can promote Basic logins to a cookie.
///
/// Basic-auth note: username is ignored. Browsers force the user to type
/// one even though only the password (=token) matters here.
function authenticateAdmin(req: Request, env: Env): AuthMethod | null {
  const provided = req.headers.get("Authorization") ?? "";
  if (provided === `Bearer ${env.ADMIN_TOKEN}`) return "bearer";
  if (provided.startsWith("Basic ")) {
    try {
      const decoded = atob(provided.slice("Basic ".length));
      const colon = decoded.indexOf(":");
      if (colon >= 0) {
        const pass = decoded.slice(colon + 1);
        if (pass === env.ADMIN_TOKEN) return "basic";
      }
    } catch {
      // fall through to cookie attempt
    }
  }
  if (readSessionCookie(req) === env.ADMIN_TOKEN) return "cookie";
  return null;
}

function readSessionCookie(req: Request): string | null {
  const raw = req.headers.get("Cookie") ?? "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key === SESSION_COOKIE_NAME) return part.slice(eq + 1).trim();
  }
  return null;
}

function attachSessionCookie(res: Response, env: Env): Response {
  // Cookie value is the literal token. HttpOnly keeps it out of JS, Secure
  // restricts to HTTPS (workers.dev / custom domains both qualify),
  // SameSite=Lax blocks cross-site sends. Scope to /admin so public photo
  // requests don't carry the cookie around for no reason.
  const cookie = [
    `${SESSION_COOKIE_NAME}=${env.ADMIN_TOKEN}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/admin",
    `Max-Age=${SESSION_COOKIE_MAX_AGE_SEC}`,
  ].join("; ");
  const headers = new Headers(res.headers);
  headers.append("Set-Cookie", cookie);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

export type { Env };
