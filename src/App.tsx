import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { BundleRef, BundleSummary, FolderIndex } from "./types/bundle";
import type { ThumbMap, ThumbnailReadyEvent, ThumbnailRequest } from "./types/thumb";
import type { PixelOffset, PreviewMode } from "./types/preview";
import type { BundleSidecar, PostRecord } from "./types/sidecar";
import type { AppSettings } from "./types/settings";
import type {
  GalleryFeedbackEntry,
  GalleryRecord,
} from "./types/gallery";
import { generatePostId } from "./components/PostsSection";
import { SettingsDialog } from "./components/SettingsDialog";
import { WelcomeDialog } from "./components/WelcomeDialog";
import { SearchDialog } from "./components/SearchDialog";
import { ShareDialog } from "./components/ShareDialog";
import { GalleriesDialog, type ApplyResult } from "./components/GalleriesDialog";
import { patchBundleFlag } from "./utils/flagPatch";
import { CheatsheetOverlay } from "./components/CheatsheetOverlay";
import { ThumbnailGrid } from "./components/ThumbnailGrid";
import { PreviewPane } from "./components/PreviewPane";
import { DetailPanel } from "./components/DetailPanel";
import { joinPath } from "./utils/path";
import {
  previewVariants,
  selectThumbnailSource,
} from "./utils/preview";
import { rangeIds } from "./utils/selection";
import {
  applyFilter,
  distinctTags,
  FILTER_LABELS,
  FILTER_MODES,
  type FilterMode,
} from "./utils/filter";
import "./App.css";

const TILE_SIZES = { S: 128, M: 200, L: 320 } as const;
type TileLabel = keyof typeof TILE_SIZES;


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
  const [fullscreenMode, setFullscreenMode] = useState(false);
  const [pixelOffset, setPixelOffset] = useState<PixelOffset>({ dx: 0, dy: 0 });

  const [activeSidecar, setActiveSidecar] = useState<BundleSidecar | null>(null);
  const [sidecarLoading, setSidecarLoading] = useState(false);
  const [addingPost, setAddingPost] = useState(false);

  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [filterTag, setFilterTag] = useState<string | null>(null);

  // null = auto (uses previewVariants[0]); a number is an explicit index into
  // the active bundle's variant list, set by ↑/↓ or by clicking a row in
  // the file list.
  const [previewVariantIndex, setPreviewVariantIndex] = useState<number | null>(
    null,
  );

  const [appSettings, setAppSettings] = useState<AppSettings>({
    raw_developers: [],
    active_raw_developer_index: 0,
  });
  const [showSettings, setShowSettings] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showGalleries, setShowGalleries] = useState(false);
  const [showCheatsheet, setShowCheatsheet] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  // Auto-dismiss the toast after a few seconds.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  // Backup modifier-key tracker. On at least some WebView2 builds the
  // shift/ctrl flags on click events are not propagated, which makes
  // Shift+click and Ctrl+click on tiles indistinguishable from a plain
  // click. We mirror the modifier state via keydown/keyup so the tile
  // click handler can OR in this state and still do the right thing.
  // Also resets on window blur — alt-tabbing while a modifier was down
  // would otherwise leave it stuck on.
  const modKeysRef = useRef({ shift: false, ctrl: false, meta: false });
  useEffect(() => {
    const sync = (e: KeyboardEvent) => {
      modKeysRef.current = {
        shift: e.shiftKey,
        ctrl: e.ctrlKey,
        meta: e.metaKey,
      };
    };
    const reset = () => {
      modKeysRef.current = { shift: false, ctrl: false, meta: false };
    };
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", reset);
    };
  }, []);

  // F1 hold-to-show keyboard cheatsheet overlay. Bound at window level so it
  // works regardless of focus, including while typing in the tag/post inputs.
  // Listening to blur catches the case where the user alt-tabs away while
  // F1 is still down — keyup never fires for us in that case.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "F1") {
        e.preventDefault();
        setShowCheatsheet(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "F1") {
        e.preventDefault();
        setShowCheatsheet(false);
      }
    };
    const onBlur = () => setShowCheatsheet(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Load app-wide settings on mount.
  useEffect(() => {
    void invoke<AppSettings>("get_app_settings").then((s) => {
      setAppSettings(s);
      // First launch (or pre-`welcome_seen` install) → show the welcome
      // overlay once. The user dismissing it persists `welcome_seen: true`.
      if (!s.welcome_seen) setShowWelcome(true);
    });
  }, []);

  const dismissWelcome = useCallback(async () => {
    setShowWelcome(false);
    // Persist immediately so a crash before the user touches anything else
    // doesn't make the dialog reappear next launch.
    setAppSettings((prev) => {
      const next = { ...prev, welcome_seen: true };
      void invoke("save_app_settings", { settings: next });
      return next;
    });
  }, []);

  const saveSettings = useCallback(async (next: AppSettings) => {
    await invoke("save_app_settings", { settings: next });
    setAppSettings(next);
    setShowSettings(false);
  }, []);

  const cycleRawDeveloper = useCallback(async () => {
    const list = appSettings.raw_developers ?? [];
    if (list.length < 2) return;
    try {
      const updated = await invoke<AppSettings>("cycle_active_raw_developer");
      setAppSettings(updated);
    } catch (e: unknown) {
      setError(toMessage(e));
    }
  }, [appSettings.raw_developers]);

  const activeRawDeveloper = useMemo(() => {
    const list = appSettings.raw_developers ?? [];
    const idx = appSettings.active_raw_developer_index ?? 0;
    return list[idx];
  }, [appSettings.raw_developers, appSettings.active_raw_developer_index]);

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

  const loadFolderByPath = useCallback(async (path: string) => {
    setError(null);
    setThumbs({});
    resetSelection();
    setPixelOffset({ dx: 0, dy: 0 });
    setLoading(true);
    try {
      const result = await invoke<FolderIndex>("open_folder", { path });
      setIndex(result);
    } catch (e: unknown) {
      setError(toMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // OS-level drag-drop into the window. The backend's open_folder tolerates
  // file paths (falls back to the parent dir), so dropping either a folder
  // or any single file inside one does the right thing.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void (async () => {
      const win = getCurrentWebviewWindow();
      unlisten = await win.onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          setIsDraggingOver(true);
        } else if (p.type === "leave") {
          setIsDraggingOver(false);
        } else if (p.type === "drop") {
          setIsDraggingOver(false);
          if (p.paths.length > 0) {
            void loadFolderByPath(p.paths[0]);
          }
        }
      });
    })();
    return () => {
      unlisten?.();
    };
  }, [loadFolderByPath]);

  async function pickAndOpenFolder() {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (!selected || typeof selected !== "string") return;
      await loadFolderByPath(selected);
    } catch (e: unknown) {
      setError(toMessage(e));
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

  useEffect(() => {
    if (!index) return;

    const initial: ThumbMap = {};
    const requests: ThumbnailRequest[] = [];
    for (const b of index.bundles) {
      const file = selectThumbnailSource(b);
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

  // Filtered view of bundles. Navigation, selection, and the grid all use
  // this slice — the underlying index.bundles is the source of truth and
  // should rarely be referenced directly outside of file-op handlers.
  const filteredBundles = useMemo(
    () => (index ? applyFilter(index.bundles, filterMode, filterTag) : []),
    [index, filterMode, filterTag],
  );

  const availableTags = useMemo(
    () => (index ? distinctTags(index.bundles) : []),
    [index],
  );

  // If the user removes the last bundle bearing the active tag filter,
  // collapse back to no-tag-filter so the grid doesn't go empty silently.
  useEffect(() => {
    if (filterTag && !availableTags.includes(filterTag)) {
      setFilterTag(null);
    }
  }, [availableTags, filterTag]);

  // Prune selection / anchor / active when the visible set changes — either
  // because a Re-scan dropped a bundle, or the user changed the filter.
  useEffect(() => {
    const ids = new Set(filteredBundles.map((b) => b.bundle_id));
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setActiveId((prev) => (prev && !ids.has(prev) ? null : prev));
    setAnchorId((prev) => (prev && !ids.has(prev) ? null : prev));
  }, [filteredBundles]);

  const activeBundle = useMemo(
    () => index?.bundles.find((b) => b.bundle_id === activeId) ?? null,
    [index, activeId],
  );
  const activeIndex = useMemo(
    () =>
      activeId
        ? filteredBundles.findIndex((b) => b.bundle_id === activeId)
        : -1,
    [filteredBundles, activeId],
  );

  const activeVariants = useMemo(
    () => (activeBundle ? previewVariants(activeBundle) : []),
    [activeBundle],
  );

  // Reset variant cursor when the active bundle changes; otherwise an index
  // from the previous bundle could leak in and pick the wrong file.
  useEffect(() => {
    setPreviewVariantIndex(null);
  }, [activeId]);

  const currentPreviewVariant = useMemo(() => {
    if (activeVariants.length === 0) return null;
    if (previewVariantIndex === null) return activeVariants[0];
    return (
      activeVariants[previewVariantIndex] ?? activeVariants[0] ?? null
    );
  }, [activeVariants, previewVariantIndex]);

  // Reset the 100%-mode pan offset whenever the source variant changes —
  // each photo has its own dimensions, and a leftover offset from a
  // previous (larger / smaller / differently-cropped) image could push
  // the new one entirely off-screen so the pane reads as black.
  useEffect(() => {
    setPixelOffset({ dx: 0, dy: 0 });
  }, [currentPreviewVariant?.path]);

  // Resolved preview path — for RAW variants this is the cached embedded
  // JPEG (extracted on demand by `ensure_preview_image_path`); for
  // everything else it's just folder + variant.path resolved synchronously.
  // Async resolve happens in an effect so the UI doesn't block while RAW
  // extraction runs; in-flight resolutions are cancelled when the variant
  // changes to avoid flashing the wrong image.
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!currentPreviewVariant || !index) {
      setPreviewSrc(null);
      return;
    }
    if (currentPreviewVariant.role !== "raw") {
      setPreviewSrc(joinPath(index.folder_path, currentPreviewVariant.path));
      return;
    }
    // Clear immediately so the pane shows "No preview available" instead
    // of the previous bundle's image while we wait for the async extract.
    // Otherwise the user sees the old photo with the new pixelOffset and
    // it can read as a misplaced/black tile mid-switch.
    setPreviewSrc(null);
    let cancelled = false;
    void invoke<string>("ensure_preview_image_path", {
      folder: index.folder_path,
      source: currentPreviewVariant.path,
    })
      .then((path) => {
        if (!cancelled) setPreviewSrc(path);
      })
      .catch(() => {
        if (!cancelled) setPreviewSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [currentPreviewVariant, index]);

  const cyclePreviewVariant = useCallback(
    (delta: number) => {
      if (activeVariants.length < 2) return;
      setPreviewVariantIndex((prev) => {
        const cur = prev ?? 0;
        const len = activeVariants.length;
        return ((cur + delta) % len + len) % len;
      });
    },
    [activeVariants.length],
  );

  const selectPreviewByPath = useCallback(
    (path: string) => {
      const idx = activeVariants.findIndex((f) => f.path === path);
      if (idx < 0) return;
      setPreviewVariantIndex(idx);
    },
    [activeVariants],
  );

  const trashVariant = useCallback(
    async (path: string) => {
      if (!index || !activeBundle || busy) return;
      // Match the file plus any sidecar that decorates it (e.g.
      // <file>.rawdev.json) — same prefix-with-dot rule the bundling logic
      // uses, so per-variant metadata follows the file into the trash and
      // doesn't leave orphans behind.
      const target = activeBundle.files.find((f) => f.path === path);
      if (!target) return;
      const attached = activeBundle.files.filter(
        (f) => f.path !== target.path && f.path.startsWith(target.path + "."),
      );
      const allPaths = [target.path, ...attached.map((f) => f.path)];

      const promptMsg =
        attached.length === 0
          ? `Move ${target.path} to trash?`
          : `Move ${target.path} and ${attached.length} attached ${
              attached.length === 1 ? "file" : "files"
            } to trash?\n\n` +
            attached.map((f) => `· ${f.path}`).join("\n");

      let proceed = false;
      try {
        proceed = await ask(promptMsg, {
          title: "Delete this variant",
          kind: "warning",
          okLabel: "Move to Trash",
        });
      } catch (e: unknown) {
        setError(toMessage(e));
        return;
      }
      if (!proceed) return;

      setBusy(true);
      setError(null);
      try {
        await invoke("trash_bundle", {
          folder: index.folder_path,
          files: allPaths,
        });
        const removed = new Set(allPaths);
        setIndex((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            bundles: prev.bundles.map((b) =>
              b.bundle_id === activeBundle.bundle_id
                ? { ...b, files: b.files.filter((f) => !removed.has(f.path)) }
                : b,
            ),
          };
        });
        // The variant list just shrank; bouncing back to auto picks whatever
        // remains (latest developed → in-camera) without us having to know
        // the new index.
        setPreviewVariantIndex(null);
      } catch (e: unknown) {
        setError(toMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [activeBundle, busy, index],
  );

  const trashCurrentVariant = useCallback(() => {
    if (!currentPreviewVariant) return;
    void trashVariant(currentPreviewVariant.path);
  }, [currentPreviewVariant, trashVariant]);

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
      // Some WebView2 builds drop the modifier-key flags on synthetic
      // click events, so we OR in the keydown-tracked state.
      const mk = modKeysRef.current;
      const isShift = e.shiftKey || mk.shift;
      const meta = e.ctrlKey || e.metaKey || mk.ctrl || mk.meta;
      if (isShift) {
        // Range from anchor to clicked, restricted to what's currently
        // visible. If there's no anchor yet (e.g., first click of the
        // session was a Shift+click), seed it from the clicked tile so
        // the next Shift+click extends a real range instead of being a
        // no-op.
        const anchor = anchorId ?? activeId ?? id;
        setSelectedIds(new Set(rangeIds(filteredBundles, anchor, id)));
        setActiveId(id);
        if (!anchorId) setAnchorId(anchor);
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
    [activeId, anchorId, filteredBundles, index],
  );

  const navigateBy = useCallback(
    (delta: number, extend: boolean) => {
      if (filteredBundles.length === 0) return;
      const cur = activeId
        ? filteredBundles.findIndex((b) => b.bundle_id === activeId)
        : -1;
      const nextIdx =
        cur < 0
          ? delta > 0
            ? 0
            : filteredBundles.length - 1
          : Math.max(0, Math.min(filteredBundles.length - 1, cur + delta));
      const nextId = filteredBundles[nextIdx].bundle_id;

      if (extend) {
        const a = anchorId ?? activeId ?? nextId;
        if (!anchorId) setAnchorId(a);
        setSelectedIds(new Set(rangeIds(filteredBundles, a, nextId)));
        setActiveId(nextId);
      } else {
        selectSingle(nextId);
      }
    },
    [activeId, anchorId, filteredBundles],
  );

  const removeBundlesAndAdvance = useCallback(
    (removedIds: ReadonlySet<string>) => {
      setIndex((prev) => {
        if (!prev) return prev;
        // "Next" should be a still-visible neighbour, not just the next bundle
        // in the unfiltered list — otherwise deleting a pick while the Pick
        // filter is on jumps to a bundle that's invisible.
        const visibleBefore = applyFilter(prev.bundles, filterMode, filterTag);
        const removedVisibleIndices = visibleBefore
          .map((b, i) => (removedIds.has(b.bundle_id) ? i : -1))
          .filter((i) => i >= 0);
        const lowestVisible =
          removedVisibleIndices.length > 0
            ? Math.min(...removedVisibleIndices)
            : -1;

        const remaining = prev.bundles.filter(
          (b) => !removedIds.has(b.bundle_id),
        );
        const visibleAfter = applyFilter(remaining, filterMode, filterTag);

        if (visibleAfter.length === 0) {
          resetSelection();
        } else if (lowestVisible >= 0) {
          const nextIdx = Math.min(lowestVisible, visibleAfter.length - 1);
          const nextId = visibleAfter[nextIdx].bundle_id;
          setActiveId(nextId);
          setSelectedIds(new Set([nextId]));
          setAnchorId(nextId);
        }
        return { ...prev, bundles: remaining };
      });
    },
    [filterMode, filterTag],
  );

  type OpScope = "all" | "developed";

  const collectSelectedFiles = useCallback(
    (
      scope: OpScope = "all",
    ): { folder: string; files: string[]; ids: Set<string> } | null => {
      if (!index || selectedIds.size === 0) return null;
      const ids = new Set(selectedIds);
      const files: string[] = [];
      for (const b of index.bundles) {
        if (!ids.has(b.bundle_id)) continue;
        for (const f of b.files) {
          if (scope === "developed" && f.role !== "developed") continue;
          files.push(f.path);
        }
      }
      return { folder: index.folder_path, files, ids };
    },
    [index, selectedIds],
  );

  // Drop the moved files from each affected bundle's files[] without
  // removing the bundle itself — used for developed-only Move where the
  // canonical RAW + in-camera JPG should remain in the source folder.
  const detachFilesFromBundles = useCallback(
    (bundleIds: ReadonlySet<string>, removedPaths: ReadonlySet<string>) => {
      setIndex((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          bundles: prev.bundles.map((b) =>
            bundleIds.has(b.bundle_id)
              ? { ...b, files: b.files.filter((f) => !removedPaths.has(f.path)) }
              : b,
          ),
        };
      });
    },
    [],
  );

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

  const moveSelected = useCallback(
    async (scope: OpScope = "all") => {
      if (busy) return;
      const job = collectSelectedFiles(scope);
      if (!job || job.files.length === 0) return;
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
        if (scope === "developed") {
          // Bundles stay in source — just drop the now-moved variants from
          // each. Their canonical RAW + in-camera JPG remain.
          detachFilesFromBundles(job.ids, new Set(job.files));
        } else {
          removeBundlesAndAdvance(job.ids);
        }
      } catch (e: unknown) {
        setError(toMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, collectSelectedFiles, detachFilesFromBundles, removeBundlesAndAdvance],
  );

  const copySelected = useCallback(
    async (scope: OpScope = "all") => {
      if (busy) return;
      const job = collectSelectedFiles(scope);
      if (!job || job.files.length === 0) return;
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
    },
    [busy, collectSelectedFiles],
  );

  const persistSidecar = useCallback(
    async (next: BundleSidecar): Promise<boolean> => {
      if (!index) return false;
      try {
        await invoke("save_bundle_sidecar", {
          folder: index.folder_path,
          sidecar: next,
        });
        // Keep the in-memory BundleSummary in sync so tile overlays update
        // immediately, without waiting for a re-scan.
        const summary = postSummaryOf(next);
        setIndex((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            bundles: prev.bundles.map((b) =>
              b.bundle_id === next.bundle_id ? { ...b, ...summary } : b,
            ),
          };
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

  // Build BundleRef[] for the current selection (used by rating/flag/tag commands).
  const selectedBundleRefs = useCallback((): BundleRef[] => {
    if (!index) return [];
    const out: BundleRef[] = [];
    for (const b of index.bundles) {
      if (selectedIds.has(b.bundle_id)) {
        out.push({ bundle_id: b.bundle_id, base_name: b.base_name });
      }
    }
    return out;
  }, [index, selectedIds]);

  const setRatingForSelection = useCallback(
    async (rating: number | null) => {
      if (!index || selectedIds.size === 0 || busy) return;
      const refs = selectedBundleRefs();
      if (refs.length === 0) return;
      try {
        await invoke("set_bundle_rating", {
          folder: index.folder_path,
          bundles: refs,
          rating,
        });
        // Sync in-memory BundleSummaries.
        const ratingValue = rating ?? undefined;
        setIndex((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            bundles: prev.bundles.map((b) =>
              selectedIds.has(b.bundle_id) ? { ...b, rating: ratingValue } : b,
            ),
          };
        });
        // If the active bundle is among those updated, also patch its sidecar
        // state so the DetailPanel stays in sync.
        if (activeBundle && selectedIds.has(activeBundle.bundle_id)) {
          setActiveSidecar((prev) =>
            prev
              ? {
                  ...prev,
                  rating: ratingValue,
                  updated_at: new Date().toISOString(),
                }
              : prev,
          );
        }
      } catch (e: unknown) {
        setError(toMessage(e));
      }
    },
    [activeBundle, busy, index, selectedBundleRefs, selectedIds],
  );

  const setTagsForActive = useCallback(
    async (tags: string[]) => {
      if (!index || !activeBundle) return;
      try {
        await invoke("set_bundle_tags", {
          folder: index.folder_path,
          bundles: [
            {
              bundle_id: activeBundle.bundle_id,
              base_name: activeBundle.base_name,
            },
          ],
          tags,
        });
        setIndex((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            bundles: prev.bundles.map((b) =>
              b.bundle_id === activeBundle.bundle_id ? { ...b, tags } : b,
            ),
          };
        });
        setActiveSidecar((prev) =>
          prev
            ? { ...prev, tags, updated_at: new Date().toISOString() }
            : prev,
        );
      } catch (e: unknown) {
        setError(toMessage(e));
      }
    },
    [activeBundle, index],
  );

  const applyGalleryFeedback = useCallback(
    async (
      gid: string,
      entries: GalleryFeedbackEntry[],
      modelName?: string,
    ): Promise<ApplyResult> => {
      void gid;
      // Per-model bucketing key. Empty string is the legacy / anonymous
      // bucket inside `feedback_by_model`; null tells the Tauri command
      // to use the legacy single-flag path on bundles that don't yet have
      // a per-model map.
      const trimmedModel = modelName?.trim();
      const modelKey: string | null = trimmedModel ? trimmedModel : null;
      if (!index) {
        return {
          applied: 0,
          cleared: 0,
          notInCurrentFolder: new Set(entries.map((e) => e.bundle_id)).size,
        };
      }

      let notInCurrentFolder = 0;

      // Group per bundle — each bundle now has multiple variant entries
      // and we collapse them into a single flag for the bundle.
      const byBundle = new Map<string, GalleryFeedbackEntry[]>();
      for (const e of entries) {
        const arr = byBundle.get(e.bundle_id) ?? [];
        arr.push(e);
        byBundle.set(e.bundle_id, arr);
      }

      const bundlesById = new Map(
        index.bundles.map((b) => [b.bundle_id, b]),
      );
      const pickRefs: BundleRef[] = [];
      const okRefs: BundleRef[] = [];
      const rejectRefs: BundleRef[] = [];
      const clearRefs: BundleRef[] = [];

      for (const [bundleId, group] of byBundle) {
        const bundle = bundlesById.get(bundleId);
        if (!bundle) {
          notInCurrentFolder++;
          continue;
        }
        const ref: BundleRef = {
          bundle_id: bundle.bundle_id,
          base_name: bundle.base_name,
        };

        // Aggregate variants into a single bundle-level flag, in order
        // of decisiveness: FAV > NG > OK > (no actionable signal).
        //   FAV beats everything (model explicitly loved at least one
        //     variant of this bundle).
        //   NG over OK because rejection is more decisive than approval.
        //   OK only when the model touched the photo with a plain OK
        //     and didn't flag any variant FAV or NG.
        // No-signal bundles get their flag cleared so re-applying makes
        // gallery feedback the source of truth.
        const explicitFav = group.some(
          (e) => e.explicit && e.decision === "fav",
        );
        const explicitNg = group.some(
          (e) => e.explicit && e.decision === "ng",
        );
        const explicitOk = group.some(
          (e) => e.explicit && e.decision === "ok",
        );

        if (explicitFav) {
          pickRefs.push(ref);
        } else if (explicitNg) {
          rejectRefs.push(ref);
        } else if (explicitOk) {
          okRefs.push(ref);
        } else if (bundle.flag !== undefined) {
          // Only emit a clear if the bundle actually has a flag to clear.
          // Skipping the no-op case keeps the apply count honest and avoids
          // pointless sidecar churn.
          clearRefs.push(ref);
        }
      }

      if (pickRefs.length > 0) {
        await invoke("set_bundle_flag", {
          folder: index.folder_path,
          bundles: pickRefs,
          flag: "pick",
          modelName: modelKey,
        });
      }
      if (okRefs.length > 0) {
        await invoke("set_bundle_flag", {
          folder: index.folder_path,
          bundles: okRefs,
          flag: "ok",
          modelName: modelKey,
        });
      }
      if (rejectRefs.length > 0) {
        await invoke("set_bundle_flag", {
          folder: index.folder_path,
          bundles: rejectRefs,
          flag: "reject",
          modelName: modelKey,
        });
      }
      if (clearRefs.length > 0) {
        await invoke("set_bundle_flag", {
          folder: index.folder_path,
          bundles: clearRefs,
          flag: null,
          modelName: modelKey,
        });
      }

      const pickIds = new Set(pickRefs.map((r) => r.bundle_id));
      const okIds = new Set(okRefs.map((r) => r.bundle_id));
      const rejectIds = new Set(rejectRefs.map((r) => r.bundle_id));
      const clearIds = new Set(clearRefs.map((r) => r.bundle_id));
      setIndex((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          bundles: prev.bundles.map((b) => {
            if (pickIds.has(b.bundle_id)) return patchBundleFlag(b, "pick", modelKey);
            if (okIds.has(b.bundle_id)) return patchBundleFlag(b, "ok", modelKey);
            if (rejectIds.has(b.bundle_id))
              return patchBundleFlag(b, "reject", modelKey);
            if (clearIds.has(b.bundle_id)) return patchBundleFlag(b, null, modelKey);
            return b;
          }),
        };
      });

      return {
        applied: pickRefs.length + okRefs.length + rejectRefs.length,
        cleared: clearRefs.length,
        notInCurrentFolder,
      };
    },
    [index],
  );

  const fetchFeedbackForCurrentFolder = useCallback(async () => {
    if (!index || feedbackBusy) return;
    const norm = (p: string) =>
      p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
    setFeedbackBusy(true);
    setToast("ギャラリー一覧を取得中…");
    try {
      const all = await invoke<GalleryRecord[]>("list_galleries");
      const target = norm(index.folder_path);
      const matching = all.filter(
        (g) => g.source_folder && norm(g.source_folder) === target,
      );
      if (matching.length === 0) {
        setToast("このフォルダ向けのギャラリーはありません");
        return;
      }
      let totalApplied = 0;
      let totalCleared = 0;
      for (let i = 0; i < matching.length; i++) {
        const g = matching[i]!;
        setToast(
          `取り込み中 ${i + 1}/${matching.length} · ${g.name}`,
        );
        const entries = await invoke<GalleryFeedbackEntry[]>(
          "fetch_gallery_feedback",
          { gid: g.gid },
        );
        const result = await applyGalleryFeedback(g.gid, entries, g.model_name);
        totalApplied += result.applied;
        totalCleared += result.cleared;
      }
      const clearedNote =
        totalCleared > 0 ? ` · ${totalCleared} 件をクリア` : "";
      setToast(
        `✓ ${matching.length} 件のギャラリーから ${totalApplied} 件にフラグ反映${clearedNote}`,
      );
    } catch (e: unknown) {
      setToast(`エラー: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setFeedbackBusy(false);
    }
  }, [applyGalleryFeedback, feedbackBusy, index]);

  const handleOpenUrl = useCallback(async (url: string) => {
    try {
      await openUrl(url);
    } catch (e: unknown) {
      setError(toMessage(e));
    }
  }, []);

  // Pick the bundle file most useful for "share to SNS" actions: latest
  // developed JPG → in-camera JPG → first RAW. Shared between Reveal in
  // Explorer and Copy to Clipboard so they target the same file.
  const pickShareableFile = useCallback(() => {
    if (!activeBundle) return null;
    const developed = activeBundle.files
      .filter((f) => f.role === "developed")
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
    return (
      developed[0] ??
      activeBundle.files.find((f) => f.role === "jpeg") ??
      activeBundle.files.find((f) => f.role === "raw") ??
      activeBundle.files[0] ??
      null
    );
  }, [activeBundle]);

  const revealActiveBundleInFileManager = useCallback(async () => {
    if (!index) return;
    const target = pickShareableFile();
    if (!target) return;
    try {
      await revealItemInDir(joinPath(index.folder_path, target.path));
    } catch (e: unknown) {
      setError(toMessage(e));
    }
  }, [index, pickShareableFile]);

  const copyActiveBundleImageToClipboard = useCallback(async () => {
    if (!index) return;
    const target = pickShareableFile();
    if (!target) return;
    try {
      await invoke("copy_image_to_clipboard", {
        path: joinPath(index.folder_path, target.path),
      });
      setToast("✓ クリップボードにコピーしました");
    } catch (e: unknown) {
      setError(toMessage(e));
    }
  }, [index, pickShareableFile]);

  const openActive = useCallback(
    async (role: "raw" | "jpeg" | null) => {
      if (!index) return;

      if (role === "raw") {
        // Collect every selected bundle's RAW. The custom developer the user
        // is building is expected to accept multi-file invocation, so this
        // is the natural way to feed it a session of picks at once. Falls
        // back to a single bundle when nothing is selected (active only).
        const targets =
          selectedIds.size > 0
            ? index.bundles.filter((b) => selectedIds.has(b.bundle_id))
            : activeBundle
              ? [activeBundle]
              : [];
        const paths: string[] = [];
        for (const b of targets) {
          const raw = b.files.find((f) => f.role === "raw");
          if (raw) paths.push(joinPath(index.folder_path, raw.path));
        }
        if (paths.length === 0) return;
        try {
          await invoke("open_with_raw_developer", { paths });
        } catch (e: unknown) {
          setError(toMessage(e));
        }
        return;
      }

      // Non-RAW (JPG / unspecified) stays single-target — opening dozens of
      // files through the OS default handler floods the desktop with viewers.
      if (!activeBundle) return;
      const file = role
        ? activeBundle.files.find((f) => f.role === role)
        : activeBundle.files[0];
      if (!file) return;
      const path = joinPath(index.folder_path, file.path);
      try {
        await invoke("open_path", { path });
      } catch (e: unknown) {
        setError(toMessage(e));
      }
    },
    [activeBundle, index, selectedIds],
  );

  const selectAll = useCallback(() => {
    if (filteredBundles.length === 0) return;
    setSelectedIds(new Set(filteredBundles.map((b) => b.bundle_id)));
    if (!activeId) {
      setActiveId(filteredBundles[0].bundle_id);
      setAnchorId(filteredBundles[0].bundle_id);
    }
  }, [activeId, filteredBundles]);

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
          setFullscreenMode((m) => !m);
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
        case "ArrowUp":
          e.preventDefault();
          cyclePreviewVariant(-1);
          break;
        case "ArrowDown":
          e.preventDefault();
          cyclePreviewVariant(1);
          break;
        case "Escape":
          e.preventDefault();
          // Exit fullscreen first (the more disruptive state); only collapse
          // selection on a second press.
          if (fullscreenMode) {
            setFullscreenMode(false);
          } else {
            collapseToActive();
          }
          break;
        case "Delete":
          e.preventDefault();
          if (e.shiftKey) {
            // Shift+Delete is the variant-only path so a slip of the finger
            // doesn't trash the entire bundle.
            trashCurrentVariant();
          } else {
            void deleteSelected();
          }
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
        case "r":
        case "R":
          e.preventDefault();
          if (e.shiftKey) {
            void cycleRawDeveloper();
          } else {
            void openActive("raw");
          }
          break;
        case "Enter":
          if (activeBundle && !addingPost && !busy) {
            e.preventDefault();
            setAddingPost(true);
          }
          break;
        case "0":
          e.preventDefault();
          void setRatingForSelection(null);
          break;
        case "1":
        case "2":
        case "3":
        case "4":
        case "5":
          e.preventDefault();
          void setRatingForSelection(parseInt(e.key, 10));
          break;
        // Pick/Reject flags are now driven exclusively by gallery feedback
        // (FAV → pick, NG → reject) — local P/X toggles were removed so a
        // photographer keystroke can't silently overwrite a model's vote.
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
    fullscreenMode,
    cycleRawDeveloper,
    cyclePreviewVariant,
    trashCurrentVariant,
    setRatingForSelection,
  ]);

  const selectedDevelopedCount = useMemo(() => {
    if (!index || selectedIds.size === 0) return 0;
    let n = 0;
    for (const b of index.bundles) {
      if (!selectedIds.has(b.bundle_id)) continue;
      n += b.files.filter((f) => f.role === "developed").length;
    }
    return n;
  }, [index, selectedIds]);

  const totalFiles = index?.bundles.reduce((n, b) => n + b.files.length, 0) ?? 0;
  const readyCount = Object.values(thumbs).filter((t) => t.kind === "ready").length;
  const pendingCount = Object.values(thumbs).filter((t) => t.kind === "loading").length;

  return (
    <main className={`app${fullscreenMode ? " fullscreen" : ""}`}>
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
        <button
          type="button"
          className="topbar-icon"
          onClick={fetchFeedbackForCurrentFolder}
          disabled={!index || feedbackBusy}
          title="現在のフォルダ向けのフィードバックを取り込み"
        >
          📥
        </button>
        <button
          type="button"
          className="topbar-icon"
          onClick={() => setShowGalleries(true)}
          title="Shared galleries"
        >
          🔗
        </button>
        <button
          type="button"
          className="topbar-icon"
          onClick={() => setShowSearch(true)}
          title="画像から逆引き（フォルダ横断 pHash 検索）"
        >
          🔍
        </button>
        <button
          type="button"
          className="topbar-icon"
          onClick={() => setShowSettings(true)}
          title="Settings"
        >
          ⚙
        </button>
      </header>

      {showWelcome && (
        <WelcomeDialog
          onDismiss={() => void dismissWelcome()}
          onOpenSettings={() => setShowSettings(true)}
        />
      )}

      {showSearch && (
        <SearchDialog
          initialRoot={appSettings.search_root ?? null}
          onClose={() => setShowSearch(false)}
          onRootSelected={async (root) => {
            const next = { ...appSettings, search_root: root };
            await invoke("save_app_settings", { settings: next });
            setAppSettings(next);
          }}
        />
      )}

      {showSettings && (
        <SettingsDialog
          initial={appSettings}
          onSave={saveSettings}
          onClose={() => setShowSettings(false)}
          busy={false}
        />
      )}

      <CheatsheetOverlay visible={showCheatsheet} />

      {toast && (
        <div className="app-toast" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}

      {isDraggingOver && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-message">
            <div className="drop-message-title">Drop to open folder</div>
            <div className="drop-message-hint">
              A file works too — opens its parent directory.
            </div>
          </div>
        </div>
      )}

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
        <div className="filter-bar">
          <span className="filter-label">Filter</span>
          {FILTER_MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={`filter-chip${filterMode === m ? " active" : ""}`}
              onClick={() => setFilterMode(m)}
            >
              {FILTER_LABELS[m]}
            </button>
          ))}
          {availableTags.length > 0 && (
            <>
              <span className="filter-sep" aria-hidden="true">
                ·
              </span>
              <span className="filter-label">Tag</span>
              <select
                className="filter-tag-select"
                value={filterTag ?? ""}
                onChange={(e) => setFilterTag(e.target.value || null)}
              >
                <option value="">Any</option>
                {availableTags.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
      )}

      {index && index.bundles.length > 0 && (
        <div className="workspace">
          <div className="grid-area">
            {filteredBundles.length === 0 ? (
              <div className="empty">No bundles match the current filter.</div>
            ) : (
              <ThumbnailGrid
                bundles={filteredBundles}
                thumbs={thumbs}
                activeId={activeId}
                selectedIds={selectedIds}
                onTileClick={handleTileClick}
                tileSize={TILE_SIZES[tileLabel]}
              />
            )}
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
              selectedDevelopedCount={selectedDevelopedCount}
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
              onSetRating={setRatingForSelection}
              onSetTags={setTagsForActive}
              currentPreviewPath={currentPreviewVariant?.path ?? null}
              onSelectPreview={selectPreviewByPath}
              onTrashVariant={trashVariant}
              onShare={() => setShowShare(true)}
              onRevealInFileManager={() => void revealActiveBundleInFileManager()}
              onCopyImageToClipboard={() => void copyActiveBundleImageToClipboard()}
              shareDisabled={
                !appSettings.gallery?.worker_url?.trim() ||
                !appSettings.gallery?.admin_token?.trim() ||
                selectedIds.size === 0
              }
            />
          </aside>
        </div>
      )}

      {showShare && index && (
        <ShareDialog
          folder={index.folder_path}
          selectedBundles={index.bundles.filter((b) =>
            selectedIds.has(b.bundle_id),
          )}
          defaultName={`${
            index.folder_path.split(/[\\/]/).filter(Boolean).pop() ?? "gallery"
          } ${new Date().toISOString().slice(0, 10)}`}
          defaultDecision={appSettings.gallery?.default_decision ?? "ok"}
          onClose={() => setShowShare(false)}
        />
      )}

      {showGalleries && (
        <GalleriesDialog
          currentFolder={index?.folder_path ?? null}
          onClose={() => setShowGalleries(false)}
          onApplyFeedback={applyGalleryFeedback}
        />
      )}

      {index && index.bundles.length > 0 && (
        <footer className="statusbar">
          {activeBundle ? (
            <>
              <span className="status-name">{activeBundle.base_name}</span>
              <span className="status-pos">
                ({activeIndex + 1}/{filteredBundles.length}
                {filteredBundles.length !== index.bundles.length
                  ? ` of ${index.bundles.length}`
                  : ""}
                )
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
          {activeVariants.length > 1 && currentPreviewVariant && (
            <span
              className="mode-tag variant"
              title="↑/↓ to cycle preview variant"
            >
              {currentPreviewVariant.path}
              {" "}
              {(activeVariants.findIndex(
                (f) => f.path === currentPreviewVariant.path,
              ) + 1)}
              /{activeVariants.length}
            </span>
          )}
          {busy && <span className="mode-tag busy">Working…</span>}
          {(appSettings.raw_developers?.length ?? 0) > 1 && activeRawDeveloper && (
            <span
              className="mode-tag raw-dev"
              title="Active RAW developer (Shift+R to cycle)"
            >
              RAW: {activeRawDeveloper.name}
            </span>
          )}
          <span className="hints">
            Click · Shift/Ctrl · Ctrl+A · Esc · ← → · Space · F · Del/M/C/O/R ·
            Enter · 0–5 · P/X
          </span>
        </footer>
      )}

      {fullscreenMode && activeBundle && index && (
        <div className="fullscreen-status">
          <span className="fs-name">{activeBundle.base_name}</span>
          <span className="fs-pos">
            {activeIndex + 1}/{filteredBundles.length}
          </span>
          <span className={`mode-tag ${previewMode}`}>
            {previewMode === "fit" ? "Fit" : "100%"}
          </span>
          {activeVariants.length > 1 && currentPreviewVariant && (
            <span className="mode-tag variant">
              {currentPreviewVariant.path}
              {" "}
              {(activeVariants.findIndex(
                (f) => f.path === currentPreviewVariant.path,
              ) + 1)}
              /{activeVariants.length}
            </span>
          )}
          {(appSettings.raw_developers?.length ?? 0) > 1 && activeRawDeveloper && (
            <span className="mode-tag raw-dev">RAW: {activeRawDeveloper.name}</span>
          )}
          <span className="fs-hint">Esc to exit</span>
        </div>
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

function postSummaryOf(sidecar: BundleSidecar): {
  has_posts: boolean;
  post_platforms: string[];
  has_model_post: boolean;
} {
  if (sidecar.posts.length === 0) {
    return { has_posts: false, post_platforms: [], has_model_post: false };
  }
  const platforms = Array.from(new Set(sidecar.posts.map((p) => p.platform))).sort();
  return {
    has_posts: true,
    post_platforms: platforms,
    has_model_post: sidecar.posts.some((p) => p.by === "model"),
  };
}

export default App;
