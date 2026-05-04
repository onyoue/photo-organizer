import { memo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { BundleSummary } from "../types/bundle";
import type { ThumbState } from "../types/thumb";

interface Props {
  bundle: BundleSummary;
  thumb: ThumbState;
  active: boolean;
  selected: boolean;
  size: number;
  onClick: (e: React.MouseEvent) => void;
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

const PLATFORM_GLYPH: Record<string, string> = {
  x: "X",
  instagram: "I",
  note: "n",
  other: "?",
};

function BundleTileImpl({ bundle, thumb, active, selected, size, onClick }: Props) {
  const roles = rolesLabel(bundle);
  const className = `tile${active ? " active" : selected ? " selected" : ""}`;
  return (
    <button
      type="button"
      className={className}
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

        {(bundle.flag || bundle.rating) && (
          <div className="tile-flags">
            {bundle.flag === "pick" && (
              <span className="tile-flag fav" title="Favorite (gallery FAV)">
                ★
              </span>
            )}
            {bundle.flag === "ok" && (
              <span className="tile-flag ok" title="OK (gallery OK)">
                ✓
              </span>
            )}
            {bundle.flag === "reject" && (
              <span className="tile-flag reject" title="Rejected (gallery NG)">
                ✕
              </span>
            )}
            {bundle.rating ? (
              <span className="tile-rating" title={`${bundle.rating} stars`}>
                {"★".repeat(bundle.rating)}
              </span>
            ) : null}
          </div>
        )}

        {(bundle.has_posts || bundle.has_model_post) && (
          <div className="tile-overlay">
            {bundle.post_platforms.map((p) => (
              <span
                key={p}
                className={`tile-overlay-badge plat-${p}`}
                title={`Posted on ${p}`}
              >
                {PLATFORM_GLYPH[p] ?? "?"}
              </span>
            ))}
            {bundle.has_model_post && (
              <span
                className="tile-overlay-badge model"
                title="Includes a model-side post"
              >
                M
              </span>
            )}
          </div>
        )}
      </div>
      <div className="tile-caption">
        <div className="tile-name">{bundle.base_name}</div>
        <div className="tile-roles">{roles}</div>
      </div>
    </button>
  );
}

export const BundleTile = memo(BundleTileImpl);
