import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { AppSettings } from "../types/settings";

interface Props {
  initial: AppSettings;
  onSave: (next: AppSettings) => Promise<void>;
  onClose: () => void;
  busy: boolean;
}

export function SettingsDialog({ initial, onSave, onClose, busy }: Props) {
  const [rawPath, setRawPath] = useState(initial.raw_developer_path ?? "");
  const [error, setError] = useState<string | null>(null);

  async function browse() {
    setError(null);
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        // Windows uses .exe; macOS .app bundles aren't files in the dialog
        // sense, so leave the filter loose. Linux has no extension convention.
        filters: [
          { name: "Executable", extensions: ["exe"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      if (typeof picked === "string") {
        setRawPath(picked);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function save() {
    const next: AppSettings = {
      raw_developer_path: rawPath.trim() ? rawPath.trim() : undefined,
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
            <label htmlFor="raw-dev-path">RAW developer (Open RAW)</label>
            <div className="settings-row">
              <input
                id="raw-dev-path"
                type="text"
                value={rawPath}
                onChange={(e) => setRawPath(e.target.value)}
                placeholder="Falls back to OS default if empty"
                disabled={busy}
              />
              <button type="button" onClick={browse} disabled={busy}>
                Browse…
              </button>
            </div>
            <p className="settings-hint">
              Path to the executable that should open RAW files. Leave empty to
              use the OS default handler.
            </p>
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
