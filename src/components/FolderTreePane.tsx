import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FolderEntry } from "../types/folderTree";
import {
  ancestorPaths,
  isPathWithin,
  isSamePath,
  pathLabel,
} from "../utils/path";

interface FolderTreePaneProps {
  rootPath: string;
  currentPath: string | null;
  loading: boolean;
  onOpenFolder: (path: string) => void;
  onChooseRoot: () => void;
  onHide: () => void;
}

interface NodeState {
  children?: FolderEntry[];
  loading: boolean;
  error?: string;
}

export function FolderTreePane({
  rootPath,
  currentPath,
  loading,
  onOpenFolder,
  onChooseRoot,
  onHide,
}: FolderTreePaneProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set([rootPath]),
  );
  const [nodes, setNodes] = useState<Record<string, NodeState>>({});
  const requestedRef = useRef<Set<string>>(new Set());

  const loadChildren = useCallback(async (path: string) => {
    if (requestedRef.current.has(path)) return;
    requestedRef.current.add(path);
    setNodes((prev) => {
      const node = prev[path] ?? { loading: false };
      return {
        ...prev,
        [path]: { ...node, loading: true, error: undefined },
      };
    });

    try {
      const children = await invoke<FolderEntry[]>("list_child_folders", {
        path,
      });
      setNodes((prev) => ({
        ...prev,
        [path]: { children, loading: false },
      }));
    } catch (e: unknown) {
      requestedRef.current.delete(path);
      setNodes((prev) => ({
        ...prev,
        [path]: { loading: false, error: toMessage(e) },
      }));
    }
  }, []);

  useEffect(() => {
    requestedRef.current = new Set();
    setNodes({});
    setExpanded(new Set([rootPath]));
    void loadChildren(rootPath);
  }, [loadChildren, rootPath]);

  useEffect(() => {
    if (!currentPath || !isPathWithin(currentPath, rootPath)) return;
    const chain = ancestorPaths(rootPath, currentPath);
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const path of chain) next.add(path);
      return next;
    });
    for (const path of chain) void loadChildren(path);
  }, [currentPath, loadChildren, rootPath]);

  const toggle = useCallback(
    (path: string) => {
      if (!expanded.has(path)) void loadChildren(path);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return next;
      });
    },
    [expanded, loadChildren],
  );

  const renderNode = (entry: FolderEntry, depth: number) => {
    const node = nodes[entry.path];
    const isExpanded = expanded.has(entry.path);
    const isActive = currentPath ? isSamePath(entry.path, currentPath) : false;
    const canExpand = entry.has_children || entry.path === rootPath;
    const children = node?.children ?? [];

    return (
      <div className="folder-tree-node" key={entry.path}>
        <div
          className={`folder-tree-row${isActive ? " active" : ""}`}
          style={{ "--depth": depth } as CSSProperties}
        >
          {canExpand ? (
            <button
              type="button"
              className="folder-tree-expander"
              onClick={() => toggle(entry.path)}
              aria-expanded={isExpanded}
              title={isExpanded ? "Collapse" : "Expand"}
            >
              {isExpanded ? "v" : ">"}
            </button>
          ) : (
            <span className="folder-tree-expander placeholder" />
          )}
          <button
            type="button"
            className="folder-tree-name"
            onClick={() => {
              if (!isActive) onOpenFolder(entry.path);
            }}
            disabled={loading && !isActive}
            title={entry.path}
          >
            {entry.name || pathLabel(entry.path)}
          </button>
        </div>
        {isExpanded && node?.loading && (
          <div
            className="folder-tree-message"
            style={{ "--depth": depth + 1 } as CSSProperties}
          >
            Loading...
          </div>
        )}
        {isExpanded && node?.error && (
          <button
            type="button"
            className="folder-tree-message error-message"
            style={{ "--depth": depth + 1 } as CSSProperties}
            onClick={() => void loadChildren(entry.path)}
          >
            {node.error}
          </button>
        )}
        {isExpanded &&
          !node?.loading &&
          !node?.error &&
          children.map((child) => renderNode(child, depth + 1))}
        {isExpanded &&
          !node?.loading &&
          !node?.error &&
          node?.children &&
          children.length === 0 && (
            <div
              className="folder-tree-message muted"
              style={{ "--depth": depth + 1 } as CSSProperties}
            >
              No folders
            </div>
          )}
      </div>
    );
  };

  const root: FolderEntry = {
    name: pathLabel(rootPath),
    path: rootPath,
    has_children: true,
  };

  return (
    <aside className="folder-tree-pane" aria-label="Folders">
      <div className="folder-tree-header">
        <span className="folder-tree-title">Folders</span>
        <div className="folder-tree-actions">
          <button type="button" onClick={onChooseRoot} title="Choose root folder">
            +
          </button>
          <button type="button" onClick={onHide} title="Hide folders">
            x
          </button>
        </div>
      </div>
      <div className="folder-tree-list">{renderNode(root, 0)}</div>
    </aside>
  );
}

function toMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
