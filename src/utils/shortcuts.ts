export interface ShortcutItem {
  keys: string;
  description: string;
}

export interface ShortcutGroup {
  title: string;
  items: ShortcutItem[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Selection",
    items: [
      { keys: "Click", description: "Single select" },
      { keys: "Ctrl/Cmd + Click", description: "Toggle one" },
      { keys: "Shift + Click", description: "Range from anchor" },
      { keys: "← / →", description: "Prev / next bundle" },
      { keys: "Shift + ← / →", description: "Extend selection" },
      { keys: "Ctrl/Cmd + A", description: "Select all (visible)" },
      { keys: "Esc", description: "Exit fullscreen / collapse to active" },
    ],
  },
  {
    title: "View",
    items: [
      { keys: "Space", description: "Toggle fullscreen photo (no chrome)" },
      { keys: "F", description: "Fit ↔ 100% preview" },
      { keys: "F1", description: "Hold for this cheatsheet" },
    ],
  },
  {
    title: "File ops",
    items: [
      { keys: "Delete", description: "Move to trash" },
      { keys: "M", description: "Move to folder…" },
      { keys: "C", description: "Copy to folder…" },
      { keys: "O", description: "Open JPG in default app" },
    ],
  },
  {
    title: "Metadata",
    items: [
      { keys: "Enter", description: "Add post" },
      { keys: "0", description: "Clear rating" },
      { keys: "1 – 5", description: "Set rating" },
      { keys: "P", description: "Toggle pick" },
      { keys: "X", description: "Toggle reject" },
    ],
  },
];
