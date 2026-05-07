import { useState, useEffect, useCallback } from "react";
import { getPrefs, setPrefs } from "../prefs/prefs";

interface Props {
  onDismiss: () => void;
}

const SLIDE_COUNT = 4;

const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const modKey = isMac ? "⌘" : "Ctrl";

export default function OnboardingSlides({ onDismiss }: Props) {
  const [slide, setSlide] = useState(0);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  const finish = useCallback(async () => {
    if (dismissing) return;
    try {
      await setPrefs({ ...getPrefs(), onboarding_completed: true });
    } catch {
      // Non-fatal: a prefs write failure should not trap the user.
    }
    setDismissing(true);
    window.setTimeout(onDismiss, 320);
  }, [dismissing, onDismiss]);

  const goNext = useCallback(() => {
    setSlide((s) => (s >= SLIDE_COUNT - 1 ? s : s + 1));
  }, []);

  const goBack = useCallback(() => {
    setSlide((s) => Math.max(0, s - 1));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (slide >= SLIDE_COUNT - 1) finish();
        else goNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goBack();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slide, finish, goNext, goBack]);

  return (
    <div className={`onb-overlay ${dismissing ? "onb-dismissing" : ""}`}>
      <button className="onb-skip" onClick={finish} aria-label="Skip onboarding">
        Skip
      </button>

      <div className="onb-stage">
        <div className="onb-slide-wrap" data-slide={slide}>
          {slide === 0 && (
            <SlideWrite
              showShortcuts={showShortcuts}
              onToggleShortcuts={() => setShowShortcuts((v) => !v)}
            />
          )}
          {slide === 1 && <SlideFocus />}
          {slide === 2 && <SlideFind />}
          {slide === 3 && <SlideHum />}
        </div>
      </div>

      <footer className="onb-footer">
        <div className="onb-dots" role="tablist" aria-label="Onboarding progress">
          {Array.from({ length: SLIDE_COUNT }).map((_, i) => (
            <button
              key={i}
              role="tab"
              type="button"
              aria-selected={i === slide}
              aria-label={`Slide ${i + 1} of ${SLIDE_COUNT}`}
              className={`onb-dot ${i === slide ? "onb-dot-active" : ""}`}
              onClick={() => setSlide(i)}
            />
          ))}
        </div>

        <div className="onb-nav">
          <button
            className="onb-back"
            onClick={goBack}
            disabled={slide === 0}
            aria-label="Previous slide"
          >
            Back
          </button>
          {slide < SLIDE_COUNT - 1 ? (
            <button className="onb-next" onClick={goNext} aria-label="Next slide">
              Next
            </button>
          ) : (
            <button className="onb-cta" onClick={finish}>
              Begin
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

/* ── Slide 1: Write ─────────────────────────────────── */

interface SlideWriteProps {
  showShortcuts: boolean;
  onToggleShortcuts: () => void;
}

function SlideWrite({ showShortcuts, onToggleShortcuts }: SlideWriteProps) {
  return (
    <article className="onb-slide">
      <h2 className="onb-title">Just start writing.</h2>

      <p className="onb-opener">
        Hum keeps your work in plain markdown files inside{" "}
        <code className="onb-path">Documents/Hum/</code>. They belong to you, live on
        your machine, and read just fine in any text editor.
      </p>

      <p className="onb-tagline">
        Capture is simple. Organization takes care of itself.
      </p>

      <p className="onb-body">
        Write what's on your mind, and a small <code className="onb-mark">@</code>{" "}
        tells Hum where it belongs. Anything you write after{" "}
        <code className="onb-mark">@something</code> flows into that place, until
        you mention another one.
      </p>

      <div className="onb-example" aria-hidden="true">
        <div className="onb-example-line">Some thoughts on the kitchen redo.</div>
        <div className="onb-example-line">
          <span className="onb-pill onb-pill-projects">@kitchen-remodel</span>
        </div>
        <div className="onb-example-line onb-example-todo">
          <span className="onb-checkbox" />
          pick tile sample saturday
        </div>
        <div className="onb-example-line onb-example-todo">
          <span className="onb-checkbox" />
          measure the back wall
        </div>
        <div className="onb-example-line">
          <span className="onb-pill onb-pill-notes">@reading-list</span>
        </div>
        <div className="onb-example-line">finish the new murakami</div>
      </div>

      <p className="onb-beat">
        Press <kbd className="onb-kbd">{modKey}</kbd>
        <kbd className="onb-kbd">L</kbd> to make a checkbox. A checkbox under a
        project becomes a todo. Open todos show up in Focus until you tick them
        off.
      </p>

      <button
        type="button"
        className="onb-shortcuts-toggle"
        onClick={onToggleShortcuts}
        aria-expanded={showShortcuts}
      >
        {showShortcuts ? "Hide shortcuts" : "Show shortcuts"}
        <span className={`onb-caret ${showShortcuts ? "onb-caret-open" : ""}`} aria-hidden="true">
          {"›"}
        </span>
      </button>

      {showShortcuts && (
        <div className="onb-cheats">
          <div className="onb-cheat-group">
            <h3 className="onb-cheat-head">Place</h3>
            <ul className="onb-cheat-list">
              <li><code className="onb-mono">@project</code><span>route a section</span></li>
              <li><code className="onb-mono">[[note]]</code><span>link to another file</span></li>
              <li><code className="onb-mono">![[image]]</code><span>embed an image</span></li>
              <li><code className="onb-mono">#tag</code><span>add a tag</span></li>
            </ul>
          </div>
          <div className="onb-cheat-group">
            <h3 className="onb-cheat-head">Shape</h3>
            <ul className="onb-cheat-list">
              <li><code className="onb-mono">**bold**</code><span>bold text</span></li>
              <li><code className="onb-mono">*italic*</code><span>italic</span></li>
              <li><code className="onb-mono">~~strike~~</code><span>strikethrough</span></li>
              <li><code className="onb-mono">==highlight==</code><span>highlight</span></li>
            </ul>
          </div>
          <div className="onb-cheat-group">
            <h3 className="onb-cheat-head">Speed</h3>
            <ul className="onb-cheat-list">
              <li>
                <span className="onb-mono"><kbd className="onb-kbd">{modKey}</kbd><kbd className="onb-kbd">L</kbd></span>
                <span>checkbox</span>
              </li>
              <li>
                <span className="onb-mono"><kbd className="onb-kbd">{modKey}</kbd><kbd className="onb-kbd">K</kbd></span>
                <span>link</span>
              </li>
              <li>
                <span className="onb-mono"><kbd className="onb-kbd">{modKey}</kbd><kbd className="onb-kbd">{"↵"}</kbd></span>
                <span>new line below</span>
              </li>
              <li>
                <span className="onb-mono"><kbd className="onb-kbd">Tab</kbd></span>
                <span>indent</span>
              </li>
            </ul>
          </div>
        </div>
      )}
    </article>
  );
}

/* ── Slide 2: Focus ─────────────────────────────────── */

function SlideFocus() {
  return (
    <article className="onb-slide">
      <h2 className="onb-title">Focus tab.</h2>
      <p className="onb-body">
        A calm view of what's pulling at you. On the left, open todos from your
        projects rise and settle on their own, so the things that need you find
        their way up. On the right, your week. Tick a todo off and it leaves
        Focus, still kept inside its project for whenever you come back.
      </p>

      <div className="onb-list">
        <h3 className="onb-list-head">What lifts a project up</h3>
        <ul className="onb-bullets">
          <li>
            <strong>Open work.</strong> Projects with more to do feel a little
            heavier.
          </li>
          <li>
            <strong>Time.</strong> Older todos drift up gently, so they aren't
            forgotten.
          </li>
          <li>
            <strong>Quiet.</strong> If a project hasn't heard from you in a
            while, it gives a small nudge.
          </li>
          <li>
            <strong>Stuck.</strong> Anything tagged{" "}
            <code className="onb-mono">#blocked</code> or{" "}
            <code className="onb-mono">#waiting</code> floats up sooner.
          </li>
        </ul>
      </div>

      <p className="onb-coda">
        Need a break from one? Snooze it, and it steps aside until you're ready.
      </p>
    </article>
  );
}

/* ── Slide 3: Find ──────────────────────────────────── */

function SlideFind() {
  return (
    <article className="onb-slide">
      <h2 className="onb-title">Find tab.</h2>
      <p className="onb-body">
        Everything you've written is here, sorted into three calm shelves.
        Search any of them, or open one to look around.
      </p>
      <ul className="onb-shelves">
        <li>
          <strong>Projects.</strong> Work with a goal and an end. Plans, tasks,
          the things you'll finish.
        </li>
        <li>
          <strong>Library.</strong> Knowledge you keep. Notes-to-self,
          references, how-tos.
        </li>
        <li>
          <strong>Notes.</strong> Loose thoughts. Journals, sparks, anything
          still finding its home.
        </li>
      </ul>
    </article>
  );
}

/* ── Slide 4: Hum ───────────────────────────────────── */

function SlideHum() {
  return (
    <article className="onb-slide onb-slide-hum">
      <h2 className="onb-title">And soon, Hum.</h2>
      <p className="onb-body">
        Hum is the fourth tab, quiet for now. Soon it'll help you draft,
        summarize, and tie threads together across your work. Until then,
        everything you write today is already in the right place for it.
      </p>
    </article>
  );
}
