export type ThemeId = "gruvbox" | "dark" | "light";

export const THEMES: { id: ThemeId; label: string }[] = [
  { id: "gruvbox", label: "Gruvbox" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
];

const STORAGE_KEY = "pa.theme";
const DEFAULT: ThemeId = "gruvbox";

export function getStoredTheme(): ThemeId {
  const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
  if (raw && THEMES.some((t) => t.id === raw)) return raw as ThemeId;
  return DEFAULT;
}

export function setTheme(id: ThemeId) {
  document.documentElement.setAttribute("data-theme", id);
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // localStorage unavailable — theme still applies for this session
  }
}

export function applyStoredTheme() {
  setTheme(getStoredTheme());
}
