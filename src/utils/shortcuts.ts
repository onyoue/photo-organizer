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
      { keys: "↑ / ↓", description: "Cycle preview variant within bundle" },
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
      { keys: "Shift + Delete", description: "Trash current preview variant only" },
      { keys: "M", description: "Move to folder…" },
      { keys: "C", description: "Copy to folder…" },
      { keys: "Ctrl/Cmd + C", description: "Copy image to clipboard" },
      { keys: "O", description: "Open JPG in default app" },
      { keys: "R", description: "Open RAW in configured developer" },
      { keys: "Shift + R", description: "Cycle active RAW developer" },
    ],
  },
  {
    title: "Metadata",
    items: [
      { keys: "Enter", description: "Add post" },
      { keys: "0", description: "Clear rating" },
      { keys: "1 – 5", description: "Set rating" },
    ],
  },
];
