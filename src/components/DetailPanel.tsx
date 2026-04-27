import type { BundleSummary } from "../types/bundle";
import { formatSize } from "../utils/format";

interface Props {
  bundle: BundleSummary | null;
  onDelete: () => void;
  onMove: () => void;
  onCopy: () => void;
  onOpen: (role: "raw" | "jpeg" | null) => void;
  busy: boolean;
}

export function DetailPanel({ bundle, onDelete, onMove, onCopy, onOpen, busy }: Props) {
  if (!bundle) {
    return <div className="detail-panel empty">No bundle selected</div>;
  }

  const hasRaw = bundle.files.some((f) => f.role === "raw");
  const hasJpeg = bundle.files.some((f) => f.role === "jpeg");

  return (
    <div className="detail-panel">
      <div className="detail-name">{bundle.base_name}</div>

      <div className="detail-actions">
        <button type="button" onClick={onDelete} disabled={busy} title="Delete (move to trash) — Delete">
          Delete
        </button>
        <button type="button" onClick={onMove} disabled={busy} title="Move to folder — M">
          Move…
        </button>
        <button type="button" onClick={onCopy} disabled={busy} title="Copy to folder — C">
          Copy…
        </button>
        <button
          type="button"
          onClick={() => onOpen("jpeg")}
          disabled={busy || !hasJpeg}
          title="Open JPG in default app — O"
        >
          Open JPG
        </button>
        <button
          type="button"
          onClick={() => onOpen("raw")}
          disabled={busy || !hasRaw}
          title="Open RAW in default app"
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
    </div>
  );
}
