/**
 * Eased wheel scrolling for the text editors.
 *
 * Mouse wheels emit large, discrete steps that land as abrupt jumps in the
 * webview. This intercepts those and animates `scrollTop` toward a running
 * target with a per-frame lerp, so the surface glides instead of snapping.
 *
 * Trackpads (and other fine-grained / precision devices) already scroll
 * smoothly, so their small pixel deltas are left to the platform untouched —
 * hijacking them would only add lag.
 */

// Below this absolute pixel delta a deltaMode-0 (pixel) event is treated as a
// trackpad/precision scroll and passed through to native handling.
const TRACKPAD_PIXEL_THRESHOLD = 30;
// Per-frame approach factor. Higher = snappier, lower = floatier.
const EASE = 0.2;
// Approximate line height used to normalize line- and page-mode deltas.
const LINE_HEIGHT = 16;

export function attachSmoothWheelScroll(el: HTMLElement): () => void {
  let target = el.scrollTop;
  let animating = false;
  let raf = 0;

  const maxScroll = () => el.scrollHeight - el.clientHeight;

  const tick = () => {
    const diff = target - el.scrollTop;
    if (Math.abs(diff) < 0.5) {
      el.scrollTop = target;
      animating = false;
      return;
    }
    el.scrollTop += diff * EASE;
    raf = requestAnimationFrame(tick);
  };

  const onWheel = (e: WheelEvent) => {
    // Leave pinch-zoom / modifier gestures and horizontal scrolls alone.
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    if (maxScroll() <= 0) return;

    // Pass fine-grained trackpad scrolls through to the platform.
    if (e.deltaMode === 0 && Math.abs(e.deltaY) < TRACKPAD_PIXEL_THRESHOLD) {
      target = el.scrollTop;
      return;
    }

    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= LINE_HEIGHT;
    else if (e.deltaMode === 2) delta *= el.clientHeight;

    e.preventDefault();

    // Resync to the live position before extending the target, in case the
    // surface was scrolled some other way (scrollbar drag, find-in-page) since
    // the last frame.
    if (!animating) target = el.scrollTop;
    target = Math.max(0, Math.min(maxScroll(), target + delta));

    if (!animating) {
      animating = true;
      raf = requestAnimationFrame(tick);
    }
  };

  el.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    el.removeEventListener("wheel", onWheel);
    cancelAnimationFrame(raf);
  };
}
