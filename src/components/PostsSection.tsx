import { useState } from "react";
import { ulid } from "ulid";
import {
  PLATFORM_LABELS,
  POST_BY_LABELS,
  type BundleSidecar,
  type Platform,
  type PostBy,
  type PostRecord,
} from "../types/sidecar";

interface Props {
  sidecar: BundleSidecar | null;
  loading: boolean;
  adding: boolean;
  busy: boolean;
  onStartAdd: () => void;
  onCancelAdd: () => void;
  onSavePost: (post: Omit<PostRecord, "id">) => void;
  onDeletePost: (id: string) => void;
}

export function PostsSection({
  sidecar,
  loading,
  adding,
  busy,
  onStartAdd,
  onCancelAdd,
  onSavePost,
  onDeletePost,
}: Props) {
  const posts = sidecar?.posts ?? [];

  return (
    <section className="posts-section">
      <div className="posts-header">
        <span className="posts-title">Posts ({posts.length})</span>
        {!adding && (
          <button
            type="button"
            className="posts-add"
            onClick={onStartAdd}
            disabled={busy || loading}
            title="Add post — Enter"
          >
            + Add post
          </button>
        )}
      </div>

      {loading && <div className="posts-loading">Loading…</div>}

      {adding && <AddPostForm onSave={onSavePost} onCancel={onCancelAdd} busy={busy} />}

      {!loading && posts.length === 0 && !adding && (
        <div className="posts-empty">No posts recorded yet.</div>
      )}

      {posts.length > 0 && (
        <ul className="posts-list">
          {posts.map((p) => (
            <li key={p.id} className={`post-item by-${p.by}`}>
              <div className="post-line">
                <span className={`post-platform plat-${p.platform}`}>
                  {PLATFORM_LABELS[p.platform]}
                </span>
                <span className="post-url" title={p.url}>
                  {p.url}
                </span>
                <button
                  type="button"
                  className="post-delete"
                  onClick={() => onDeletePost(p.id)}
                  disabled={busy}
                  title="Delete post"
                >
                  ×
                </button>
              </div>
              <div className="post-meta">
                <span className={`post-by by-${p.by}`}>
                  {POST_BY_LABELS[p.by]}
                  {p.by === "model" && p.posted_by_handle ? ` ${p.posted_by_handle}` : ""}
                </span>
                {p.note && <span className="post-note">{p.note}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface FormProps {
  onSave: (post: Omit<PostRecord, "id">) => void;
  onCancel: () => void;
  busy: boolean;
}

function AddPostForm({ onSave, onCancel, busy }: FormProps) {
  const [platform, setPlatform] = useState<Platform>("x");
  const [url, setUrl] = useState("");
  const [by, setBy] = useState<PostBy>("self");
  const [handle, setHandle] = useState("");
  const [note, setNote] = useState("");

  const trimmedUrl = url.trim();
  const valid = trimmedUrl.length > 0;

  function submit() {
    if (!valid) return;
    const post: Omit<PostRecord, "id"> = {
      platform,
      url: trimmedUrl,
      by,
      posted_by_handle: by === "model" && handle.trim() ? handle.trim() : undefined,
      note: note.trim() || undefined,
    };
    onSave(post);
  }

  return (
    <form
      className="post-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="post-form-row">
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value as Platform)}
          disabled={busy}
        >
          <option value="x">X</option>
          <option value="instagram">Instagram</option>
          <option value="note">note</option>
          <option value="other">Other</option>
        </select>
        <input
          type="url"
          placeholder="https://…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          autoFocus
          disabled={busy}
        />
      </div>

      <div className="post-form-row post-by-row">
        {(Object.keys(POST_BY_LABELS) as PostBy[]).map((b) => (
          <label key={b} className="post-by-radio">
            <input
              type="radio"
              checked={by === b}
              onChange={() => setBy(b)}
              disabled={busy}
            />
            {POST_BY_LABELS[b]}
          </label>
        ))}
      </div>

      {by === "model" && (
        <div className="post-form-row">
          <input
            type="text"
            placeholder="@handle (optional)"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            disabled={busy}
          />
        </div>
      )}

      <div className="post-form-row">
        <input
          type="text"
          placeholder="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
        />
      </div>

      <div className="post-form-actions">
        <button type="submit" disabled={!valid || busy}>
          Save
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function generatePostId(): string {
  return ulid();
}
