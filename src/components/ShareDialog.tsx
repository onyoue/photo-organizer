import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { BundleSummary } from "../types/bundle";
import type {
  Decision,
  ShareGalleryArgs,
  ShareGalleryResult,
  ShareProgressEvent,
} from "../types/gallery";
import { selectPreviewFile } from "../utils/preview";

interface Props {
  folder: string;
  selectedBundles: BundleSummary[];
  defaultName: string;
  defaultDecision: Decision;
  onClose: () => void;
}

interface ShareablePhoto {
  bundle_id: string;
  source_path: string;
  filename: string;
}

const EXPIRY_OPTIONS = [
  { days: 7, label: "7日" },
  { days: 14, label: "14日" },
  { days: 30, label: "30日" },
];

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

function resolveShareablePhotos(bundles: BundleSummary[]): {
  photos: ShareablePhoto[];
  excluded: BundleSummary[];
} {
  const photos: ShareablePhoto[] = [];
  const excluded: BundleSummary[] = [];
  for (const b of bundles) {
    const path = selectPreviewFile(b);
    if (!path) {
      excluded.push(b);
      continue;
    }
    photos.push({
      bundle_id: b.bundle_id,
      source_path: path,
      filename: basename(path),
    });
  }
  return { photos, excluded };
}

export function ShareDialog({
  folder,
  selectedBundles,
  defaultName,
  defaultDecision,
  onClose,
}: Props) {
  const [name, setName] = useState(defaultName);
  const [days, setDays] = useState<number>(7);
  const [decision, setDecision] = useState<Decision>(defaultDecision);
  const [progress, setProgress] = useState<ShareProgressEvent | null>(null);
  const [result, setResult] = useState<ShareGalleryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  const { photos, excluded } = useMemo(
    () => resolveShareablePhotos(selectedBundles),
    [selectedBundles],
  );

  useEffect(() => {
    return () => {
      if (unlistenRef.current) unlistenRef.current();
    };
  }, []);

  async function start() {
    if (busy) return;
    if (photos.length === 0) {
      setError("シェア可能な JPG/PNG が選択にありません");
      return;
    }
    if (!name.trim()) {
      setError("ギャラリー名を入力してください");
      return;
    }
    setError(null);
    setBusy(true);
    setProgress(null);
    setResult(null);
    setCopied(false);

    try {
      const unlisten = await listen<ShareProgressEvent>(
        "gallery-share-progress",
        (e) => setProgress(e.payload),
      );
      unlistenRef.current = unlisten;

      const args: ShareGalleryArgs = {
        folder,
        name: name.trim(),
        expires_in_days: days,
        default_decision: decision,
        photos: photos.map(({ bundle_id, source_path }) => ({
          bundle_id,
          source_path,
        })),
      };
      const out = await invoke<ShareGalleryResult>("share_gallery", { args });
      setResult(out);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
      setBusy(false);
    }
  }

  async function copyUrl() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select the URL so the user can copy manually.
      const el = document.getElementById("share-url-text");
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    }
  }

  return (
    <div className="settings-backdrop" onClick={busy ? undefined : onClose}>
      <div
        className="settings-dialog share-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Share gallery"
      >
        <div className="settings-header">
          <span className="settings-title">ギャラリー共有</span>
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            disabled={busy}
            title="Close"
          >
            ×
          </button>
        </div>

        <div className="settings-body">
          {!result ? (
            <>
              <div className="settings-field">
                <label>ギャラリー名</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy}
                  placeholder="例: 山田さん 2026-05-02"
                  className="share-name-input"
                />
              </div>

              <div className="settings-field">
                <label>有効期限</label>
                <div className="share-expiry">
                  {EXPIRY_OPTIONS.map((opt) => (
                    <label key={opt.days} className="share-radio">
                      <input
                        type="radio"
                        name="share-expires"
                        checked={days === opt.days}
                        onChange={() => setDays(opt.days)}
                        disabled={busy}
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
              </div>

              <div className="settings-field">
                <label>デフォルト判定</label>
                <p className="settings-hint">
                  モデルがタップしなかった写真をどう扱うか。OK
                  なら NG だけマークしてもらう運用、NG なら OK だけマークしてもらう運用。
                </p>
                <select
                  value={decision}
                  onChange={(e) => setDecision(e.target.value as Decision)}
                  disabled={busy}
                  className="share-decision-select"
                >
                  <option value="ok">OK（NGだけマーク）</option>
                  <option value="ng">NG（OKだけマーク）</option>
                </select>
              </div>

              <div className="settings-field">
                <label>対象写真</label>
                <p className="settings-hint">
                  {photos.length} 枚をアップロードします。
                  {excluded.length > 0 &&
                    ` （現像済みJPG/PNGがない ${excluded.length} 件は対象外）`}
                </p>
              </div>

              {progress && (
                <div className="share-progress">
                  <div
                    className="share-progress-bar"
                    style={{
                      width: `${(progress.current / progress.total) * 100}%`,
                    }}
                  />
                  <div className="share-progress-text">
                    {progress.current} / {progress.total} ·{" "}
                    {progress.filename}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="settings-field">
              <label>共有リンク</label>
              <p className="settings-hint">
                以下の URL をモデルに送ってください。期限後は自動で無効になります。
              </p>
              <div className="share-result">
                <code id="share-url-text" className="share-url">
                  {result.url}
                </code>
                <button
                  type="button"
                  onClick={copyUrl}
                  className="primary"
                >
                  {copied ? "コピー済み" : "コピー"}
                </button>
              </div>
              <p className="settings-hint share-result-hint">
                ギャラリー一覧から後で再アクセスできます。フィードバックの取り込みも一覧から実行します。
              </p>
            </div>
          )}
        </div>

        {error && <div className="settings-error">エラー: {error}</div>}

        <div className="settings-actions">
          {!result ? (
            <>
              <button type="button" onClick={onClose} disabled={busy}>
                キャンセル
              </button>
              <button
                type="button"
                className="primary"
                onClick={start}
                disabled={busy || photos.length === 0}
              >
                {busy ? "アップロード中…" : "シェア開始"}
              </button>
            </>
          ) : (
            <button type="button" className="primary" onClick={onClose}>
              閉じる
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
