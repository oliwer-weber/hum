import { useEffect, useState } from "react";
import {
  THEMES, getStoredTheme, setTheme, type ThemeId,
  FONTS, getStoredFont, setFont, type FontId,
} from "../theme/theme";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SettingsModal({ open, onClose }: Props) {
  const [currentTheme, setCurrentTheme] = useState<ThemeId>(() => getStoredTheme());
  const [currentFont, setCurrentFont] = useState<FontId>(() => getStoredFont());

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
    if (open) {
      setCurrentTheme(getStoredTheme());
      setCurrentFont(getStoredFont());
    }
  }, [open]);

  if (!open) return null;

  const pickTheme = (id: ThemeId) => {
    setTheme(id);
    setCurrentTheme(id);
  };

  const pickFont = (id: FontId) => {
    setFont(id);
    setCurrentFont(id);
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
                    className={`settings-swatch ${currentTheme === t.id ? "settings-swatch-active" : ""}`}
                    data-theme-preview={t.id}
                    onClick={() => pickTheme(t.id)}
                    aria-pressed={currentTheme === t.id}
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

            <div className="settings-group">
              <div className="settings-group-label">Font</div>
              <div className="settings-fonts">
                {FONTS.map((f) => (
                  <button
                    key={f.id}
                    className={`settings-font ${currentFont === f.id ? "settings-font-active" : ""}`}
                    data-font-preview={f.id}
                    onClick={() => pickFont(f.id)}
                    aria-pressed={currentFont === f.id}
                  >
                    <span className="settings-font-radio" aria-hidden="true" />
                    <span className="settings-font-text">
                      <span className="settings-font-label">{f.label}</span>
                      <span className="settings-font-desc">{f.description}</span>
                    </span>
                    <span className="settings-font-sample" aria-hidden="true">Aa</span>
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
