import type { BundleSummary } from "../types/bundle";
import type { BundleSidecar, PostRecord } from "../types/sidecar";
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
  onShare: () => void;
  /** When true the Share button is disabled (gallery not configured). */
  shareDisabled: boolean;
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

  onSetTags: (tags: string[]) => void;

  /** Path of the file currently shown in the preview pane, or null. */
  currentPreviewPath: string | null;
  /** Pick a JPG/Developed file as the preview source. */
  onSelectPreview: (path: string) => void;
  /** Trash a single JPG/Developed variant (with confirmation). */
  onTrashVariant: (path: string) => void;
}

const RENDERABLE_IMAGE_RE = /\.(jpe?g|png)$/i;

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
  onShare,
  shareDisabled,
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
  onSetTags,
  currentPreviewPath,
  onSelectPreview,
  onTrashVariant,
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
        <button
          type="button"
          onClick={onShare}
          disabled={busy || shareDisabled}
          title={
            shareDisabled
              ? "Configure gallery worker in Settings to enable sharing"
              : "Upload selected developed JPG/PNGs to a shareable gallery"
          }
        >
          Share…{suffix(selectedCount)}
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
        {bundle.flag && (
          <div
            className={`flag-readout flag-${bundle.flag}`}
            role="status"
            aria-label="Flag (model feedback)"
            title="Flags come from gallery feedback — FAV → pick, NG → reject"
          >
            {bundle.flag === "pick" ? "✓ Pick" : "✕ Reject"}
          </div>
        )}
      </div>

      <ul className="detail-files">
        {bundle.files.map((f) => {
          const renderable =
            (f.role === "developed" || f.role === "jpeg") &&
            RENDERABLE_IMAGE_RE.test(f.path);
          const isCurrent = currentPreviewPath === f.path;
          return (
            <li
              key={f.path}
              className={`file role-${f.role}${
                renderable ? " selectable-preview" : ""
              }${isCurrent ? " current-preview" : ""}`}
              onClick={renderable ? () => onSelectPreview(f.path) : undefined}
              title={renderable ? "Click to preview" : f.path}
            >
              <span className="role-tag">{f.role}</span>
              <span className="file-path">{f.path}</span>
              <span className="file-size">{formatSize(f.size)}</span>
              {renderable ? (
                <button
                  type="button"
                  className="file-trash"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTrashVariant(f.path);
                  }}
                  disabled={busy}
                  title="Trash this variant only"
                >
                  ×
                </button>
              ) : (
                <span className="file-trash-placeholder" />
              )}
            </li>
          );
        })}
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
