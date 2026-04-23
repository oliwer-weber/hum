import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyStoredTheme, applyStoredFont } from "./theme/theme";
import { loadPrefs } from "./prefs/prefs";
import "./theme/tokens.css";
import "./styles/global.css";
import "./styles/components.css";
import "./styles/vault-cards.css";
import "./styles/project-list.css";

applyStoredTheme();
applyStoredFont();

loadPrefs().finally(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
