import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { AppSettings, RawDeveloperEntry } from "../types/settings";

interface Props {
  initial: AppSettings;
  onSave: (next: AppSettings) => Promise<void>;
  onClose: () => void;
  busy: boolean;
}

function clampActive(devs: RawDeveloperEntry[], desired: number): number {
  if (devs.length === 0) return 0;
  if (desired < 0) return 0;
  if (desired >= devs.length) return devs.length - 1;
  return desired;
}

export function SettingsDialog({ initial, onSave, onClose, busy }: Props) {
  const [devs, setDevs] = useState<RawDeveloperEntry[]>(
    initial.raw_developers && initial.raw_developers.length > 0
      ? initial.raw_developers
      : [],
  );
  const [active, setActive] = useState<number>(
    initial.active_raw_developer_index ?? 0,
  );
  const [error, setError] = useState<string | null>(null);

  function updateAt(i: number, patch: Partial<RawDeveloperEntry>) {
    setDevs((prev) =>
      prev.map((d, idx) => (idx === i ? { ...d, ...patch } : d)),
    );
  }

  function addEntry() {
    setDevs((prev) => [...prev, { name: "", path: "" }]);
  }

  function removeAt(i: number) {
    setDevs((prev) => {
      const next = prev.filter((_, idx) => idx !== i);
      setActive((a) => clampActive(next, a >= i ? a - 1 : a));
      return next;
    });
  }

  async function browseAt(i: number) {
    setError(null);
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        filters: [
          { name: "Executable", extensions: ["exe"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      if (typeof picked === "string") {
        updateAt(i, { path: picked });
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function save() {
    // Trim and drop entries whose path is empty — a name without a path
    // would just fall through to the OS default and confuse the indicator.
    const cleaned = devs
      .map((d) => ({ name: d.name.trim(), path: d.path.trim() }))
      .filter((d) => d.path.length > 0)
      .map((d) => ({
        name: d.name || "RAW developer",
        path: d.path,
      }));

    const next: AppSettings = {
      raw_developers: cleaned,
      active_raw_developer_index: clampActive(cleaned, active),
    };
    try {
      await onSave(next);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div
        className="settings-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Settings"
      >
        <div className="settings-header">
          <span className="settings-title">Settings</span>
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            disabled={busy}
            title="Close"
          >
            ×
          </button>
        </div>

        <div className="settings-body">
          <div className="settings-field">
            <label>RAW developers (Open RAW / R)</label>
            <p className="settings-hint">
              Register one or more apps. The selected radio is the one R
              opens; Shift+R cycles through them. Empty path falls back to the
              OS default handler.
            </p>
            <div className="raw-dev-list">
              {devs.map((d, i) => (
                <div key={i} className="raw-dev-row">
                  <input
                    type="radio"
                    name="active-raw-dev"
                    checked={active === i}
                    onChange={() => setActive(i)}
                    disabled={busy}
                    title="Set as active"
                  />
                  <input
                    type="text"
                    className="raw-dev-name"
                    value={d.name}
                    onChange={(e) => updateAt(i, { name: e.target.value })}
                    placeholder="Name"
                    disabled={busy}
                  />
                  <input
                    type="text"
                    className="raw-dev-path"
                    value={d.path}
                    onChange={(e) => updateAt(i, { path: e.target.value })}
                    placeholder="C:\\path\\to\\rawdev.exe"
                    disabled={busy}
                  />
                  <button
                    type="button"
                    onClick={() => browseAt(i)}
                    disabled={busy}
                  >
                    Browse…
                  </button>
                  <button
                    type="button"
                    className="raw-dev-remove"
                    onClick={() => removeAt(i)}
                    disabled={busy}
                    title="Remove this entry"
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="raw-dev-add"
                onClick={addEntry}
                disabled={busy}
              >
                + Add developer
              </button>
            </div>
          </div>
        </div>

        {error && <div className="settings-error">Error: {error}</div>}

        <div className="settings-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={save} disabled={busy}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
