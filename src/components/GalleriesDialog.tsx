import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { GalleryFeedbackEntry, GalleryRecord } from "../types/gallery";

interface Props {
  onClose: () => void;
  onApplyFeedback: (
    gid: string,
    entries: GalleryFeedbackEntry[],
  ) => Promise<ApplyResult>;
}

export interface ApplyResult {
  applied: number;
  /** Entries that did not match any bundle in the currently-loaded folder. */
  notInCurrentFolder: number;
  /** Entries skipped because the model agreed with the default. */
  agreedWithDefault: number;
}

function relativeExpiry(expires_at: string): string {
  const now = Date.now();
  const t = Date.parse(expires_at);
  if (Number.isNaN(t)) return "（期限不明）";
  const diff = t - now;
  if (diff <= 0) return "期限切れ";
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  if (days > 0) return `あと ${days} 日`;
  return `あと ${hours} 時間`;
}

export function GalleriesDialog({ onClose, onApplyFeedback }: Props) {
  const [galleries, setGalleries] = useState<GalleryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null); // gid being acted on
  const [error, setError] = useState<string | null>(null);
  const [statusByGid, setStatusByGid] = useState<Record<string, string>>({});

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const all = await invoke<GalleryRecord[]>("list_galleries");
      // Newest first.
      all.sort((a, b) => b.created_at.localeCompare(a.created_at));
      setGalleries(all);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      /* ignore */
    }
  }

  async function open(url: string) {
    try {
      await openUrl(url);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function fetchFeedback(g: GalleryRecord) {
    if (busy) return;
    setBusy(g.gid);
    setError(null);
    try {
      const entries = await invoke<GalleryFeedbackEntry[]>(
        "fetch_gallery_feedback",
        { gid: g.gid },
      );
      const result = await onApplyFeedback(g.gid, entries);
      const summary = formatApplySummary(result);
      setStatusByGid((prev) => ({ ...prev, [g.gid]: summary }));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function deleteGallery(g: GalleryRecord) {
    if (busy) return;
    const yes = await ask(
      `Delete gallery "${g.name}"?\n\n`
        + `Removes the link, all uploaded photos, and any model feedback. This cannot be undone.`,
      { title: "Delete gallery", kind: "warning" },
    );
    if (!yes) return;
    setBusy(g.gid);
    setError(null);
    try {
      await invoke("delete_gallery", { gid: g.gid });
      setGalleries((prev) => prev.filter((x) => x.gid !== g.gid));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div
        className="settings-dialog galleries-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Galleries"
      >
        <div className="settings-header">
          <span className="settings-title">共有ギャラリー</span>
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            title="Close"
          >
            ×
          </button>
        </div>

        <div className="settings-body galleries-body">
          {loading && <div className="settings-hint">読み込み中…</div>}
          {!loading && galleries.length === 0 && (
            <div className="settings-hint">
              まだ共有したギャラリーはありません。Detail パネルの「Share…」から作成できます。
            </div>
          )}
          {!loading && galleries.length > 0 && (
            <ul className="gallery-list">
              {galleries.map((g) => {
                const isBusy = busy === g.gid;
                const status = statusByGid[g.gid];
                return (
                  <li key={g.gid} className="gallery-item">
                    <div className="gallery-row-1">
                      <span className="gallery-name" title={g.name}>
                        {g.name}
                      </span>
                      <span className="gallery-expiry">
                        {relativeExpiry(g.expires_at)} · {g.photos.length} 枚
                        {g.default_decision === "ng" ? " · 既定NG" : ""}
                      </span>
                    </div>
                    <div className="gallery-row-2">
                      <code className="gallery-url" title={g.url}>
                        {g.url}
                      </code>
                    </div>
                    <div className="gallery-actions">
                      <button
                        type="button"
                        onClick={() => copy(g.url)}
                        disabled={isBusy}
                        title="Copy link"
                      >
                        コピー
                      </button>
                      <button
                        type="button"
                        onClick={() => open(g.url)}
                        disabled={isBusy}
                        title="Open in browser"
                      >
                        開く
                      </button>
                      <button
                        type="button"
                        onClick={() => fetchFeedback(g)}
                        disabled={isBusy}
                        title="Fetch feedback and apply to bundles in current folder"
                      >
                        フィードバック取り込み
                      </button>
                      <button
                        type="button"
                        className="gallery-delete"
                        onClick={() => deleteGallery(g)}
                        disabled={isBusy}
                        title="Delete gallery on the worker"
                      >
                        削除
                      </button>
                    </div>
                    {status && <div className="gallery-status">{status}</div>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {error && <div className="settings-error">エラー: {error}</div>}

        <div className="settings-actions">
          <button type="button" onClick={refresh} disabled={!!busy}>
            更新
          </button>
          <button type="button" className="primary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

function formatApplySummary(r: ApplyResult): string {
  const parts: string[] = [];
  parts.push(`${r.applied} 件にフラグ反映`);
  if (r.agreedWithDefault > 0) {
    parts.push(`${r.agreedWithDefault} 件は既定どおりでスキップ`);
  }
  if (r.notInCurrentFolder > 0) {
    parts.push(`${r.notInCurrentFolder} 件は現在のフォルダに無いためスキップ`);
  }
  return parts.join(" / ");
}
