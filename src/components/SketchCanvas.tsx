import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
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
}

export default function SketchCanvas({
  open,
  onClose,
  onSave,
  initialSrc,
  title,
}: Props) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [theme, setTheme] = useState<CanvasTheme>(() => appThemeToCanvas());
  const [saving, setSaving] = useState(false);
  // `undefined` = still loading an existing scene; `null` = fresh canvas.
  const [initialData, setInitialData] = useState<
    ExcalidrawInitialDataState | null | undefined
  >(undefined);

  // Keep the canvas theme in sync if the app theme changes while open.
  useEffect(() => {
    if (!open) return;
    setTheme(appThemeToCanvas());
    const obs = new MutationObserver(() => setTheme(appThemeToCanvas()));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, [open]);

  // Load an existing drawing (or mark fresh) whenever we open.
  useEffect(() => {
    if (!open) {
      setInitialData(undefined);
      return;
    }
    let cancelled = false;
    void (async () => {
      if (!initialSrc) {
        if (!cancelled) setInitialData(null);
        return;
      }
      try {
        const { loadFromBlob } = await import("@excalidraw/excalidraw");
        const res = await fetch(initialSrc);
        const blob = await res.blob();
        const scene = await loadFromBlob(blob, null, null);
        if (!cancelled) setInitialData(scene);
      } catch {
        // Corrupt/unreadable scene — fall back to a blank canvas rather than
        // trapping the user in a spinner.
        if (!cancelled) setInitialData(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, initialSrc]);

  const handleSave = useCallback(async () => {
    const api = apiRef.current;
    if (!api || saving) return;
    setSaving(true);
    try {
      const { exportToBlob } = await import("@excalidraw/excalidraw");
      const png = await exportToBlob({
        elements: api.getSceneElements(),
        appState: { ...api.getAppState(), exportEmbedScene: true },
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
  }, [onSave, saving]);

  if (!open) return null;

  return (
    <div className="sketch-overlay" role="dialog" aria-modal="true" aria-label="Sketch">
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
              disabled={saving || initialData === undefined}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </header>

        <div className="sketch-canvas-wrap">
          {initialData === undefined ? (
            <div className="sketch-loading">Opening canvas…</div>
          ) : (
            <Suspense fallback={<div className="sketch-loading">Opening canvas…</div>}>
              <Excalidraw
                theme={theme}
                initialData={initialData}
                excalidrawAPI={(api) => {
                  apiRef.current = api;
                }}
              />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}
