import { useState } from "react";
import { getPrefs, setPrefs } from "../prefs/prefs";

interface WelcomeProps {
  onDismiss: () => void;
}

export default function Welcome({ onDismiss }: WelcomeProps) {
  const [dismissing, setDismissing] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleStart() {
    if (busy) return;
    setBusy(true);
    try {
      await setPrefs({ ...getPrefs(), first_run_completed: true });
    } catch {
      // Non-fatal: prefs write failure should not trap the user on the welcome screen.
    }
    setDismissing(true);
    window.setTimeout(onDismiss, 320);
  }

  return (
    <div className={`welcome-overlay ${dismissing ? "welcome-dismissing" : ""}`}>
      <div className="welcome-panel">
        <div className="welcome-mark">Project Assistant</div>
        <h1 className="welcome-title">Welcome.</h1>
        <p className="welcome-body">
          Your workspace is ready. Capture whatever&apos;s on your mind in Write,
          and wander the rest when you&apos;re curious.
        </p>
        <button
          className="welcome-cta"
          onClick={handleStart}
          disabled={busy}
          autoFocus
        >
          Get started
        </button>
        <p className="welcome-footnote">
          Theme and font are switchable from Settings whenever you want.
        </p>
      </div>
    </div>
  );
}
