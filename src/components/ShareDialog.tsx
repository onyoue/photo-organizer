import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { BundleSummary } from "../types/bundle";
import type {
  Decision,
  GalleryStats,
  ShareGalleryArgs,
  ShareGalleryResult,
  ShareProgressEvent,
} from "../types/gallery";
import { formatSize } from "../utils/format";
import { previewVariants } from "../utils/preview";

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
  // 0 is the backend's sentinel for "no expiry" — resolved to a far-future
  // expires_at server-side so the Worker still has a real timestamp.
  { days: 0, label: "期限なし" },
];

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

function resolveShareablePhotos(bundles: BundleSummary[]): {
  photos: ShareablePhoto[];
  excluded: BundleSummary[];
  plannedBytes: number;
} {
  const photos: ShareablePhoto[] = [];
  const excluded: BundleSummary[] = [];
  let plannedBytes = 0;
  for (const b of bundles) {
    const variants = previewVariants(b);
    if (variants.length === 0) {
      excluded.push(b);
      continue;
    }
    // Send every renderable JPG/PNG variant — model can compare colour
    // grades and per-variant feedback comes back so the apply step can
    // pick the right action (any FAV → pick, all-NG → reject, mixed
    // → no change). previewVariants is already ordered newest-first.
    for (const v of variants) {
      photos.push({
        bundle_id: b.bundle_id,
        source_path: v.path,
        filename: basename(v.path),
      });
      plannedBytes += v.size;
    }
  }
  return { photos, excluded, plannedBytes };
}

export function ShareDialog({
  folder,
  selectedBundles,
  defaultName,
  defaultDecision,
  onClose,
}: Props) {
  const [name, setName] = useState(defaultName);
  const [modelName, setModelName] = useState("");
  const [days, setDays] = useState<number>(7);
  const [decision, setDecision] = useState<Decision>(defaultDecision);
  const [progress, setProgress] = useState<ShareProgressEvent | null>(null);
  const [result, setResult] = useState<ShareGalleryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  const { photos, excluded, plannedBytes } = useMemo(
    () => resolveShareablePhotos(selectedBundles),
    [selectedBundles],
  );

  const [stats, setStats] = useState<GalleryStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [statsBusy, setStatsBusy] = useState(false);

  const refreshStats = useCallback(async (mode: "fetch" | "recompute") => {
    setStatsBusy(true);
    setStatsError(null);
    try {
      const cmd = mode === "recompute" ? "recompute_gallery_stats" : "get_gallery_stats";
      const out = await invoke<GalleryStats>(cmd);
      setStats(out);
    } catch (e: unknown) {
      setStatsError(e instanceof Error ? e.message : String(e));
    } finally {
      setStatsBusy(false);
    }
  }, []);

  useEffect(() => {
    void refreshStats("fetch");
  }, [refreshStats]);

  // Refresh after a successful upload — the Worker has bumped its counter
  // by exactly plannedBytes, but pulling the authoritative value avoids
  // any drift from concurrent operations.
  useEffect(() => {
    if (result) void refreshStats("fetch");
  }, [result, refreshStats]);

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

      const trimmedModel = modelName.trim();
      const args: ShareGalleryArgs = {
        folder,
        name: name.trim(),
        expires_in_days: days,
        default_decision: decision,
        ...(trimmedModel ? { model_name: trimmedModel } : {}),
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
          <StatsBanner
            stats={stats}
            plannedBytes={!result ? plannedBytes : 0}
            busy={statsBusy}
            error={statsError}
            onRefresh={() => void refreshStats("fetch")}
            onRecompute={() => void refreshStats("recompute")}
          />
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
                <label>モデル名（任意）</label>
                <p className="settings-hint">
                  入力するとフィードバックがこのモデル名で仕分けされます。ペア撮影で別々に送るときなどに。空欄なら従来どおり単一フラグとして取り込み。
                </p>
                <input
                  type="text"
                  value={modelName}
                  onChange={(e) => setModelName(e.target.value)}
                  disabled={busy}
                  placeholder="例: alice / 山田 / 二人組"
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
                  {selectedBundles.length - excluded.length} バンドル ×
                  バリエーション = {photos.length} 枚をアップロードします。
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

interface StatsBannerProps {
  stats: GalleryStats | null;
  /** Bytes about to be uploaded (0 once result exists). */
  plannedBytes: number;
  busy: boolean;
  error: string | null;
  onRefresh: () => void;
  onRecompute: () => void;
}

function StatsBanner({
  stats,
  plannedBytes,
  busy,
  error,
  onRefresh,
  onRecompute,
}: StatsBannerProps) {
  if (error) {
    return (
      <div className="share-stats share-stats-error">
        <span>無料枠の取得に失敗: {error}</span>
        <button type="button" onClick={onRefresh} disabled={busy} title="再取得">
          ↻
        </button>
      </div>
    );
  }
  if (!stats) {
    return (
      <div className="share-stats share-stats-loading">
        <span>無料枠の使用状況を読み込み中…</span>
      </div>
    );
  }

  const limit = stats.r2_bytes_limit || 1;
  const projected = stats.r2_bytes + plannedBytes;
  const usedPct = Math.min(100, Math.round((stats.r2_bytes / limit) * 100));
  const projectedPct = Math.min(100, Math.round((projected / limit) * 100));
  const overage = projected > limit;
  const tone = overage
    ? "share-stats-danger"
    : projectedPct >= 80
      ? "share-stats-warn"
      : "";

  return (
    <div className={`share-stats ${tone}`.trim()}>
      <div className="share-stats-row">
        <span className="share-stats-label">R2 ストレージ</span>
        <span className="share-stats-value">
          {formatSize(stats.r2_bytes)} / {formatSize(stats.r2_bytes_limit)}
          {plannedBytes > 0 && (
            <>
              {" "}
              <span className="share-stats-projection">
                → {formatSize(projected)} ({projectedPct}%)
              </span>
            </>
          )}
        </span>
      </div>
      <div className="share-stats-bar">
        <div
          className="share-stats-bar-used"
          style={{ width: `${usedPct}%` }}
        />
        {plannedBytes > 0 && (
          <div
            className="share-stats-bar-add"
            style={{
              left: `${usedPct}%`,
              width: `${Math.max(0, projectedPct - usedPct)}%`,
            }}
          />
        )}
      </div>
      <div className="share-stats-row share-stats-meta">
        <span>
          写真 {stats.photo_count} 枚 · ギャラリー {stats.gallery_count} 件
        </span>
        <span className="share-stats-actions">
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            title="再取得"
          >
            ↻
          </button>
          <button
            type="button"
            onClick={onRecompute}
            disabled={busy}
            title="Worker側で全件スキャンして再計算（数値がずれた場合に）"
          >
            再計算
          </button>
        </span>
      </div>
      {overage && (
        <div className="share-stats-overage">
          ⚠ アップロード後に無料枠（10 GB）を超過します
        </div>
      )}
    </div>
  );
}
