import { useState, useCallback, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Chat from "./components/Chat";
import Dashboard from "./components/Dashboard";
import Inbox from "./components/Inbox";
import Vault from "./components/Vault";
import SettingsModal from "./components/SettingsModal";
import Welcome from "./components/Welcome";
import { getPrefs, type TabId } from "./prefs/prefs";

type VaultCollection = "projects" | "library" | "notes" | null;

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>(() => getPrefs().starting_tab);
  const [refreshKey, setRefreshKey] = useState(0);
  const [vaultOpenPath, setVaultOpenPath] = useState<string | null>(null);
  const [vaultOpenProjectHub, setVaultOpenProjectHub] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [vaultCollection, setVaultCollection] = useState<VaultCollection>(null);
  const [showWelcome, setShowWelcome] = useState(() => !getPrefs().first_run_completed);
  const appWindow = getCurrentWindow();

  const triggerVaultRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const navigateToProjectHub = useCallback((projectPath: string) => {
    setVaultOpenProjectHub(projectPath);
    setActiveTab("find");
  }, []);

  // Sliding tab pill — measures the active tab and slides into place
  const tabGroupRef = useRef<HTMLDivElement>(null);
  const [pillStyle, setPillStyle] = useState<React.CSSProperties>({ opacity: 0 });

  // Cmd/Ctrl+, opens settings (standard "preferences" shortcut)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Mirror the vault's active collection onto the root element so the
  // tab pill's color can morph to match where the user is inside the
  // vault. Cleared when the user is on any other tab — the pill's
  // color is a "where am I in vault" signal, not a persistent state.
  useEffect(() => {
    const root = document.documentElement;
    if (activeTab === "find" && vaultCollection) {
      root.setAttribute("data-vault-collection", vaultCollection);
    } else {
      root.removeAttribute("data-vault-collection");
    }
  }, [activeTab, vaultCollection]);

  const measurePill = useCallback(() => {
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
  }, []);

  useEffect(() => {
    measurePill();
  }, [activeTab, measurePill]);

  // Re-measure whenever any tab's size changes — catches font-preset swaps,
  // window resizes, and any other layout shift. Without this the pill drifts
  // when switching fonts until the user clicks a tab.
  useEffect(() => {
    const container = tabGroupRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => measurePill());
    observer.observe(container);
    container.querySelectorAll<HTMLElement>(".tab").forEach((tab) => observer.observe(tab));
    return () => observer.disconnect();
  }, [measurePill]);

  return (
    <div className="app">
      <nav className="tab-bar" data-tauri-drag-region>
        <div className="tab-group" ref={tabGroupRef}>
          <div className="tab-pill" style={pillStyle} />
          <button
            className={`tab ${activeTab === "write" ? "tab-active" : ""}`}
            onClick={() => setActiveTab("write")}
          >
            Write
          </button>
          <button
            className={`tab ${activeTab === "focus" ? "tab-active" : ""}`}
            onClick={() => setActiveTab("focus")}
          >
            Focus
          </button>
          <button
            className={`tab ${activeTab === "find" ? "tab-active" : ""}`}
            onClick={() => setActiveTab("find")}
          >
            Find
          </button>
          <button
            className={`tab ${activeTab === "hum" ? "tab-active" : ""}`}
            onClick={() => setActiveTab("hum")}
          >
            Hum
          </button>
        </div>

        <div className="tab-bar-trailing">
          <button
            className="settings-cog"
            onClick={() => setSettingsOpen(true)}
            aria-label="Open settings"
          >
            &#x2699;
          </button>
        </div>

        <div className="window-controls">
          <button
            className="window-btn window-btn-minimize"
            onClick={() => appWindow.minimize()}
            aria-label="Minimize"
          />

          <button
            className="window-btn window-btn-maximize"
            onClick={() => appWindow.toggleMaximize()}
            aria-label="Maximize"
          />

          <button
            className="window-btn window-btn-close"
            onClick={() => appWindow.close()}
          >
            &#x2715;
          </button>
        </div>
      </nav>

      <main className="tab-content">
        <div className={`tab-panel ${activeTab === "write" ? "tab-panel-active" : ""}`}>
          <Inbox refreshKey={refreshKey} onVaultChanged={triggerVaultRefresh} />
        </div>
        <div className={`tab-panel ${activeTab === "focus" ? "tab-panel-active" : ""}`}>
          <Dashboard refreshKey={refreshKey} onOpenProjectHub={navigateToProjectHub} />
        </div>
        <div className={`tab-panel ${activeTab === "find" ? "tab-panel-active" : ""}`}>
          <Vault
            refreshKey={refreshKey}
            openPath={vaultOpenPath}
            onOpenPathHandled={() => setVaultOpenPath(null)}
            openProjectHub={vaultOpenProjectHub}
            onOpenProjectHubHandled={() => setVaultOpenProjectHub(null)}
            onActiveCollectionChange={setVaultCollection}
          />
        </div>
        <div className={`tab-panel ${activeTab === "hum" ? "tab-panel-active" : ""}`}>
          <Chat onVaultChanged={triggerVaultRefresh} />
        </div>
      </main>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {showWelcome && <Welcome onDismiss={() => setShowWelcome(false)} />}
    </div>
  );
}
