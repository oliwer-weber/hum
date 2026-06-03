import { useEffect, useState } from "react";
import {
  THEMES, getStoredTheme, setTheme, type ThemeId,
  FONTS, getStoredFont, setFont, type FontId,
  getStoredMdPlain, setMdPlain,
} from "../theme/theme";
import {
  getPrefs, setPrefs, TAB_IDS, TAB_LABELS, type TabId,
} from "../prefs/prefs";

type Section = "general" | "appearance" | "shortcuts";

interface Props {
  open: boolean;
  onClose: () => void;
  onReplayOnboarding?: () => void;
}

const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const modKey = isMac ? "⌘" : "Ctrl";
const altKey = isMac ? "⌥" : "Alt";

export default function SettingsModal({ open, onClose, onReplayOnboarding }: Props) {
  const [section, setSection] = useState<Section>("general");
  const [currentTheme, setCurrentTheme] = useState<ThemeId>(() => getStoredTheme());
  const [currentFont, setCurrentFont] = useState<FontId>(() => getStoredFont());
  const [mdPlain, setMdPlainState] = useState<boolean>(() => getStoredMdPlain());
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
      setMdPlainState(getStoredMdPlain());
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

  const toggleMdPlain = () => {
    const next = !mdPlain;
    setMdPlain(next);
    setMdPlainState(next);
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
            <button
              className={`settings-nav-item ${section === "shortcuts" ? "settings-nav-item-active" : ""}`}
              onClick={() => setSection("shortcuts")}
            >
              Shortcuts
            </button>
            <button className="settings-nav-item settings-nav-item-stub" disabled>
              Find
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

              {onReplayOnboarding && (
                <div className="settings-group">
                  <div className="settings-group-label">Onboarding</div>
                  <button
                    type="button"
                    className="settings-replay"
                    onClick={async () => {
                      await setPrefs({ ...getPrefs(), onboarding_completed: false });
                      onReplayOnboarding();
                    }}
                  >
                    Show onboarding again
                  </button>
                  <div className="settings-field-help">
                    Walks through the four tabs and the writing shortcuts.
                  </div>
                </div>
              )}
            </section>
          )}

          {section === "shortcuts" && (
            <section className="settings-pane">
              <div className="settings-group">
                <div className="settings-group-label">Place</div>
                <ul className="shortcuts-list">
                  <li><code className="shortcuts-mono">@project</code><span>Route what follows into a project, library entry, or note.</span></li>
                  <li><code className="shortcuts-mono">[[note name]]</code><span>Link to another file in your work.</span></li>
                  <li><code className="shortcuts-mono">![[image.png]]</code><span>Embed an image inline.</span></li>
                  <li><code className="shortcuts-mono">#tag</code><span>Add a tag. <code className="shortcuts-mono">#blocked</code> and <code className="shortcuts-mono">#waiting</code> lift a project in Focus.</span></li>
                </ul>
              </div>

              <div className="settings-group">
                <div className="settings-group-label">Shape</div>
                <div className="settings-field-help shortcuts-tip">
                  You don't have to type the marks. Each one has a keyboard shortcut too.
                </div>
                <ul className="shortcuts-list">
                  <li>
                    <code className="shortcuts-mono">**bold**</code>
                    <span>
                      Bold. Or press{" "}
                      <kbd className="shortcuts-kbd shortcuts-kbd-inline">{modKey}</kbd>
                      <kbd className="shortcuts-kbd shortcuts-kbd-inline">B</kbd>.
                    </span>
                  </li>
                  <li>
                    <code className="shortcuts-mono">*italic*</code>
                    <span>
                      Italic. Or press{" "}
                      <kbd className="shortcuts-kbd shortcuts-kbd-inline">{modKey}</kbd>
                      <kbd className="shortcuts-kbd shortcuts-kbd-inline">I</kbd>.
                    </span>
                  </li>
                  <li>
                    <code className="shortcuts-mono">~~strike~~</code>
                    <span>
                      Strikethrough. Or press{" "}
                      <kbd className="shortcuts-kbd shortcuts-kbd-inline">{modKey}</kbd>
                      <kbd className="shortcuts-kbd shortcuts-kbd-inline">⇧</kbd>
                      <kbd className="shortcuts-kbd shortcuts-kbd-inline">S</kbd>.
                    </span>
                  </li>
                  <li>
                    <code className="shortcuts-mono">==highlight==</code>
                    <span>
                      Highlight. Or press{" "}
                      <kbd className="shortcuts-kbd shortcuts-kbd-inline">{modKey}</kbd>
                      <kbd className="shortcuts-kbd shortcuts-kbd-inline">⇧</kbd>
                      <kbd className="shortcuts-kbd shortcuts-kbd-inline">H</kbd>.
                    </span>
                  </li>
                  <li>
                    <code className="shortcuts-mono"># Heading</code>
                    <span>
                      Up to six levels with more <code className="shortcuts-mono">#</code>. Or press{" "}
                      <kbd className="shortcuts-kbd shortcuts-kbd-inline">{modKey}</kbd>
                      <kbd className="shortcuts-kbd shortcuts-kbd-inline">{altKey}</kbd>
                      <kbd className="shortcuts-kbd shortcuts-kbd-inline">1</kbd>
                      …
                      <kbd className="shortcuts-kbd shortcuts-kbd-inline">6</kbd>.
                    </span>
                  </li>
                  <li><code className="shortcuts-mono">- item</code><span>Bullet list. Use <code className="shortcuts-mono">1.</code> for numbered.</span></li>
                  <li><code className="shortcuts-mono">- [ ] todo</code><span>Checkbox. Becomes a todo when under a project.</span></li>
                  <li><code className="shortcuts-mono">{"> quote"}</code><span>Blockquote.</span></li>
                  <li>
                    <code className="shortcuts-mono">`code`</code>
                    <span>
                      Inline code. Or press{" "}
                      <kbd className="shortcuts-kbd shortcuts-kbd-inline">{modKey}</kbd>
                      <kbd className="shortcuts-kbd shortcuts-kbd-inline">E</kbd>.
                    </span>
                  </li>
                </ul>
              </div>

              <div className="settings-group">
                <div className="settings-group-label">Speed</div>
                <ul className="shortcuts-list">
                  <li>
                    <span className="shortcuts-keys"><kbd className="shortcuts-kbd">{modKey}</kbd><kbd className="shortcuts-kbd">L</kbd></span>
                    <span>Make a checkbox.</span>
                  </li>
                  <li>
                    <span className="shortcuts-keys"><kbd className="shortcuts-kbd">{modKey}</kbd><kbd className="shortcuts-kbd">K</kbd></span>
                    <span>Insert a link.</span>
                  </li>
                  <li>
                    <span className="shortcuts-keys"><kbd className="shortcuts-kbd">{modKey}</kbd><kbd className="shortcuts-kbd">↵</kbd></span>
                    <span>New line below without splitting the current one.</span>
                  </li>
                  <li>
                    <span className="shortcuts-keys"><kbd className="shortcuts-kbd">{modKey}</kbd><kbd className="shortcuts-kbd">⇧</kbd><kbd className="shortcuts-kbd">K</kbd></span>
                    <span>Delete the current line.</span>
                  </li>
                  <li>
                    <span className="shortcuts-keys"><kbd className="shortcuts-kbd">{modKey}</kbd><kbd className="shortcuts-kbd">⇧</kbd><kbd className="shortcuts-kbd">V</kbd></span>
                    <span>Paste as plain text.</span>
                  </li>
                  <li>
                    <span className="shortcuts-keys"><kbd className="shortcuts-kbd">Tab</kbd> / <kbd className="shortcuts-kbd">⇧</kbd><kbd className="shortcuts-kbd">Tab</kbd></span>
                    <span>Indent and outdent in lists.</span>
                  </li>
                  <li>
                    <span className="shortcuts-keys"><kbd className="shortcuts-kbd">*</kbd> <kbd className="shortcuts-kbd">~</kbd> <kbd className="shortcuts-kbd">=</kbd></span>
                    <span>Wrap a selection with italic, strike, or highlight.</span>
                  </li>
                </ul>
              </div>

              <div className="settings-group">
                <div className="settings-group-label">App</div>
                <ul className="shortcuts-list">
                  <li>
                    <span className="shortcuts-keys"><kbd className="shortcuts-kbd">{modKey}</kbd><kbd className="shortcuts-kbd">,</kbd></span>
                    <span>Open settings.</span>
                  </li>
                  <li>
                    <span className="shortcuts-keys"><kbd className="shortcuts-kbd">Esc</kbd></span>
                    <span>Close any open modal.</span>
                  </li>
                </ul>
              </div>

              <div className="settings-group">
                <div className="settings-group-label">Tips</div>
                <ul className="shortcuts-list">
                  <li><span className="shortcuts-keys">Drag or paste</span><span>Drop an image straight into the editor and it lands in your work.</span></li>
                  <li><span className="shortcuts-keys">Auto-pair</span><span>Brackets and quotes pair themselves. Backspace at the seam removes both.</span></li>
                </ul>
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

              <div className="settings-group">
                <div className="settings-group-label">Markdown</div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={mdPlain}
                  className={`settings-toggle ${mdPlain ? "settings-toggle-on" : ""}`}
                  onClick={toggleMdPlain}
                >
                  <span className="settings-toggle-text">
                    <span className="settings-toggle-label">Plain text styling</span>
                    <span className="settings-toggle-desc">
                      Style with weight and size instead of color, like a classic writing app. Tags and mentions stay colored.
                    </span>
                  </span>
                  <span className="settings-toggle-track" aria-hidden="true">
                    <span className="settings-toggle-thumb" />
                  </span>
                </button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
