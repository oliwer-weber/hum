import { useEffect, useState } from "react";
import {
  THEMES, getStoredTheme, setTheme, type ThemeId,
  FONTS, getStoredFont, setFont, type FontId,
} from "../theme/theme";
import {
  getPrefs, setPrefs, TAB_IDS, TAB_LABELS, type TabId,
} from "../prefs/prefs";

type Section = "general" | "appearance";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SettingsModal({ open, onClose }: Props) {
  const [section, setSection] = useState<Section>("general");
  const [currentTheme, setCurrentTheme] = useState<ThemeId>(() => getStoredTheme());
  const [currentFont, setCurrentFont] = useState<FontId>(() => getStoredFont());
  const [icsUrl, setIcsUrl] = useState<string>(() => getPrefs().ics_url);
  const [startingTab, setStartingTab] = useState<TabId>(() => getPrefs().starting_tab);

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
      const p = getPrefs();
      setIcsUrl(p.ics_url);
      setStartingTab(p.starting_tab);
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

  const commitIcsUrl = () => {
    const trimmed = icsUrl.trim();
    if (trimmed === getPrefs().ics_url) return;
    setIcsUrl(trimmed);
    void setPrefs({ ...getPrefs(), ics_url: trimmed });
  };

  const pickStartingTab = (tab: TabId) => {
    setStartingTab(tab);
    void setPrefs({ ...getPrefs(), starting_tab: tab });
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
            <button
              className={`settings-nav-item ${section === "general" ? "settings-nav-item-active" : ""}`}
              onClick={() => setSection("general")}
            >
              General
            </button>
            <button
              className={`settings-nav-item ${section === "appearance" ? "settings-nav-item-active" : ""}`}
              onClick={() => setSection("appearance")}
            >
              Appearance
            </button>
            <button className="settings-nav-item settings-nav-item-stub" disabled>
              Find
            </button>
            <button className="settings-nav-item settings-nav-item-stub" disabled>
              Keyboard
            </button>
            <button className="settings-nav-item settings-nav-item-stub" disabled>
              About
            </button>
          </nav>

          {section === "general" && (
            <section className="settings-pane">
              <div className="settings-group">
                <div className="settings-group-label">Calendar</div>
                <div className="settings-field">
                  <label htmlFor="ics-url" className="settings-field-label">ICS URL</label>
                  <input
                    id="ics-url"
                    type="url"
                    className="settings-field-input"
                    placeholder="https://..."
                    value={icsUrl}
                    onChange={(e) => setIcsUrl(e.target.value)}
                    onBlur={commitIcsUrl}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <div className="settings-field-help">
                    Subscription link for your work calendar. Events populate the Focus tab.
                  </div>
                </div>
              </div>

              <div className="settings-group">
                <div className="settings-group-label">Starting tab</div>
                <div className="settings-segmented" role="radiogroup" aria-label="Starting tab">
                  {TAB_IDS.map((id) => (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={startingTab === id}
                      className={`settings-segmented-item ${startingTab === id ? "settings-segmented-item-active" : ""}`}
                      onClick={() => pickStartingTab(id)}
                    >
                      {TAB_LABELS[id]}
                    </button>
                  ))}
                </div>
              </div>
            </section>
          )}

          {section === "appearance" && (
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
          )}
        </div>
      </div>
    </div>
  );
}
