import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { BundleSummary, FolderIndex } from "./types/bundle";
import type { ThumbMap, ThumbnailReadyEvent, ThumbnailRequest } from "./types/thumb";
import type { PixelOffset, PreviewMode } from "./types/preview";
import type { BundleSidecar, PostRecord } from "./types/sidecar";
import { generatePostId } from "./components/PostsSection";
import { ThumbnailGrid } from "./components/ThumbnailGrid";
import { PreviewPane } from "./components/PreviewPane";
import { DetailPanel } from "./components/DetailPanel";
import { joinPath } from "./utils/path";
import { rangeIds } from "./utils/selection";
import "./App.css";

const TILE_SIZES = { S: 128, M: 200, L: 320 } as const;
type TileLabel = keyof typeof TILE_SIZES;

function previewFile(b: BundleSummary): string | null {
  return b.files.find((f) => f.role === "jpeg")?.path ?? null;
}

function App() {
  const [index, setIndex] = useState<FolderIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [thumbs, setThumbs] = useState<ThumbMap>({});

  // Selection model:
  //   activeId  – primary focus, drives the preview pane and is the anchor for arrow keys.
  //   selectedIds – every bundle that batch ops apply to. Always includes activeId when set.
  //   anchorId  – the start of a Shift-extended range; pinned by plain/Ctrl click.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);

  const [tileLabel, setTileLabel] = useState<TileLabel>("M");
  const [previewMode, setPreviewMode] = useState<PreviewMode>("fit");
  const [focusMode, setFocusMode] = useState(false);
  const [pixelOffset, setPixelOffset] = useState<PixelOffset>({ dx: 0, dy: 0 });

  const [activeSidecar, setActiveSidecar] = useState<BundleSidecar | null>(null);
  const [sidecarLoading, setSidecarLoading] = useState(false);
  const [addingPost, setAddingPost] = useState(false);

  function resetSelection() {
    setActiveId(null);
    setSelectedIds(new Set());
    setAnchorId(null);
  }

  function selectSingle(id: string) {
    setActiveId(id);
    setSelectedIds(new Set([id]));
    setAnchorId(id);
  }

  async function pickAndOpenFolder() {
    setError(null);
    setThumbs({});
    resetSelection();
    setPixelOffset({ dx: 0, dy: 0 });
    try {
      const selected = await open({ directory: true, multiple: false });
      if (!selected || typeof selected !== "string") return;
      setLoading(true);
      const result = await invoke<FolderIndex>("open_folder", { path: selected });
      setIndex(result);
    } catch (e: unknown) {
      setError(toMessage(e));
    } finally {
      setLoading(false);
    }
  }

  async function rescanCurrent() {
    if (!index || loading) return;
    setError(null);
    setLoading(true);
    try {
      const result = await invoke<FolderIndex>("open_folder", {
        path: index.folder_path,
        force: true,
      });
      setIndex(result);
    } catch (e: unknown) {
      setError(toMessage(e));
    } finally {
      setLoading(false);
    }
  }

  // Prune any selection / anchor that points at bundles no longer in the index
  // (e.g. after a Re-scan that picked up filesystem deletions made externally).
  useEffect(() => {
    if (!index) return;
    const ids = new Set(index.bundles.map((b) => b.bundle_id));
    setSelectedIds((prev) => {
      const filtered = new Set([...prev].filter((id) => ids.has(id)));
      return filtered.size === prev.size ? prev : filtered;
    });
    setActiveId((prev) => (prev && !ids.has(prev) ? null : prev));
    setAnchorId((prev) => (prev && !ids.has(prev) ? null : prev));
  }, [index]);

  useEffect(() => {
    if (!index) return;

    const initial: ThumbMap = {};
    const requests: ThumbnailRequest[] = [];
    for (const b of index.bundles) {
      const file = previewFile(b);
      if (file) {
        initial[b.bundle_id] = { kind: "loading" };
        requests.push({ bundle_id: b.bundle_id, file });
      } else {
        initial[b.bundle_id] = { kind: "none" };
      }
    }
    setThumbs(initial);

    if (requests.length === 0) return;

    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    const folder = index.folder_path;

    void (async () => {
      try {
        // Subscribe BEFORE the batch invoke — otherwise fast cache hits could
        // emit and be lost before the listener is registered.
        unlisten = await listen<ThumbnailReadyEvent>("thumbnail-ready", (e) => {
          if (cancelled) return;
          const { bundle_id, path, error } = e.payload;
          setThumbs((prev) => ({
            ...prev,
            [bundle_id]: error
              ? { kind: "error", message: error }
              : path
                ? { kind: "ready", path }
                : { kind: "none" },
          }));
        });
        if (cancelled) {
          unlisten();
          return;
        }
        await invoke("generate_thumbnails", { folder, requests });
      } catch (e: unknown) {
        if (!cancelled) setError(toMessage(e));
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [index]);

  const activeBundle = useMemo(
    () => index?.bundles.find((b) => b.bundle_id === activeId) ?? null,
    [index, activeId],
  );
  const activeIndex = useMemo(
    () =>
      index && activeId
        ? index.bundles.findIndex((b) => b.bundle_id === activeId)
        : -1,
    [index, activeId],
  );

  const previewSrc = useMemo(() => {
    if (!activeBundle || !index) return null;
    const jpg = activeBundle.files.find((f) => f.role === "jpeg");
    if (!jpg) return null;
    return joinPath(index.folder_path, jpg.path);
  }, [activeBundle, index]);

  // Load (or reset) the active bundle's sidecar whenever the active selection
  // changes. Editing posts on the wrong bundle would be a nasty bug, so we
  // gate the displayed sidecar on a token tied to this load.
  useEffect(() => {
    if (!activeBundle || !index) {
      setActiveSidecar(null);
      setSidecarLoading(false);
      setAddingPost(false);
      return;
    }
    let cancelled = false;
    setSidecarLoading(true);
    setAddingPost(false);
    const folder = index.folder_path;
    const baseName = activeBundle.base_name;
    void (async () => {
      try {
        const loaded = await invoke<BundleSidecar | null>("get_bundle_sidecar", {
          folder,
          baseName,
        });
        if (cancelled) return;
        setActiveSidecar(loaded ?? emptySidecar(activeBundle));
      } catch (e: unknown) {
        if (cancelled) return;
        setError(toMessage(e));
        setActiveSidecar(emptySidecar(activeBundle));
      } finally {
        if (!cancelled) setSidecarLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeBundle, index]);

  const handleTileClick = useCallback(
    (id: string, e: React.MouseEvent) => {
      if (!index) return;
      const meta = e.ctrlKey || e.metaKey;
      if (e.shiftKey && anchorId) {
        setSelectedIds(new Set(rangeIds(index.bundles, anchorId, id)));
        setActiveId(id);
        // anchorId stays — Shift extends from the same anchor on subsequent clicks.
      } else if (meta) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        setActiveId(id);
        setAnchorId(id);
      } else {
        selectSingle(id);
      }
    },
    [anchorId, index],
  );

  const navigateBy = useCallback(
    (delta: number, extend: boolean) => {
      if (!index || index.bundles.length === 0) return;
      const cur = activeId
        ? index.bundles.findIndex((b) => b.bundle_id === activeId)
        : -1;
      const nextIdx =
        cur < 0
          ? delta > 0
            ? 0
            : index.bundles.length - 1
          : Math.max(0, Math.min(index.bundles.length - 1, cur + delta));
      const nextId = index.bundles[nextIdx].bundle_id;

      if (extend) {
        const a = anchorId ?? activeId ?? nextId;
        if (!anchorId) setAnchorId(a);
        setSelectedIds(new Set(rangeIds(index.bundles, a, nextId)));
        setActiveId(nextId);
      } else {
        selectSingle(nextId);
      }
    },
    [activeId, anchorId, index],
  );

  const removeBundlesAndAdvance = useCallback((removedIds: ReadonlySet<string>) => {
    setIndex((prev) => {
      if (!prev) return prev;
      const removedIndices = prev.bundles
        .map((b, i) => (removedIds.has(b.bundle_id) ? i : -1))
        .filter((i) => i >= 0);
      const lowest = removedIndices.length > 0 ? Math.min(...removedIndices) : -1;
      const remaining = prev.bundles.filter((b) => !removedIds.has(b.bundle_id));

      if (remaining.length === 0) {
        resetSelection();
      } else if (lowest >= 0) {
        const nextIdx = Math.min(lowest, remaining.length - 1);
        const nextId = remaining[nextIdx].bundle_id;
        setActiveId(nextId);
        setSelectedIds(new Set([nextId]));
        setAnchorId(nextId);
      }
      return { ...prev, bundles: remaining };
    });
  }, []);

  const collectSelectedFiles = useCallback((): {
    folder: string;
    files: string[];
    ids: Set<string>;
  } | null => {
    if (!index || selectedIds.size === 0) return null;
    const ids = new Set(selectedIds);
    const files: string[] = [];
    for (const b of index.bundles) {
      if (!ids.has(b.bundle_id)) continue;
      for (const f of b.files) files.push(f.path);
    }
    return { folder: index.folder_path, files, ids };
  }, [index, selectedIds]);

  const deleteSelected = useCallback(async () => {
    if (busy) return;
    const job = collectSelectedFiles();
    if (!job) return;

    if (job.ids.size > 1) {
      let proceed = false;
      try {
        proceed = await ask(
          `Move ${job.ids.size} bundles (${job.files.length} files) to trash?`,
          { title: "Delete bundles", kind: "warning", okLabel: "Move to Trash" },
        );
      } catch (e: unknown) {
        setError(toMessage(e));
        return;
      }
      if (!proceed) return;
    }

    setBusy(true);
    setError(null);
    try {
      await invoke("trash_bundle", { folder: job.folder, files: job.files });
      removeBundlesAndAdvance(job.ids);
    } catch (e: unknown) {
      setError(toMessage(e));
    } finally {
      setBusy(false);
    }
  }, [busy, collectSelectedFiles, removeBundlesAndAdvance]);

  const moveSelected = useCallback(async () => {
    if (busy) return;
    const job = collectSelectedFiles();
    if (!job) return;
    let dest: string | null;
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        defaultPath: job.folder,
      });
      dest = typeof picked === "string" ? picked : null;
    } catch (e: unknown) {
      setError(toMessage(e));
      return;
    }
    if (!dest) return;

    setBusy(true);
    setError(null);
    try {
      await invoke("move_bundle", { folder: job.folder, files: job.files, dest });
      removeBundlesAndAdvance(job.ids);
    } catch (e: unknown) {
      setError(toMessage(e));
    } finally {
      setBusy(false);
    }
  }, [busy, collectSelectedFiles, removeBundlesAndAdvance]);

  const copySelected = useCallback(async () => {
    if (busy) return;
    const job = collectSelectedFiles();
    if (!job) return;
    let dest: string | null;
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        defaultPath: job.folder,
      });
      dest = typeof picked === "string" ? picked : null;
    } catch (e: unknown) {
      setError(toMessage(e));
      return;
    }
    if (!dest) return;

    setBusy(true);
    setError(null);
    try {
      await invoke("copy_bundle", { folder: job.folder, files: job.files, dest });
    } catch (e: unknown) {
      setError(toMessage(e));
    } finally {
      setBusy(false);
    }
  }, [busy, collectSelectedFiles]);

  const persistSidecar = useCallback(
    async (next: BundleSidecar): Promise<boolean> => {
      if (!index) return false;
      try {
        await invoke("save_bundle_sidecar", {
          folder: index.folder_path,
          sidecar: next,
        });
        return true;
      } catch (e: unknown) {
        setError(toMessage(e));
        return false;
      }
    },
    [index],
  );

  const savePost = useCallback(
    async (post: Omit<PostRecord, "id">) => {
      if (!activeSidecar) return;
      const next: BundleSidecar = {
        ...activeSidecar,
        posts: [...activeSidecar.posts, { ...post, id: generatePostId() }],
        updated_at: new Date().toISOString(),
      };
      const ok = await persistSidecar(next);
      if (ok) {
        setActiveSidecar(next);
        setAddingPost(false);
      }
    },
    [activeSidecar, persistSidecar],
  );

  const deletePost = useCallback(
    async (postId: string) => {
      if (!activeSidecar) return;
      const next: BundleSidecar = {
        ...activeSidecar,
        posts: activeSidecar.posts.filter((p) => p.id !== postId),
        updated_at: new Date().toISOString(),
      };
      const ok = await persistSidecar(next);
      if (ok) setActiveSidecar(next);
    },
    [activeSidecar, persistSidecar],
  );

  const handleOpenUrl = useCallback(async (url: string) => {
    try {
      await openUrl(url);
    } catch (e: unknown) {
      setError(toMessage(e));
    }
  }, []);

  const openActive = useCallback(
    async (role: "raw" | "jpeg" | null) => {
      if (!activeBundle || !index) return;
      const file = role
        ? activeBundle.files.find((f) => f.role === role)
        : activeBundle.files[0];
      if (!file) return;
      try {
        await invoke("open_path", {
          path: joinPath(index.folder_path, file.path),
        });
      } catch (e: unknown) {
        setError(toMessage(e));
      }
    },
    [activeBundle, index],
  );

  const selectAll = useCallback(() => {
    if (!index) return;
    setSelectedIds(new Set(index.bundles.map((b) => b.bundle_id)));
    if (!activeId && index.bundles.length > 0) {
      setActiveId(index.bundles[0].bundle_id);
      setAnchorId(index.bundles[0].bundle_id);
    }
  }, [activeId, index]);

  const collapseToActive = useCallback(() => {
    if (activeId) {
      setSelectedIds(new Set([activeId]));
      setAnchorId(activeId);
    } else {
      resetSelection();
    }
  }, [activeId]);

  useEffect(() => {
    const isInput = (el: EventTarget | null) =>
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    const onKey = (e: KeyboardEvent) => {
      if (isInput(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;

      if (mod && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        selectAll();
        return;
      }
      if (mod || e.altKey) return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          setFocusMode((m) => !m);
          break;
        case "f":
        case "F":
          e.preventDefault();
          setPreviewMode((m) => (m === "fit" ? "full" : "fit"));
          break;
        case "ArrowLeft":
          e.preventDefault();
          navigateBy(-1, e.shiftKey);
          break;
        case "ArrowRight":
          e.preventDefault();
          navigateBy(1, e.shiftKey);
          break;
        case "Escape":
          e.preventDefault();
          collapseToActive();
          break;
        case "Delete":
          e.preventDefault();
          void deleteSelected();
          break;
        case "m":
        case "M":
          e.preventDefault();
          void moveSelected();
          break;
        case "c":
        case "C":
          e.preventDefault();
          void copySelected();
          break;
        case "o":
        case "O":
          e.preventDefault();
          void openActive("jpeg");
          break;
        case "Enter":
          if (activeBundle && !addingPost && !busy) {
            e.preventDefault();
            setAddingPost(true);
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    navigateBy,
    deleteSelected,
    moveSelected,
    copySelected,
    openActive,
    selectAll,
    collapseToActive,
    activeBundle,
    addingPost,
    busy,
  ]);

  const totalFiles = index?.bundles.reduce((n, b) => n + b.files.length, 0) ?? 0;
  const readyCount = Object.values(thumbs).filter((t) => t.kind === "ready").length;
  const pendingCount = Object.values(thumbs).filter((t) => t.kind === "loading").length;

  return (
    <main className="app">
      <header className="topbar">
        <button onClick={pickAndOpenFolder} disabled={loading}>
          {loading ? "Scanning..." : "Open Folder..."}
        </button>
        {index && (
          <button onClick={rescanCurrent} disabled={loading} title="Re-scan current folder, bypassing cache">
            Re-scan
          </button>
        )}
        {index && (
          <>
            <span className="folder-path" title={index.folder_path}>
              {index.folder_path}
            </span>
            <span className="counts">
              {index.bundles.length} bundles / {totalFiles} files
              {pendingCount > 0 && ` · ${readyCount}/${readyCount + pendingCount} thumbs`}
            </span>
          </>
        )}
        <div className="size-selector" role="group" aria-label="Tile size">
          {(Object.keys(TILE_SIZES) as TileLabel[]).map((s) => (
            <button
              key={s}
              type="button"
              className={tileLabel === s ? "active" : ""}
              onClick={() => setTileLabel(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <div className="error">
          <span>Error: {error}</span>
          <button type="button" onClick={() => setError(null)} className="error-dismiss">
            ×
          </button>
        </div>
      )}

      {index && index.bundles.length === 0 && (
        <div className="empty">No bundles found in this folder.</div>
      )}

      {!index && !error && !loading && (
        <div className="empty">Click "Open Folder..." to scan a directory.</div>
      )}

      {index && index.bundles.length > 0 && (
        <div className={`workspace${focusMode ? " focus" : ""}`}>
          <div className="grid-area">
            <ThumbnailGrid
              bundles={index.bundles}
              thumbs={thumbs}
              activeId={activeId}
              selectedIds={selectedIds}
              onTileClick={handleTileClick}
              tileSize={TILE_SIZES[tileLabel]}
            />
          </div>
          <aside className="sidebar">
            <PreviewPane
              src={previewSrc}
              mode={previewMode}
              pixelOffset={pixelOffset}
              onPixelOffsetChange={setPixelOffset}
            />
            <DetailPanel
              bundle={activeBundle}
              selectedCount={selectedIds.size}
              busy={busy}
              onDelete={deleteSelected}
              onMove={moveSelected}
              onCopy={copySelected}
              onOpen={openActive}
              sidecar={activeSidecar}
              sidecarLoading={sidecarLoading}
              addingPost={addingPost}
              onStartAddPost={() => setAddingPost(true)}
              onCancelAddPost={() => setAddingPost(false)}
              onSavePost={savePost}
              onDeletePost={deletePost}
              onOpenUrl={handleOpenUrl}
            />
          </aside>
        </div>
      )}

      {index && index.bundles.length > 0 && (
        <footer className="statusbar">
          {activeBundle ? (
            <>
              <span className="status-name">{activeBundle.base_name}</span>
              <span className="status-pos">
                ({activeIndex + 1}/{index.bundles.length})
              </span>
            </>
          ) : (
            <span className="status-name muted">No selection</span>
          )}
          {selectedIds.size > 1 && (
            <span className="mode-tag selected">{selectedIds.size} selected</span>
          )}
          <span className={`mode-tag ${previewMode}`}>
            {previewMode === "fit" ? "Fit" : "100%"}
          </span>
          {focusMode && <span className="mode-tag focus">Focus</span>}
          {busy && <span className="mode-tag busy">Working…</span>}
          <span className="hints">
            Click · Shift/Ctrl · Ctrl+A · Esc · ← → · Space · F · Del/M/C/O · Enter
          </span>
        </footer>
      )}
    </main>
  );
}

function toMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

function emptySidecar(bundle: BundleSummary): BundleSidecar {
  const now = new Date().toISOString();
  return {
    version: 1,
    bundle_id: bundle.bundle_id,
    base_name: bundle.base_name,
    tags: [],
    posts: [],
    created_at: now,
    updated_at: now,
  };
}

export default App;
