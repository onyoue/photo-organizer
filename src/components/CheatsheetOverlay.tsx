import { SHORTCUT_GROUPS } from "../utils/shortcuts";

interface Props {
  visible: boolean;
}

export function CheatsheetOverlay({ visible }: Props) {
  if (!visible) return null;
  return (
    <div className="cheatsheet-backdrop" aria-hidden="true">
      <div className="cheatsheet" role="dialog" aria-label="Keyboard shortcuts">
        <div className="cheatsheet-header">
          <span className="cheatsheet-title">Keyboard shortcuts</span>
          <span className="cheatsheet-hint">Release F1 to dismiss</span>
        </div>
        <div className="cheatsheet-grid">
          {SHORTCUT_GROUPS.map((g) => (
            <section key={g.title} className="cheatsheet-group">
              <h3>{g.title}</h3>
              <dl>
                {g.items.map((i) => (
                  <div key={i.keys} className="cheatsheet-row">
                    <dt>
                      <kbd>{i.keys}</kbd>
                    </dt>
                    <dd>{i.description}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
