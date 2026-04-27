import type { BundleSummary } from "../types/bundle";
import type { BundleSidecar, PostRecord } from "../types/sidecar";
import { formatSize } from "../utils/format";
import { PostsSection } from "./PostsSection";

interface Props {
  bundle: BundleSummary | null;
  selectedCount: number;
  onDelete: () => void;
  onMove: () => void;
  onCopy: () => void;
  onOpen: (role: "raw" | "jpeg" | null) => void;
  busy: boolean;

  sidecar: BundleSidecar | null;
  sidecarLoading: boolean;
  addingPost: boolean;
  onStartAddPost: () => void;
  onCancelAddPost: () => void;
  onSavePost: (post: Omit<PostRecord, "id">) => void;
  onDeletePost: (id: string) => void;
  onOpenUrl: (url: string) => void;
}

function suffix(n: number): string {
  return n > 1 ? ` (${n})` : "";
}

export function DetailPanel({
  bundle,
  selectedCount,
  onDelete,
  onMove,
  onCopy,
  onOpen,
  busy,
  sidecar,
  sidecarLoading,
  addingPost,
  onStartAddPost,
  onCancelAddPost,
  onSavePost,
  onDeletePost,
  onOpenUrl,
}: Props) {
  if (!bundle) {
    return <div className="detail-panel empty">No bundle selected</div>;
  }

  const hasRaw = bundle.files.some((f) => f.role === "raw");
  const hasJpeg = bundle.files.some((f) => f.role === "jpeg");
  const multi = selectedCount > 1;

  return (
    <div className="detail-panel">
      <div className="detail-name">
        {bundle.base_name}
        {multi && <span className="detail-sub"> · {selectedCount - 1} more selected</span>}
      </div>

      <div className="detail-actions">
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          title="Delete (move to trash) — Delete"
        >
          Delete{suffix(selectedCount)}
        </button>
        <button type="button" onClick={onMove} disabled={busy} title="Move to folder — M">
          Move…{suffix(selectedCount)}
        </button>
        <button type="button" onClick={onCopy} disabled={busy} title="Copy to folder — C">
          Copy…{suffix(selectedCount)}
        </button>
        <button
          type="button"
          onClick={() => onOpen("jpeg")}
          disabled={busy || !hasJpeg}
          title="Open active bundle's JPG in default app — O"
        >
          Open JPG
        </button>
        <button
          type="button"
          onClick={() => onOpen("raw")}
          disabled={busy || !hasRaw}
          title="Open active bundle's RAW in default app"
        >
          Open RAW
        </button>
      </div>

      <ul className="detail-files">
        {bundle.files.map((f) => (
          <li key={f.path} className={`file role-${f.role}`}>
            <span className="role-tag">{f.role}</span>
            <span className="file-path" title={f.path}>
              {f.path}
            </span>
            <span className="file-size">{formatSize(f.size)}</span>
          </li>
        ))}
      </ul>

      <PostsSection
        sidecar={sidecar}
        loading={sidecarLoading}
        adding={addingPost}
        busy={busy}
        onStartAdd={onStartAddPost}
        onCancelAdd={onCancelAddPost}
        onSavePost={onSavePost}
        onDeletePost={onDeletePost}
        onOpenUrl={onOpenUrl}
      />
    </div>
  );
}
