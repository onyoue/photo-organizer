import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { BundleRef, BundleSummary, FolderIndex } from "./types/bundle";
import type { ThumbMap, ThumbnailReadyEvent, ThumbnailRequest } from "./types/thumb";
import type { PixelOffset, PreviewMode } from "./types/preview";
import type { BundleSidecar, Flag, PostRecord } from "./types/sidecar";
import type { AppSettings } from "./types/settings";
import { generatePostId } from "./components/PostsSection";
import { SettingsDialog } from "./components/SettingsDialog";
import { CheatsheetOverlay } from "./components/CheatsheetOverlay";
import { ThumbnailGrid } from "./components/ThumbnailGrid";
import { PreviewPane } from "./components/PreviewPane";
import { DetailPanel } from "./components/DetailPanel";
import { joinPath } from "./utils/path";
import { selectPreviewFile, selectThumbnailSource } from "./utils/preview";
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

  const [appSettings, setAppSettings] = useState<AppSettings>({
    raw_developers: [],
    active_raw_developer_index: 0,
  });
  const [showSettings, setShowSettings] = useState(false);
  const [showCheatsheet, setShowCheatsheet] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

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
    void invoke<AppSettings>("get_app_settings").then((s) => setAppSettings(s));
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

  const previewSrc = useMemo(() => {
    if (!activeBundle || !index) return null;
    const file = selectPreviewFile(activeBundle);
    if (!file) return null;
    return joinPath(index.folder_path, file);
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

  const toggleFlagForSelection = useCallback(
    async (target: Flag) => {
      if (!index || selectedIds.size === 0 || busy) return;
      // Toggle decision pivots on the active bundle: if it's already flagged
      // with `target`, we clear; otherwise we set everyone to `target`.
      // Mirrors Lightroom's P/X behaviour.
      const newFlag: Flag | null =
        activeBundle?.flag === target ? null : target;
      const refs = selectedBundleRefs();
      if (refs.length === 0) return;
      try {
        await invoke("set_bundle_flag", {
          folder: index.folder_path,
          bundles: refs,
          flag: newFlag,
        });
        const flagValue = newFlag ?? undefined;
        setIndex((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            bundles: prev.bundles.map((b) =>
              selectedIds.has(b.bundle_id) ? { ...b, flag: flagValue } : b,
            ),
          };
        });
        if (activeBundle && selectedIds.has(activeBundle.bundle_id)) {
          setActiveSidecar((prev) =>
            prev
              ? {
                  ...prev,
                  flag: flagValue,
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

  const handleOpenUrl = useCallback(async (url: string) => {
    try {
      await openUrl(url);
    } catch (e: unknown) {
      setError(toMessage(e));
    }
  }, []);

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
        case "p":
        case "P":
          e.preventDefault();
          void toggleFlagForSelection("pick");
          break;
        case "x":
        case "X":
          e.preventDefault();
          void toggleFlagForSelection("reject");
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
    fullscreenMode,
    cycleRawDeveloper,
    setRatingForSelection,
    toggleFlagForSelection,
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
          onClick={() => setShowSettings(true)}
          title="Settings"
        >
          ⚙
        </button>
      </header>

      {showSettings && (
        <SettingsDialog
          initial={appSettings}
          onSave={saveSettings}
          onClose={() => setShowSettings(false)}
          busy={false}
        />
      )}

      <CheatsheetOverlay visible={showCheatsheet} />

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
              onToggleFlag={toggleFlagForSelection}
              onSetTags={setTagsForActive}
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
