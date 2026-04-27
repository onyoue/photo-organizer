import { memo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { BundleSummary } from "../types/bundle";
import type { ThumbState } from "../types/thumb";

interface Props {
  bundle: BundleSummary;
  thumb: ThumbState;
  selected: boolean;
  size: number;
  onClick: () => void;
}

function rolesLabel(b: BundleSummary): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of b.files) {
    const r = f.role === "jpeg" ? "JPG" : f.role.toUpperCase();
    if (!seen.has(r)) {
      seen.add(r);
      out.push(r);
    }
  }
  return out.join(" + ");
}

function BundleTileImpl({ bundle, thumb, selected, size, onClick }: Props) {
  const roles = rolesLabel(bundle);
  return (
    <button
      type="button"
      className={`tile${selected ? " selected" : ""}`}
      onClick={onClick}
      title={`${bundle.base_name}\n${roles}`}
      style={{ width: size }}
    >
      <div className="tile-thumb" style={{ height: size }}>
        {thumb.kind === "ready" && (
          <img src={convertFileSrc(thumb.path)} alt={bundle.base_name} loading="lazy" />
        )}
        {thumb.kind === "loading" && <div className="tile-spinner" />}
        {thumb.kind === "error" && <div className="tile-status err">!</div>}
        {thumb.kind === "none" && <div className="tile-status">—</div>}
      </div>
      <div className="tile-caption">
        <div className="tile-name">{bundle.base_name}</div>
        <div className="tile-roles">{roles}</div>
      </div>
    </button>
  );
}

export const BundleTile = memo(BundleTileImpl);
