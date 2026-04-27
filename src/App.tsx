import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { BundleSummary, FolderIndex } from "./types/bundle";
import type { ThumbMap } from "./types/thumb";
import type { PixelOffset, PreviewMode } from "./types/preview";
import { ThumbnailGrid } from "./components/ThumbnailGrid";
import { PreviewPane } from "./components/PreviewPane";
import { DetailPanel } from "./components/DetailPanel";
import { joinPath } from "./utils/path";
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tileLabel, setTileLabel] = useState<TileLabel>("M");
  const [previewMode, setPreviewMode] = useState<PreviewMode>("fit");
  const [focusMode, setFocusMode] = useState(false);
  const [pixelOffset, setPixelOffset] = useState<PixelOffset>({ dx: 0, dy: 0 });

  async function pickAndOpenFolder() {
    setError(null);
    setThumbs({});
    setSelectedId(null);
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

  useEffect(() => {
    if (!index) return;

    const initial: ThumbMap = {};
    for (const b of index.bundles) {
      initial[b.bundle_id] = previewFile(b) ? { kind: "loading" } : { kind: "none" };
    }
    setThumbs(initial);

    let cancelled = false;
    const folder = index.folder_path;
    const tasks = index.bundles
      .map((b) => ({ b, file: previewFile(b) }))
      .filter((x): x is { b: BundleSummary; file: string } => x.file !== null);

    void Promise.all(
      tasks.map(async ({ b, file }) => {
        try {
          const path = await invoke<string>("ensure_thumbnail", { folder, file });
          if (cancelled) return;
          setThumbs((prev) => ({ ...prev, [b.bundle_id]: { kind: "ready", path } }));
        } catch (e: unknown) {
          if (cancelled) return;
          setThumbs((prev) => ({
            ...prev,
            [b.bundle_id]: { kind: "error", message: toMessage(e) },
          }));
        }
      }),
    );

    return () => {
      cancelled = true;
    };
  }, [index]);

  const selectedBundle = useMemo(
    () => index?.bundles.find((b) => b.bundle_id === selectedId) ?? null,
    [index, selectedId],
  );
  const selectedIndex = useMemo(
    () =>
      index && selectedId
        ? index.bundles.findIndex((b) => b.bundle_id === selectedId)
        : -1,
    [index, selectedId],
  );

  const previewSrc = useMemo(() => {
    if (!selectedBundle || !index) return null;
    const jpg = selectedBundle.files.find((f) => f.role === "jpeg");
    if (!jpg) return null;
    return joinPath(index.folder_path, jpg.path);
  }, [selectedBundle, index]);

  const navigateBy = useCallback(
    (delta: number) => {
      if (!index || index.bundles.length === 0) return;
      const cur = selectedId
        ? index.bundles.findIndex((b) => b.bundle_id === selectedId)
        : -1;
      const next =
        cur < 0
          ? delta > 0
            ? 0
            : index.bundles.length - 1
          : Math.max(0, Math.min(index.bundles.length - 1, cur + delta));
      setSelectedId(index.bundles[next].bundle_id);
    },
    [index, selectedId],
  );

  const removeBundleAndAdvance = useCallback((removedId: string) => {
    setIndex((prev) => {
      if (!prev) return prev;
      const idx = prev.bundles.findIndex((b) => b.bundle_id === removedId);
      const remaining = prev.bundles.filter((b) => b.bundle_id !== removedId);
      if (remaining.length === 0) {
        setSelectedId(null);
      } else {
        const nextIdx = Math.min(Math.max(idx, 0), remaining.length - 1);
        setSelectedId(remaining[nextIdx].bundle_id);
      }
      return { ...prev, bundles: remaining };
    });
  }, []);

  const deleteSelected = useCallback(async () => {
    if (!selectedBundle || !index || busy) return;
    setBusy(true);
    setError(null);
    const removedId = selectedBundle.bundle_id;
    try {
      await invoke("trash_bundle", {
        folder: index.folder_path,
        files: selectedBundle.files.map((f) => f.path),
      });
      removeBundleAndAdvance(removedId);
    } catch (e: unknown) {
      setError(toMessage(e));
    } finally {
      setBusy(false);
    }
  }, [busy, index, removeBundleAndAdvance, selectedBundle]);

  const moveSelected = useCallback(async () => {
    if (!selectedBundle || !index || busy) return;
    let dest: string | null;
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        defaultPath: index.folder_path,
      });
      dest = typeof picked === "string" ? picked : null;
    } catch (e: unknown) {
      setError(toMessage(e));
      return;
    }
    if (!dest) return;

    setBusy(true);
    setError(null);
    const removedId = selectedBundle.bundle_id;
    try {
      await invoke("move_bundle", {
        folder: index.folder_path,
        files: selectedBundle.files.map((f) => f.path),
        dest,
      });
      removeBundleAndAdvance(removedId);
    } catch (e: unknown) {
      setError(toMessage(e));
    } finally {
      setBusy(false);
    }
  }, [busy, index, removeBundleAndAdvance, selectedBundle]);

  const copySelected = useCallback(async () => {
    if (!selectedBundle || !index || busy) return;
    let dest: string | null;
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        defaultPath: index.folder_path,
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
      await invoke("copy_bundle", {
        folder: index.folder_path,
        files: selectedBundle.files.map((f) => f.path),
        dest,
      });
    } catch (e: unknown) {
      setError(toMessage(e));
    } finally {
      setBusy(false);
    }
  }, [busy, index, selectedBundle]);

  const openSelected = useCallback(
    async (role: "raw" | "jpeg" | null) => {
      if (!selectedBundle || !index) return;
      const file = role
        ? selectedBundle.files.find((f) => f.role === role)
        : selectedBundle.files[0];
      if (!file) return;
      try {
        await invoke("open_path", {
          path: joinPath(index.folder_path, file.path),
        });
      } catch (e: unknown) {
        setError(toMessage(e));
      }
    },
    [index, selectedBundle],
  );

  useEffect(() => {
    const isInput = (el: EventTarget | null) =>
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    const onKey = (e: KeyboardEvent) => {
      if (isInput(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
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
          navigateBy(-1);
          break;
        case "ArrowRight":
          e.preventDefault();
          navigateBy(1);
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
          void openSelected("jpeg");
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigateBy, deleteSelected, moveSelected, copySelected, openSelected]);

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
              selectedId={selectedId}
              onSelect={setSelectedId}
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
              bundle={selectedBundle}
              busy={busy}
              onDelete={deleteSelected}
              onMove={moveSelected}
              onCopy={copySelected}
              onOpen={openSelected}
            />
          </aside>
        </div>
      )}

      {index && index.bundles.length > 0 && (
        <footer className="statusbar">
          {selectedBundle ? (
            <>
              <span className="status-name">{selectedBundle.base_name}</span>
              <span className="status-pos">
                ({selectedIndex + 1}/{index.bundles.length})
              </span>
            </>
          ) : (
            <span className="status-name muted">No selection</span>
          )}
          <span className={`mode-tag ${previewMode}`}>
            {previewMode === "fit" ? "Fit" : "100%"}
          </span>
          {focusMode && <span className="mode-tag focus">Focus</span>}
          {busy && <span className="mode-tag busy">Working…</span>}
          <span className="hints">Space focus · F 100% · ← → nav · Del/M/C/O</span>
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

export default App;
