import type { BundleSummary } from "../types/bundle";
import type { BundleSidecar, Flag, PostRecord } from "../types/sidecar";
import { formatSize } from "../utils/format";
import { PostsSection } from "./PostsSection";
import { TagsSection } from "./TagsSection";

type OpScope = "all" | "developed";

interface Props {
  bundle: BundleSummary | null;
  selectedCount: number;
  selectedDevelopedCount: number;
  onDelete: () => void;
  onMove: (scope?: OpScope) => void;
  onCopy: (scope?: OpScope) => void;
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

  onSetRating: (rating: number | null) => void;
  onToggleFlag: (target: Flag) => void;

  onSetTags: (tags: string[]) => void;
}

function suffix(n: number): string {
  return n > 1 ? ` (${n})` : "";
}

export function DetailPanel({
  bundle,
  selectedCount,
  selectedDevelopedCount,
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
  onSetRating,
  onToggleFlag,
  onSetTags,
}: Props) {
  if (!bundle) {
    return <div className="detail-panel empty">No bundle selected</div>;
  }

  const hasRaw = bundle.files.some((f) => f.role === "raw");
  const hasJpeg = bundle.files.some((f) => f.role === "jpeg");
  const multi = selectedCount > 1;
  const rawSuffix = multi ? ` (up to ${selectedCount})` : "";
  const devSuffix = selectedDevelopedCount > 0 ? ` (${selectedDevelopedCount})` : "";

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
        <button
          type="button"
          onClick={() => onMove("all")}
          disabled={busy}
          title="Move all selected bundle files to a folder — M"
        >
          Move…{suffix(selectedCount)}
        </button>
        <button
          type="button"
          onClick={() => onCopy("all")}
          disabled={busy}
          title="Copy all selected bundle files to a folder — C"
        >
          Copy…{suffix(selectedCount)}
        </button>
        <button
          type="button"
          onClick={() => onMove("developed")}
          disabled={busy || selectedDevelopedCount === 0}
          title="Move only developed-variant JPGs out (e.g. into delivery/)"
        >
          Move dev{devSuffix}
        </button>
        <button
          type="button"
          onClick={() => onCopy("developed")}
          disabled={busy || selectedDevelopedCount === 0}
          title="Copy only developed-variant JPGs (typical for delivery upload)"
        >
          Copy dev{devSuffix}
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
          title={
            multi
              ? `Open every selected bundle's RAW in the configured developer (up to ${selectedCount}) — R`
              : "Open RAW in the configured developer — R"
          }
        >
          Open RAW{rawSuffix}
        </button>
      </div>

      <div className="rating-flag-row">
        <div className="rating-stars" role="group" aria-label="Rating">
          {[1, 2, 3, 4, 5].map((n) => {
            const filled = (bundle.rating ?? 0) >= n;
            return (
              <button
                type="button"
                key={n}
                className={`star${filled ? " filled" : ""}`}
                onClick={() => onSetRating((bundle.rating ?? 0) === n ? null : n)}
                disabled={busy}
                title={`Rate ${n} — press ${n}`}
              >
                ★
              </button>
            );
          })}
          <button
            type="button"
            className="star-clear"
            onClick={() => onSetRating(null)}
            disabled={busy || bundle.rating === undefined}
            title="Clear rating — press 0"
          >
            ×
          </button>
        </div>
        <div className="flag-toggles" role="group" aria-label="Flag">
          <button
            type="button"
            className={`flag-btn pick${bundle.flag === "pick" ? " active" : ""}`}
            onClick={() => onToggleFlag("pick")}
            disabled={busy}
            title="Toggle pick — press P"
          >
            ✓ Pick
          </button>
          <button
            type="button"
            className={`flag-btn reject${bundle.flag === "reject" ? " active" : ""}`}
            onClick={() => onToggleFlag("reject")}
            disabled={busy}
            title="Toggle reject — press X"
          >
            ✕ Reject
          </button>
        </div>
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

      <TagsSection
        tags={bundle.tags ?? []}
        busy={busy}
        onSetTags={onSetTags}
      />

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
