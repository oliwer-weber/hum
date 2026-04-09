import { useState, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Chat from "./components/Chat";
import Dashboard from "./components/Dashboard";
import Inbox from "./components/Inbox";
import Plan from "./components/Plan";
import Vault from "./components/Vault";

type Tab = "inbox" | "dashboard" | "plan" | "vault" | "hum";

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("inbox");
  const [refreshKey, setRefreshKey] = useState(0);
  const appWindow = getCurrentWindow();

  const triggerVaultRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  return (
    <div className="app">
      <nav className="tab-bar" data-tauri-drag-region>
        <div className="tab-group">
          <button
            className={`tab ${activeTab === "inbox" ? "tab-active" : ""}`}
            onClick={() => setActiveTab("inbox")}
          >
            Inbox
          </button>
          <button
            className={`tab ${activeTab === "dashboard" ? "tab-active" : ""}`}
            onClick={() => setActiveTab("dashboard")}
          >
            Dashboard
          </button>
          <button
            className={`tab ${activeTab === "plan" ? "tab-active" : ""}`}
            onClick={() => setActiveTab("plan")}
          >
            Plan
          </button>
          <button
            className={`tab ${activeTab === "vault" ? "tab-active" : ""}`}
            onClick={() => setActiveTab("vault")}
          >
            Vault
          </button>
          <button
            className={`tab ${activeTab === "hum" ? "tab-active" : ""}`}
            onClick={() => setActiveTab("hum")}
          >
            Hum
          </button>
        </div>

        <div className="window-controls">
          <button
            className="window-btn window-btn-minimize"
            onClick={() => appWindow.minimize()}
          >
            &#x2500;
          </button>
          <button
            className="window-btn window-btn-maximize"
            onClick={() => appWindow.toggleMaximize()}
          >
            &#x25A1;
          </button>
          <button
            className="window-btn window-btn-close"
            onClick={() => appWindow.close()}
          >
            &#x2715;
          </button>
        </div>
      </nav>

      <main className="tab-content">
        <div className={`tab-panel ${activeTab === "inbox" ? "tab-panel-active" : ""}`}>
          <Inbox refreshKey={refreshKey} />
        </div>
        <div className={`tab-panel ${activeTab === "dashboard" ? "tab-panel-active" : ""}`}>
          <Dashboard refreshKey={refreshKey} />
        </div>
        <div className={`tab-panel ${activeTab === "plan" ? "tab-panel-active" : ""}`}>
          <Plan refreshKey={refreshKey} />
        </div>
        <div className={`tab-panel ${activeTab === "vault" ? "tab-panel-active" : ""}`}>
          <Vault refreshKey={refreshKey} />
        </div>
        <div className={`tab-panel ${activeTab === "hum" ? "tab-panel-active" : ""}`}>
          <Chat onVaultChanged={triggerVaultRefresh} />
        </div>
      </main>
    </div>
  );
}
