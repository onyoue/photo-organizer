import { useCallback, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ulid } from "ulid";
import type {
  Platform,
  PostBy,
  PostRecord,
  BundleSidecar,
} from "../types/sidecar";
import { PLATFORM_LABELS, POST_BY_LABELS } from "../types/sidecar";
import type { SearchHit, SearchResults } from "../types/search";
import { normalizeUrl } from "../utils/url";

interface Props {
  initialRoot: string | null;
  onClose: () => void;
  /** Called when the user picks a new search root they want persisted. */
  onRootSelected: (root: string) => Promise<void>;
}

const RENDERABLE = /\.(jpe?g|png|webp|gif)$/i;
const MAX_RESULTS = 20;
// Always pull the top-N by ascending distance and let the user judge —
// SNS-side cropping (especially Instagram's center 1:1) commonly pushes
// real matches into the 20-40 range where a strict cutoff would silently
// drop them. The UI labels each row by distance band so weak matches are
// obvious without being filtered out.
const MAX_DISTANCE = 64;

function distanceLabel(d: number): { text: string; tone: "strong" | "ok" | "weak" } {
  if (d <= 8) return { text: "ほぼ確実", tone: "strong" };
  if (d <= 16) return { text: "強い一致", tone: "strong" };
  if (d <= 24) return { text: "一致の可能性", tone: "ok" };
  if (d <= 32) return { text: "弱い一致", tone: "ok" };
  return { text: "参考", tone: "weak" };
}

export function SearchDialog({ initialRoot, onClose, onRootSelected }: Props) {
  const [root, setRoot] = useState<string | null>(initialRoot);
  const [queryImage, setQueryImage] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [busy, setBusy] = useState<"searching" | "saving" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Inline form state for "投稿追加" against a specific hit.
  const [addingFor, setAddingFor] = useState<SearchHit | null>(null);
  const [statusByBundle, setStatusByBundle] = useState<Record<string, string>>(
    {},
  );

  const pickRoot = useCallback(async () => {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "検索ルートを選択（サブフォルダ全体を再帰検索します）",
    });
    if (typeof picked !== "string") return;
    setRoot(picked);
    await onRootSelected(picked);
  }, [onRootSelected]);

  const pickImage = useCallback(async () => {
    const picked = await openDialog({
      directory: false,
      multiple: false,
      title: "SNSの画像を選択",
      filters: [
        { name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif"] },
      ],
    });
    if (typeof picked !== "string") return;
    setQueryImage(picked);
  }, []);

  const runSearch = useCallback(async () => {
    if (!root) {
      setError("検索ルートを指定してください");
      return;
    }
    if (!queryImage) {
      setError("検索する画像を指定してください");
      return;
    }
    setError(null);
    setBusy("searching");
    setResults(null);
    setStatusByBundle({});
    try {
      const target = await invoke<string>("compute_phash_for_image", {
        path: queryImage,
      });
      const out = await invoke<SearchResults>("search_image_across_folders", {
        root,
        targetPhash: target,
        maxResults: MAX_RESULTS,
        maxDistance: MAX_DISTANCE,
      });
      setResults(out);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [root, queryImage]);

  const addPost = useCallback(
    async (hit: SearchHit, post: Omit<PostRecord, "id">) => {
      setBusy("saving");
      setError(null);
      try {
        // Read the existing sidecar (or build a fresh one) for that bundle's
        // folder, append the new post, save back. Cross-folder write —
        // the bundle doesn't need to be in the currently-open index.
        const existing = await invoke<BundleSidecar | null>(
          "get_bundle_sidecar",
          { folder: hit.folder_path, baseName: hit.base_name },
        );
        const sidecar: BundleSidecar = existing ?? {
          version: 1,
          bundle_id: hit.bundle_id,
          base_name: hit.base_name,
          tags: [],
          posts: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        sidecar.posts = [
          ...(sidecar.posts ?? []),
          { id: ulid(), ...post },
        ];
        sidecar.updated_at = new Date().toISOString();
        await invoke("save_bundle_sidecar", {
          folder: hit.folder_path,
          sidecar,
        });
        setStatusByBundle((prev) => ({
          ...prev,
          [hit.bundle_id]: `✓ ${PLATFORM_LABELS[post.platform]} 投稿を追加`,
        }));
        setAddingFor(null);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const folderShort = (path: string) => {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts.slice(-2).join(" / ") || path;
  };

  const ready = !!root && !!queryImage && busy !== "searching";

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div
        className="settings-dialog search-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Image search"
      >
        <div className="settings-header">
          <span className="settings-title">画像から逆引き</span>
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            title="Close"
          >
            ×
          </button>
        </div>

        <div className="settings-body">
          <p className="settings-hint">
            SNS にあげた画像を渡すと、検索ルート以下の全フォルダから類似バンドルを
            上位 {MAX_RESULTS} 件返します。各フォルダの
            <code> .photoorg/index.json </code>
            に事前計算された pHash が見つからないバンドルは結果に出ません
            （Re-scan が必要）。
          </p>

          <div className="settings-field">
            <label>検索ルート</label>
            <div className="search-root">
              <code className="search-root-path">
                {root ?? "（未設定）"}
              </code>
              <button
                type="button"
                onClick={() => void pickRoot()}
                disabled={!!busy}
              >
                {root ? "変更" : "選択"}
              </button>
            </div>
          </div>

          <div className="settings-field">
            <label>検索する画像</label>
            <div className="search-root">
              <code className="search-root-path">
                {queryImage ?? "（未選択）"}
              </code>
              <button
                type="button"
                onClick={() => void pickImage()}
                disabled={!!busy}
              >
                {queryImage ? "変更" : "選択"}
              </button>
            </div>
            {queryImage && RENDERABLE.test(queryImage) && (
              <img
                src={convertFileSrc(queryImage)}
                alt="検索画像"
                className="search-query-preview"
              />
            )}
          </div>

          <div className="search-actions">
            <button
              type="button"
              className="primary"
              onClick={() => void runSearch()}
              disabled={!ready}
            >
              {busy === "searching" ? "検索中…" : "検索"}
            </button>
          </div>

          {results && (
            <div className="search-results">
              <div className="search-results-summary">
                {results.hits.length} 件ヒット ·{" "}
                {results.folders_scanned} フォルダ走査（うち
                {results.folders_with_phash} に pHash 済み）·{" "}
                {results.bundles_total} バンドル中
                {results.folders_scanned > results.folders_with_phash && (
                  <>
                    {" "}
                    <span className="search-warn">
                      ⚠ {results.folders_scanned - results.folders_with_phash}
                       フォルダは Re-scan が必要
                    </span>
                  </>
                )}
              </div>
              {results.hits.length === 0 && (
                <div className="search-empty">
                  マッチがありません。検索ルート以下のフォルダがすべて pHash 未計算
                  かもしれません — 検索したい撮影会フォルダを開いて Re-scan してください。
                </div>
              )}
              <ul className="search-hit-list">
                {results.hits.map((h) => {
                  const renderable =
                    h.thumbnail_source && RENDERABLE.test(h.thumbnail_source);
                  const status = statusByBundle[h.bundle_id];
                  return (
                    <li key={h.bundle_id} className="search-hit">
                      <div className="search-hit-main">
                        <div className="search-hit-thumb">
                          {renderable && h.thumbnail_source ? (
                            <img
                              src={convertFileSrc(h.thumbnail_source)}
                              alt={h.base_name}
                              loading="lazy"
                            />
                          ) : (
                            <div className="search-hit-thumb-placeholder">
                              {h.base_name.slice(0, 3)}
                            </div>
                          )}
                        </div>
                        <div className="search-hit-info">
                          <div className="search-hit-name" title={h.base_name}>
                            {h.base_name}
                          </div>
                          <div className="search-hit-folder" title={h.folder_path}>
                            {folderShort(h.folder_path)}
                          </div>
                          <div className="search-hit-distance">
                            {(() => {
                              const lbl = distanceLabel(h.distance);
                              return (
                                <>
                                  <span className={`search-distance-tag tone-${lbl.tone}`}>
                                    {lbl.text}
                                  </span>{" "}
                                  <span className="search-distance-num">
                                    距離 {h.distance}
                                  </span>
                                </>
                              );
                            })()}
                          </div>
                        </div>
                        <div className="search-hit-actions">
                          {status ? (
                            <span className="search-hit-status">{status}</span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setAddingFor(h)}
                              disabled={!!busy}
                            >
                              投稿を追加
                            </button>
                          )}
                        </div>
                      </div>
                      {addingFor?.bundle_id === h.bundle_id && (
                        <PostForm
                          onSave={(p) => void addPost(h, p)}
                          onCancel={() => setAddingFor(null)}
                          busy={busy === "saving"}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>

        {error && <div className="settings-error">エラー: {error}</div>}

        <div className="settings-actions">
          <button type="button" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

interface FormProps {
  onSave: (post: Omit<PostRecord, "id">) => void;
  onCancel: () => void;
  busy: boolean;
}

function PostForm({ onSave, onCancel, busy }: FormProps) {
  const [platform, setPlatform] = useState<Platform>("x");
  const [url, setUrl] = useState("");
  const [by, setBy] = useState<PostBy>("model");
  const [handle, setHandle] = useState("");
  const trimmedUrl = url.trim();
  const valid = trimmedUrl.length > 0;

  function submit() {
    if (!valid) return;
    onSave({
      platform,
      url: normalizeUrl(trimmedUrl),
      by,
      posted_by_handle: by === "model" && handle.trim() ? handle.trim() : undefined,
    });
  }

  return (
    <form
      className="search-hit-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="post-form-row">
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value as Platform)}
          disabled={busy}
        >
          <option value="x">X</option>
          <option value="instagram">Instagram</option>
          <option value="note">note</option>
          <option value="other">Other</option>
        </select>
        <input
          type="url"
          placeholder="https://…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          autoFocus
          disabled={busy}
        />
      </div>
      <div className="post-form-row post-by-row">
        {(Object.keys(POST_BY_LABELS) as PostBy[]).map((b) => (
          <label key={b} className="post-by-radio">
            <input
              type="radio"
              checked={by === b}
              onChange={() => setBy(b)}
              disabled={busy}
            />
            {POST_BY_LABELS[b]}
          </label>
        ))}
      </div>
      {by === "model" && (
        <div className="post-form-row">
          <input
            type="text"
            placeholder="@handle (optional)"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            disabled={busy}
          />
        </div>
      )}
      <div className="post-form-actions">
        <button type="submit" disabled={!valid || busy}>
          保存
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          キャンセル
        </button>
      </div>
    </form>
  );
}
