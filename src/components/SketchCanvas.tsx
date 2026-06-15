import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
} from "react";
import type {
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";

// Excalidraw is heavy; keep it out of the initial bundle. The named export is
// wrapped so it works with React.lazy. EXCALIDRAW_ASSET_PATH is already set in
// main.tsx (before any import of this module), so fonts resolve offline.
const Excalidraw = lazy(async () => {
  const mod = await import("@excalidraw/excalidraw");
  return { default: mod.Excalidraw };
});

type CanvasTheme = "light" | "dark";

function appThemeToCanvas(): CanvasTheme {
  // gruvbox + dark -> dark canvas; light -> light canvas.
  return document.documentElement.getAttribute("data-theme") === "light"
    ? "light"
    : "dark";
}

interface Props {
  open: boolean;
  /** Close without saving. */
  onClose: () => void;
  /**
   * Persist the drawing. Receives a PNG blob with the full scene embedded
   * (re-openable/editable). The caller decides where it lands.
   */
  onSave: (png: Blob) => void | Promise<void>;
  /**
   * Existing drawing to edit, as a src URL (e.g. convertFileSrc of a vault
   * `.excalidraw.png`). Omit for a fresh canvas.
   */
  initialSrc?: string;
  /** Shown in the top bar (e.g. the routing target). */
  title?: string;
  /**
   * Mount the (heavy) canvas now even while closed, so the first real open is
   * instant. Set on idle after launch. Once mounted it stays mounted.
   */
  prewarm?: boolean;
}

export default function SketchCanvas({
  open,
  onClose,
  onSave,
  initialSrc,
  title,
  prewarm = false,
}: Props) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [theme, setTheme] = useState<CanvasTheme>(() => appThemeToCanvas());
  const [saving, setSaving] = useState(false);
  const [loadingScene, setLoadingScene] = useState(false);
  // A pre-warmed instance stays mounted for life — unmounting/remounting
  // Excalidraw is what makes opening feel slow, so once warmed it just hides
  // when closed and reopens instantly. A non-warmed instance (e.g. the edit
  // modal) mounts on open and tears down on close, so we don't keep a second
  // heavy canvas resident.
  const [mounted, setMounted] = useState(open || prewarm);
  useEffect(() => {
    if (open || prewarm) setMounted(true);
    else setMounted(false);
  }, [open, prewarm]);

  // Keep the canvas theme in sync with the app theme while mounted.
  useEffect(() => {
    if (!mounted) return;
    setTheme(appThemeToCanvas());
    const obs = new MutationObserver(() => setTheme(appThemeToCanvas()));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, [mounted]);

  // Load the scene each time we open. The instance is long-lived, so we drive
  // it through the imperative API rather than `initialData` (which is only read
  // once at mount): an existing drawing is loaded from its PNG, a fresh canvas
  // is reset to blank.
  useEffect(() => {
    if (!open || !api) return;
    let cancelled = false;
    // resetScene/updateScene carry the scene's own theme (default/saved =
    // light), which would override the canvas theme — and the controlled
    // `theme` prop won't re-assert without a React re-render. So pin the theme
    // (read live from the DOM) into every scene op.
    const blank = () => {
      api.resetScene();
      api.updateScene({ appState: { theme: appThemeToCanvas() } });
    };
    void (async () => {
      if (!initialSrc) {
        blank();
        return;
      }
      setLoadingScene(true);
      try {
        const { loadFromBlob } = await import("@excalidraw/excalidraw");
        const res = await fetch(initialSrc);
        const blob = await res.blob();
        const scene = await loadFromBlob(blob, null, null);
        if (cancelled) return;
        api.updateScene({
          elements: scene.elements,
          appState: { ...scene.appState, theme: appThemeToCanvas() },
        });
        if (scene.files) api.addFiles(Object.values(scene.files));
        api.scrollToContent(scene.elements, { fitToContent: true, animate: false });
      } catch {
        // Corrupt/unreadable scene — fall back to blank rather than trapping
        // the user.
        if (!cancelled) blank();
      } finally {
        if (!cancelled) setLoadingScene(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, initialSrc, api]);

  const handleSave = useCallback(async () => {
    if (!api || saving) return;
    setSaving(true);
    try {
      const { exportToBlob } = await import("@excalidraw/excalidraw");
      const png = await exportToBlob({
        elements: api.getSceneElements(),
        // exportBackground: false → transparent PNG, so the embedded drawing
        // sits on the editor surface rather than as a solid rectangle. The
        // scene is still embedded (exportEmbedScene) so editing keeps its own
        // canvas background.
        appState: { ...api.getAppState(), exportEmbedScene: true, exportBackground: false },
        files: api.getFiles(),
        mimeType: "image/png",
        quality: 1,
      });
      await onSave(png);
    } catch (err) {
      console.error("[sketch] save failed:", err);
    } finally {
      setSaving(false);
    }
  }, [api, onSave, saving]);

  if (!mounted) return null;

  return (
    <div
      className={`sketch-overlay${open ? "" : " sketch-overlay-warm"}`}
      role="dialog"
      aria-modal="true"
      aria-label="Sketch"
      aria-hidden={!open}
    >
      <div className="sketch-frame">
        <header className="sketch-bar">
          <div className="sketch-bar-title" title={title}>
            <span className="sketch-bar-kicker">Sketch</span>
            {title ? <span className="sketch-bar-target">{title}</span> : null}
          </div>
          <div className="sketch-bar-actions">
            <button
              type="button"
              className="sketch-btn sketch-btn-ghost"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="sketch-btn sketch-btn-primary"
              onClick={handleSave}
              disabled={saving || loadingScene}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </header>

        <div className="sketch-canvas-wrap">
          <Suspense fallback={<div className="sketch-loading">Opening canvas…</div>}>
            <Excalidraw
              theme={theme}
              excalidrawAPI={(a) => setApi(a)}
            />
          </Suspense>
          {loadingScene && <div className="sketch-loading">Opening canvas…</div>}
        </div>
      </div>
    </div>
  );
}
