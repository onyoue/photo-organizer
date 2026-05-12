import type { GalleryMeta } from "./types";

export interface AdminGalleryRow {
  gid: string;
  meta: GalleryMeta;
}

/** Renders the read-only admin index — a table of every published gallery
 *  with a link to each one's view-only page. Intentionally bare CSS / no
 *  JS so it stays understandable and we don't pay Worker CPU on render. */
export function renderAdminIndex(galleries: AdminGalleryRow[]): string {
  const rows = galleries
    .map((g) => renderRow(g))
    .join("\n");
  const empty = galleries.length === 0
    ? '<p class="empty">No galleries yet.</p>'
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Cullback admin · galleries</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root { color-scheme: light dark; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  margin: 0;
  padding: 24px;
  background: #fafafa;
  color: #1a1a1a;
}
@media (prefers-color-scheme: dark) {
  body { background: #1a1a1a; color: #e8e8e8; }
  th { background: #2a2a2a !important; }
  tr:nth-child(even) td { background: #222 !important; }
  a { color: #6da3ff; }
  .pill-finalized-no { background: #4a2a2a; color: #ffbcbc; }
  .pill-expired { background: #3a3a3a; color: #999; }
}
h1 {
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 16px;
}
.meta {
  color: #777;
  font-size: 12px;
  margin-bottom: 16px;
}
table {
  border-collapse: collapse;
  width: 100%;
  font-size: 13px;
}
th, td {
  text-align: left;
  padding: 6px 10px;
  border-bottom: 1px solid #ddd;
}
th {
  background: #efefef;
  font-weight: 600;
  position: sticky;
  top: 0;
}
tr:nth-child(even) td { background: #f4f4f4; }
.gid {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  color: #888;
}
.name { font-weight: 500; }
.right { text-align: right; font-variant-numeric: tabular-nums; }
a { color: #396cd8; text-decoration: none; }
a:hover { text-decoration: underline; }
.pill {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
}
.pill-finalized-no {
  background: #ffe5e5;
  color: #802222;
}
.pill-expired {
  background: #e5e5e5;
  color: #777;
}
.empty {
  color: #777;
  font-style: italic;
}
</style>
</head>
<body>
<h1>Cullback admin · galleries</h1>
<p class="meta">${galleries.length} galler${galleries.length === 1 ? "y" : "ies"} · newest first</p>
${empty}
${galleries.length === 0 ? "" : `<table>
<thead>
<tr>
  <th>Name</th>
  <th>GID</th>
  <th>Created</th>
  <th>Expires</th>
  <th class="right">Photos</th>
  <th>Status</th>
  <th></th>
</tr>
</thead>
<tbody>
${rows}
</tbody>
</table>`}
</body>
</html>`;
}

function renderRow({ gid, meta }: AdminGalleryRow): string {
  const expired = Date.parse(meta.expires_at) <= Date.now();
  const statusPills: string[] = [];
  if (!meta.finalized) {
    statusPills.push('<span class="pill pill-finalized-no">not finalized</span>');
  }
  if (expired) {
    statusPills.push('<span class="pill pill-expired">expired</span>');
  }
  const status = statusPills.join(" ");
  const viewHref = `/${gid}/view`;
  return `<tr>
  <td class="name">${escapeHtml(meta.name)}</td>
  <td class="gid">${escapeHtml(gid)}</td>
  <td>${formatDate(meta.created_at)}</td>
  <td>${formatDate(meta.expires_at)}</td>
  <td class="right">${meta.photos.length}</td>
  <td>${status}</td>
  <td><a href="${viewHref}" target="_blank" rel="noopener">閲覧専用 ↗</a></td>
</tr>`;
}

function formatDate(iso: string): string {
  // Show "YYYY-MM-DD HH:MM" in the viewer's local time. Use the browser
  // for that would be nice but we render server-side — fall back to UTC.
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}Z`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
