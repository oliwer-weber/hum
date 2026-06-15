import { useState, useCallback, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import Chat from "./components/Chat";
import Dashboard from "./components/Dashboard";
import Inbox from "./components/Inbox";
import Vault from "./components/Vault";
import SketchCanvas from "./components/SketchCanvas";
import SettingsModal from "./components/SettingsModal";
import Welcome from "./components/Welcome";
import OnboardingSlides from "./components/OnboardingSlides";
import { getPrefs, type TabId } from "./prefs/prefs";

interface EditingDrawing {
  /** convertFileSrc URL of the existing .excalidraw.png, loaded into the canvas. */
  src: string;
  /** Vault-relative path, written back to on save (overwrites in place). */
  relativePath: string;
  /** Basename, used for the title and to target the embed reload. */
  name: string;
}

type VaultCollection = "projects" | "library" | "notes" | null;

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>(() => getPrefs().starting_tab);
  const [refreshKey, setRefreshKey] = useState(0);
  const [vaultOpenPath, setVaultOpenPath] = useState<string | null>(null);
  const [vaultOpenProjectHub, setVaultOpenProjectHub] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [vaultCollection, setVaultCollection] = useState<VaultCollection>(null);
  const [showWelcome, setShowWelcome] = useState(() => !getPrefs().first_run_completed);
  const [showOnboarding, setShowOnboarding] = useState(() => !getPrefs().onboarding_completed);
  const [editingDrawing, setEditingDrawing] = useState<EditingDrawing | null>(null);
  const appWindow = getCurrentWindow();

  const triggerVaultRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const navigateToProjectHub = useCallback((projectPath: string) => {
    setVaultOpenProjectHub(projectPath);
    setActiveTab("find");
  }, []);

  // Click-to-edit: an embedded drawing (in any editor) fires hum:edit-drawing.
  // Resolve it to a vault path + src URL and open the canvas with the scene.
  useEffect(() => {
    const onEdit = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as { target: string; contextPath?: string };
      if (!detail?.target) return;
      void (async () => {
        try {
          const vaultPath = await invoke<string>("get_vault_path");
          const resolved = await invoke<string>("vault_resolve_link", {
            target: detail.target,
            contextPath: detail.contextPath,
          });
          const fullPath = `${vaultPath}/${resolved}`.replace(/\\/g, "/");
          setEditingDrawing({
            src: convertFileSrc(fullPath),
            relativePath: resolved,
            name: resolved.split("/").pop() ?? resolved,
          });
        } catch (err) {
          console.error("[sketch] could not open drawing for edit:", err);
        }
      })();
    };
    window.addEventListener("hum:edit-drawing", onEdit);
    return () => window.removeEventListener("hum:edit-drawing", onEdit);
  }, []);

  // Save an edited drawing back over the same file, then tell its embeds to
  // reload the thumbnail. The markdown is unchanged, so no editor refresh.
  const handleSaveEditedDrawing = useCallback(async (png: Blob) => {
    if (!editingDrawing) return;
    const data = Array.from(new Uint8Array(await png.arrayBuffer()));
    try {
      await invoke<string>("vault_save_sketch", {
        relativePath: editingDrawing.relativePath,
        data,
      });
      window.dispatchEvent(
        new CustomEvent("hum:drawing-saved", { detail: { name: editingDrawing.name } })
      );
      setEditingDrawing(null);
    } catch (err) {
      console.error("[sketch] save (edit) failed:", err);
      alert(`Sketch save failed: ${err}`);
    }
  }, [editingDrawing]);

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

  // Excalidraw is a heavy lazy chunk, so the first canvas open lags. Warm it
  // (module + CSS) on idle after launch so the first open is instant. Falls
  // back to a timeout where requestIdleCallback isn't available.
  useEffect(() => {
    const warm = () => void import("@excalidraw/excalidraw");
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (ric) {
      const id = ric(warm, { timeout: 4000 });
      return () => (window as unknown as { cancelIdleCallback?: (id: number) => void })
        .cancelIdleCallback?.(id);
    }
    const t = window.setTimeout(warm, 2000);
    return () => window.clearTimeout(t);
  }, []);

 useEffect(()=> {
  const map = {"1":"write","2":"focus","3":"find","4":"hum"} as const;
  const onKey = (e: KeyboardEvent) => {
    const tab = map[e.key as keyof typeof map];
    if ((e.metaKey || e.ctrlKey) && tab) {
      e.preventDefault();
      setActiveTab(tab);
    }
  }; 
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
 },[]);



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
            onVaultChanged={triggerVaultRefresh}
          />
        </div>
        <div className={`tab-panel ${activeTab === "hum" ? "tab-panel-active" : ""}`}>
          <Chat onVaultChanged={triggerVaultRefresh} />
        </div>
      </main>

      <SketchCanvas
        open={!!editingDrawing}
        onClose={() => setEditingDrawing(null)}
        onSave={handleSaveEditedDrawing}
        initialSrc={editingDrawing?.src}
        title={editingDrawing?.name}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onReplayOnboarding={() => {
          setSettingsOpen(false);
          setShowOnboarding(true);
        }}
      />
      {showWelcome && <Welcome onDismiss={() => setShowWelcome(false)} />}
      {!showWelcome && showOnboarding && (
        <OnboardingSlides onDismiss={() => setShowOnboarding(false)} />
      )}
    </div>
  );
}
