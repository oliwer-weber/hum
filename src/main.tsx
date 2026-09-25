import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyStoredTheme, applyStoredFont, applyStoredMdPlain } from "./theme/theme";
import { loadBootPrefs, loadPrefs } from "./prefs/prefs";
import "./theme/tokens.css";
import "./styles/global.css";
import "./styles/components.css";
import "./styles/vault-cards.css";
import "./styles/project-list.css";
import "./styles/sketch.css";

// Excalidraw fetches its fonts at runtime from `<EXCALIDRAW_ASSET_PATH>/fonts/...`.
// vite.config.ts copies the package's `dist/prod/fonts` to `/excalidraw/fonts`
// (dev: served by vite-plugin-static-copy, build: emitted into dist), which keeps
// the canvas fully offline. Must be set before the Excalidraw module is first
// evaluated (lazy-loaded).
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH =
  "/excalidraw/";

applyStoredTheme();
applyStoredFont();
applyStoredMdPlain();

function render() {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

// Prefs normally arrive with the page (injected at launch), so the first render
// doesn't wait on IPC. Outside the Tauri window, fetch them first.
if (loadBootPrefs()) render();
else loadPrefs().finally(render);
