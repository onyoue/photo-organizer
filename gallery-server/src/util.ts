export const GID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/; // ULID alphabet
export const PID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export function json(
  value: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

export function notFound(): Response {
  return text("Not Found", 404);
}

export function badRequest(msg: string): Response {
  return text(`Bad Request: ${msg}`, 400);
}

export function gone(): Response {
  return text("Gone", 410);
}

/** Parse JSON body with a size guard; returns null on malformed/empty. */
export async function readJson<T>(req: Request, maxBytes = 64 * 1024): Promise<T | null> {
  const len = req.headers.get("content-length");
  if (len && Number(len) > maxBytes) return null;
  try {
    const txt = await req.text();
    if (txt.length > maxBytes) return null;
    return JSON.parse(txt) as T;
  } catch {
    return null;
  }
}

/** True iff the gallery's expiry has passed. */
export function isExpired(expires_at: string, now = Date.now()): boolean {
  const t = Date.parse(expires_at);
  if (Number.isNaN(t)) return true;
  return t <= now;
}

export function r2KeyForPhoto(gid: string, pid: string): string {
  return `${gid}/p/${pid}`;
}

export function kvKeyForGallery(gid: string): string {
  return `gallery:${gid}`;
}

export function kvKeyForFeedback(gid: string, pid: string): string {
  return `feedback:${gid}:${pid}`;
}

export function kvPrefixForFeedback(gid: string): string {
  return `feedback:${gid}:`;
}

export const KV_KEY_STATS = "stats:totals";

/** Cloudflare R2 free-tier storage ceiling (10 GB). The Worker echoes this
 *  back in the stats response so the desktop UI doesn't hard-code it. */
export const R2_FREE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;
