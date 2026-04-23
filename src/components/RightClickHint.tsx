import { useEffect, useState } from "react";

const STORAGE_KEY = "hum.hints.right_click";

/**
 * One-time banner nudging the user that rows have a right-click menu.
 * Stores a dismissal flag in localStorage keyed under `hum.hints.right_click`.
 * Subscribes to `contextmenu` at the document level so the banner also
 * self-dismisses the first time the user uses the menu, no click required.
 */
export default function RightClickHint() {
  const [visible, setVisible] = useState<boolean>(() => {
    try {
      return !localStorage.getItem(STORAGE_KEY);
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (!visible) return;
    const dismiss = () => {
      try { localStorage.setItem(STORAGE_KEY, "1"); } catch { /* ignore */ }
      setVisible(false);
    };
    const onContext = () => dismiss();
    document.addEventListener("contextmenu", onContext);
    return () => document.removeEventListener("contextmenu", onContext);
  }, [visible]);

  if (!visible) return null;

  const dismiss = () => {
    try { localStorage.setItem(STORAGE_KEY, "1"); } catch { /* ignore */ }
    setVisible(false);
  };

  return (
    <div className="rc-hint" role="status" aria-live="polite">
      <span className="rc-hint-text">
        Tip: right-click any row for actions (pin, rename, move, delete).
      </span>
      <button
        type="button"
        className="rc-hint-dismiss"
        onClick={dismiss}
        aria-label="Dismiss tip"
      >
        ×
      </button>
    </div>
  );
}
