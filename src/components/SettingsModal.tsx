import { useEffect, useState } from "react";
import { THEMES, getStoredTheme, setTheme, type ThemeId } from "../theme/theme";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SettingsModal({ open, onClose }: Props) {
  const [current, setCurrent] = useState<ThemeId>(() => getStoredTheme());

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) setCurrent(getStoredTheme());
  }, [open]);

  if (!open) return null;

  const pick = (id: ThemeId) => {
    setTheme(id);
    setCurrent(id);
  };

  return (
    <div
      className="settings-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header className="settings-header">
          <h2 id="settings-title" className="settings-title">Settings</h2>
          <button
            className="settings-close"
            onClick={onClose}
            aria-label="Close settings"
          >
            &#x2715;
          </button>
        </header>

        <div className="settings-body">
          <nav className="settings-nav" aria-label="Settings sections">
            <button className="settings-nav-item settings-nav-item-active">
              Appearance
            </button>
            <button className="settings-nav-item settings-nav-item-stub" disabled>
              Vault
            </button>
            <button className="settings-nav-item settings-nav-item-stub" disabled>
              Keyboard
            </button>
            <button className="settings-nav-item settings-nav-item-stub" disabled>
              About
            </button>
          </nav>

          <section className="settings-pane">
            <div className="settings-group">
              <div className="settings-group-label">Theme</div>
              <div className="settings-swatches">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    className={`settings-swatch ${current === t.id ? "settings-swatch-active" : ""}`}
                    data-theme-preview={t.id}
                    onClick={() => pick(t.id)}
                    aria-pressed={current === t.id}
                  >
                    <div className="settings-swatch-preview">
                      <span className="settings-swatch-bg" />
                      <span className="settings-swatch-accent" />
                    </div>
                    <div className="settings-swatch-label">{t.label}</div>
                  </button>
                ))}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
