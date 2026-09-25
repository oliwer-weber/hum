import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Launch data the backend injects before any app code runs (see `run()` in
 * lib.rs): prefs and the raw inbox, so the first render already has what the
 * first screen needs instead of waiting on IPC round trips.
 *
 * Missing when the page runs outside the Tauri window (e.g. plain `vite` in a
 * browser); every caller falls back to the regular invoke path.
 */
interface HumBoot {
  prefs?: unknown;
  inbox?: string;
}

const boot = (window as unknown as { __HUM_BOOT__?: HumBoot }).__HUM_BOOT__;

export function bootPrefs(): unknown | undefined {
  return boot?.prefs;
}

/** The inbox as it was on disk at launch, or null when there's no boot data. */
export function bootInbox(): string | null {
  return typeof boot?.inbox === "string" ? boot.inbox : null;
}

let revealed = false;

/**
 * The window launches hidden so it never shows a blank or half-built frame.
 * Call once the first screen is drawn; later calls are no-ops. (The backend
 * also shows it after a few seconds as a safety net.)
 */
export function revealWindow(): void {
  if (revealed) return;
  revealed = true;
  const win = getCurrentWindow();
  win.show().then(() => win.setFocus()).catch(() => {});
}
