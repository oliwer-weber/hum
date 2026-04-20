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
  { id: "editorial", label: "Editorial", description: "Fraunces + Lora. Full serif." },
];

const THEME_KEY = "pa.theme";
const FONT_KEY = "pa.font";
const DEFAULT_THEME: ThemeId = "gruvbox";
const DEFAULT_FONT: FontId = "mono";

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
