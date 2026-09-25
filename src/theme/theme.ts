export type ThemeId = "gruvbox" | "dark" | "light";

export const THEMES: { id: ThemeId; label: string }[] = [
  { id: "gruvbox", label: "Gruvbox" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
];

export type FontId = "mono" | "modern" | "editorial";

export const FONTS: { id: FontId; label: string; description: string }[] = [
  { id: "mono",      label: "Mono",      description: "JetBrains Mono. Precise, technical." },
  { id: "modern",    label: "Modern",    description: "Inter throughout. Clean sans." },
  { id: "editorial", label: "Editorial", description: "Newsreader + Lora. Full serif." },
];

const THEME_KEY = "pa.theme";
const FONT_KEY = "pa.font";
const MD_PLAIN_KEY = "pa.mdPlain";
const SPELLCHECK_WRITE_KEY = "pa.spellcheckWrite";
const SPELLCHECK_FIND_KEY = "pa.spellcheckFind";
const DEFAULT_THEME: ThemeId = "light";
const DEFAULT_FONT: FontId = "modern";

export function getStoredTheme(): ThemeId {
  const raw = typeof localStorage !== "undefined" ? localStorage.getItem(THEME_KEY) : null;
  if (raw && THEMES.some((t) => t.id === raw)) return raw as ThemeId;
  return DEFAULT_THEME;
}

export function setTheme(id: ThemeId) {
  document.documentElement.setAttribute("data-theme", id);
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch {
    // localStorage unavailable — theme still applies for this session
  }
}

export function applyStoredTheme() {
  setTheme(getStoredTheme());
}

export function getStoredFont(): FontId {
  const raw = typeof localStorage !== "undefined" ? localStorage.getItem(FONT_KEY) : null;
  if (raw && FONTS.some((f) => f.id === raw)) return raw as FontId;
  return DEFAULT_FONT;
}

export function setFont(id: FontId) {
  document.documentElement.setAttribute("data-font", id);
  try {
    localStorage.setItem(FONT_KEY, id);
  } catch {
    // localStorage unavailable — font still applies for this session
  }
}

export function applyStoredFont() {
  setFont(getStoredFont());
}

/**
 * Plain text styling: render markdown with weight and size instead of color,
 * like a classic writing app. Tags (#) and mentions (@) keep their color.
 * Off by default. Drives the `data-md-plain` attribute that the editor CSS
 * reads to neutralize structural colors.
 */
export function getStoredMdPlain(): boolean {
  const raw = typeof localStorage !== "undefined" ? localStorage.getItem(MD_PLAIN_KEY) : null;
  return raw === "true";
}

export function setMdPlain(on: boolean) {
  document.documentElement.setAttribute("data-md-plain", on ? "true" : "false");
  try {
    localStorage.setItem(MD_PLAIN_KEY, on ? "true" : "false");
  } catch {
    // localStorage unavailable — setting still applies for this session
  }
}

export function applyStoredMdPlain() {
  setMdPlain(getStoredMdPlain());
}

/**
 * Spellcheck toggles for the two editing surfaces — the Write (inbox) editor
 * and the Find (vault) editor — controlled independently. Both default on,
 * matching the browser's contenteditable default. The editors listen for
 * SPELLCHECK_CHANGED_EVENT to update live; they read their own flag on fire.
 */
export const SPELLCHECK_CHANGED_EVENT = "hum:spellcheck-changed";

function getStoredBool(key: string): boolean {
  const raw = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  return raw !== "false"; // default on
}

function setStoredBool(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "true" : "false");
  } catch {
    // localStorage unavailable — setting still applies for this session
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SPELLCHECK_CHANGED_EVENT));
  }
}

export function getStoredSpellcheckWrite(): boolean {
  return getStoredBool(SPELLCHECK_WRITE_KEY);
}

export function setSpellcheckWrite(on: boolean) {
  setStoredBool(SPELLCHECK_WRITE_KEY, on);
}

export function getStoredSpellcheckFind(): boolean {
  return getStoredBool(SPELLCHECK_FIND_KEY);
}

export function setSpellcheckFind(on: boolean) {
  setStoredBool(SPELLCHECK_FIND_KEY, on);
}
