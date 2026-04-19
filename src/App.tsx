import { useState, useCallback, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Chat from "./components/Chat";
import Dashboard from "./components/Dashboard";
import Inbox from "./components/Inbox";
import Vault from "./components/Vault";

type Tab = "inbox" | "dashboard" | "vault" | "hum";

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("inbox");
  const [refreshKey, setRefreshKey] = useState(0);
  const [vaultOpenPath, setVaultOpenPath] = useState<string | null>(null);
  const appWindow = getCurrentWindow();

  const triggerVaultRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const navigateToVaultFile = useCallback((path: string) => {
    setVaultOpenPath(path);
    setActiveTab("vault");
  }, []);

  // Sliding tab pill — measures the active tab and slides into place
  const tabGroupRef = useRef<HTMLDivElement>(null);
  const [pillStyle, setPillStyle] = useState<React.CSSProperties>({ opacity: 0 });

  useEffect(() => {
    const container = tabGroupRef.current;
    if (!container) return;
    const active = container.querySelector<HTMLElement>(".tab-active");
    if (!active) { setPillStyle({ opacity: 0 }); return; }
    const containerRect = container.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    setPillStyle({
      opacity: 1,
      left: activeRect.left - containerRect.left,
      top: activeRect.top - containerRect.top,
      width: activeRect.width,
      height: activeRect.height,
    });
  }, [activeTab]);

  return (
    <div className="app">
      <nav className="tab-bar" data-tauri-drag-region>
        <div className="tab-group" ref={tabGroupRef}>
          <div className="tab-pill" style={pillStyle} />
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
          <Inbox refreshKey={refreshKey} onVaultChanged={triggerVaultRefresh} />
        </div>
        <div className={`tab-panel ${activeTab === "dashboard" ? "tab-panel-active" : ""}`}>
          <Dashboard refreshKey={refreshKey} onNavigateToFile={navigateToVaultFile} />
        </div>
        <div className={`tab-panel ${activeTab === "vault" ? "tab-panel-active" : ""}`}>
          <Vault refreshKey={refreshKey} openPath={vaultOpenPath} onOpenPathHandled={() => setVaultOpenPath(null)} />
        </div>
        <div className={`tab-panel ${activeTab === "hum" ? "tab-panel-active" : ""}`}>
          <Chat onVaultChanged={triggerVaultRefresh} />
        </div>
      </main>
    </div>
  );
}
