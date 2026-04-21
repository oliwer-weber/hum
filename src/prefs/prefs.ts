import { invoke } from "@tauri-apps/api/core";

export type TabId = "write" | "focus" | "find" | "hum";

export const TAB_IDS: TabId[] = ["write", "focus", "find", "hum"];

export const TAB_LABELS: Record<TabId, string> = {
  write: "Write",
  focus: "Focus",
  find: "Find",
  hum: "Hum",
};

export interface Prefs {
  ics_url: string;
  starting_tab: TabId;
  first_run_completed: boolean;
}

const DEFAULTS: Prefs = {
  ics_url: "",
  starting_tab: "write",
  first_run_completed: true,
};

let cached: Prefs = DEFAULTS;

function coerce(raw: Prefs): Prefs {
  const tab = TAB_IDS.includes(raw.starting_tab) ? raw.starting_tab : "write";
  return {
    ics_url: raw.ics_url ?? "",
    starting_tab: tab,
    first_run_completed: raw.first_run_completed ?? true,
  };
}

// Call once at bootstrap, before App renders — keeps getPrefs() synchronous
// for code paths that need it in a useState initializer.
export async function loadPrefs(): Promise<Prefs> {
  try {
    const raw = await invoke<Prefs>("get_prefs");
    cached = coerce(raw);
  } catch {
    cached = DEFAULTS;
  }
  return cached;
}

export function getPrefs(): Prefs {
  return cached;
}

export async function setPrefs(prefs: Prefs): Promise<void> {
  cached = coerce(prefs);
  await invoke("set_prefs", { prefs: cached });
}
