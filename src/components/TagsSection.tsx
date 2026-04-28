import { useState } from "react";
import { appendTag, removeTag } from "../utils/tags";

interface Props {
  tags: readonly string[];
  busy: boolean;
  onSetTags: (next: string[]) => void;
}

export function TagsSection({ tags, busy, onSetTags }: Props) {
  const [input, setInput] = useState("");

  function commit() {
    const next = appendTag(input, tags);
    setInput("");
    if (next) onSetTags(next);
  }

  function deleteTag(t: string) {
    onSetTags(removeTag(t, tags));
  }

  return (
    <section className="tags-section">
      <div className="posts-header">
        <span className="posts-title">Tags ({tags.length})</span>
      </div>
      <div className="tags-list">
        {tags.map((t) => (
          <span key={t} className="tag-chip">
            <span className="tag-chip-text">{t}</span>
            <button
              type="button"
              className="tag-chip-x"
              onClick={() => deleteTag(t)}
              disabled={busy}
              title={`Remove ${t}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          className="tag-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
          onBlur={commit}
          placeholder="Add tag…"
          disabled={busy}
        />
      </div>
    </section>
  );
}
