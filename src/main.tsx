import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Suppress webview defaults that aren't desktop-app-like.
// - Right-click anywhere except form fields → no browser context menu.
// - F5 / Ctrl+R / Ctrl+Shift+R → no full reload (would reset folder selection,
//   thumbs, gallery feedback state, etc.).
// - F12 (DevTools) is left enabled in dev builds and disabled in release.
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement | null;
  if (t?.matches?.("input, textarea, [contenteditable]")) return;
  e.preventDefault();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "F5") {
    e.preventDefault();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r") {
    e.preventDefault();
    return;
  }
  if (e.key === "F12" && import.meta.env.PROD) {
    e.preventDefault();
  }
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
