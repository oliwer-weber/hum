/**
 * Eased wheel scrolling with elastic overscroll for the text editors.
 *
 * Mouse wheels emit large, discrete steps that land as abrupt jumps in the
 * webview. This intercepts those and animates `scrollTop` toward a running
 * target with a per-frame lerp, so the surface glides instead of snapping.
 *
 * At the top/bottom edge it adds a rubber-band: you can pull a little past the
 * end against rising resistance, and it springs back when you stop. The pull is
 * shown by translating the content (scrollTop stays pinned at the edge), so it
 * costs nothing layout-wise.
 *
 * Trackpads (and other fine-grained / precision devices) already scroll
 * smoothly, so their small pixel deltas are left to the platform untouched —
 * hijacking them would only add lag.
 */

// Below this absolute pixel delta a deltaMode-0 (pixel) event is treated as a
// trackpad/precision scroll and passed through to native handling.
const TRACKPAD_PIXEL_THRESHOLD = 30;
// Per-frame approach factor for in-bounds scrolling. Higher = snappier.
const EASE = 0.2;
// Approximate line height used to normalize line- and page-mode deltas.
const LINE_HEIGHT = 16;
// Per-frame spring factor pulling the overscroll back to the edge.
const SPRING = 0.15;
// Largest visual elastic offset (px); the pull asymptotes toward this.
const RUBBER_LIMIT = 80;
// Softness of the rubber curve near the edge (slope for small pulls).
const RUBBER_C = 0.55;
// Cap on the raw (pre-damping) overscroll so the spring-back stays brief.
const RAW_CAP = 400;

// Map a raw pull distance to a damped visual offset that eases toward
// RUBBER_LIMIT — gentle at first, increasingly resistant further out.
function rubber(raw: number): number {
  return (raw * RUBBER_LIMIT * RUBBER_C) / (RUBBER_LIMIT + RUBBER_C * raw);
}

export function attachSmoothWheelScroll(el: HTMLElement): () => void {
  const content = el.firstElementChild as HTMLElement | null;
  let pos = el.scrollTop; // virtual position; may sit past [0,max] while pulling
  let animating = false;
  let raf = 0;
  let appliedOffset = 0;

  const maxScroll = () => el.scrollHeight - el.clientHeight;

  const setOverscroll = (offset: number) => {
    if (!content || offset === appliedOffset) return;
    appliedOffset = offset;
    if (offset === 0) {
      content.style.transform = "";
      content.style.willChange = "";
    } else {
      content.style.transform = `translateY(${offset}px)`;
      content.style.willChange = "transform";
    }
  };

  const frame = () => {
    const max = maxScroll();
    let again = false;

    if (pos < 0) {
      // Past the top: pin the scroll, show the elastic pull, spring back to 0.
      pos += (0 - pos) * SPRING;
      if (pos > -0.5) pos = 0;
      el.scrollTop = 0;
      setOverscroll(rubber(-pos)); // pull content down
      again = pos !== 0;
    } else if (pos > max) {
      // Past the bottom: same, the other direction.
      pos += (max - pos) * SPRING;
      if (pos < max + 0.5) pos = max;
      el.scrollTop = max;
      setOverscroll(-rubber(pos - max)); // pull content up
      again = pos !== max;
    } else {
      setOverscroll(0);
      const diff = pos - el.scrollTop;
      if (Math.abs(diff) < 0.5) {
        el.scrollTop = pos;
      } else {
        el.scrollTop += diff * EASE;
        again = true;
      }
    }

    if (again) raf = requestAnimationFrame(frame);
    else animating = false;
  };

  const onWheel = (e: WheelEvent) => {
    // Leave pinch-zoom / modifier gestures and horizontal scrolls alone.
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    if (maxScroll() <= 0) return;

    // Pass fine-grained trackpad scrolls through to the platform.
    if (e.deltaMode === 0 && Math.abs(e.deltaY) < TRACKPAD_PIXEL_THRESHOLD) {
      pos = el.scrollTop;
      return;
    }

    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= LINE_HEIGHT;
    else if (e.deltaMode === 2) delta *= el.clientHeight;

    e.preventDefault();

    const max = maxScroll();
    // Resync to the live position when idle (scrollbar drag, find-in-page, …),
    // but not mid-bounce, where `pos` carries the elastic offset.
    if (!animating) pos = el.scrollTop;
    // Accumulate raw delta; resistance comes from the rubber() mapping in frame.
    pos = Math.max(-RAW_CAP, Math.min(max + RAW_CAP, pos + delta));

    if (!animating) {
      animating = true;
      raf = requestAnimationFrame(frame);
    }
  };

  el.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    el.removeEventListener("wheel", onWheel);
    cancelAnimationFrame(raf);
    setOverscroll(0);
  };
}
