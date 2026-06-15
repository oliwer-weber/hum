import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyStoredTheme, applyStoredFont, applyStoredMdPlain } from "./theme/theme";
import { loadPrefs } from "./prefs/prefs";
import "./theme/tokens.css";
import "./styles/global.css";
import "./styles/components.css";
import "./styles/vault-cards.css";
import "./styles/project-list.css";
import "./styles/sketch.css";

// Excalidraw fetches its fonts at runtime from `<EXCALIDRAW_ASSET_PATH>/fonts/...`.
// vite.config.ts copies the package's `dist/prod` assets (dev: served by
// vite-plugin-static-copy, build: emitted into dist) preserving their
// node_modules-relative path, so we point the asset path there. This mirrors the
// official CDN example (which targets `.../dist/prod/`) and keeps the canvas fully
// offline. Must be set before the Excalidraw module is first evaluated (lazy-loaded).
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH =
  "/node_modules/@excalidraw/excalidraw/dist/prod/";

applyStoredTheme();
applyStoredFont();
applyStoredMdPlain();

loadPrefs().finally(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
