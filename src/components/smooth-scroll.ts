/**
 * Elastic rubber-band overscroll for the text editors.
 *
 * Normal scrolling is left entirely to the platform — WebView2 already does a
 * smooth, compositor-driven wheel scroll, and re-driving `scrollTop` by hand
 * only fights it and stutters. We intercept ONLY at the top/bottom edge: when
 * you wheel past the end, the content is pulled a little further against rising
 * resistance and springs back when you stop.
 *
 * The pull is a `transform: translateY` on the content (scrollTop stays pinned
 * at the edge), so it rides the compositor and never triggers layout/paint of
 * the editor — that's what keeps it smooth.
 */

// Approximate line height used to normalize line- and page-mode wheel deltas.
const LINE_HEIGHT = 16;
// Per-frame spring factor pulling the overscroll back to the edge.
const SPRING = 0.18;
// Largest visual elastic offset (px); the pull asymptotes toward this.
const RUBBER_LIMIT = 80;
// Softness of the rubber curve near the edge (slope for small pulls).
const RUBBER_C = 0.55;
// Cap on the raw (pre-damping) overscroll so the spring-back stays brief.
const RAW_CAP = 400;

// Map a raw pull distance to a damped visual offset that eases toward
// RUBBER_LIMIT — gentle at first, increasingly resistant further out.
function rubber(raw: number): number {
  const x = Math.abs(raw);
  const damped = (x * RUBBER_LIMIT * RUBBER_C) / (RUBBER_LIMIT + RUBBER_C * x);
  return Math.sign(raw) * damped;
}

export function attachSmoothWheelScroll(el: HTMLElement): () => void {
  const content = el.firstElementChild as HTMLElement | null;
  // Signed raw overscroll: negative past the top, positive past the bottom.
  let over = 0;
  let animating = false;
  let raf = 0;
  let applied = 0;

  const maxScroll = () => el.scrollHeight - el.clientHeight;

  const setOffset = (offset: number) => {
    if (!content || offset === applied) return;
    applied = offset;
    // over<0 (past top) → pull content down (+y); over>0 → pull up (-y).
    content.style.transform = offset === 0 ? "" : `translateY(${-offset}px)`;
  };

  const frame = () => {
    over += (0 - over) * SPRING;
    if (Math.abs(over) < 0.5) over = 0;
    setOffset(rubber(over));
    if (over !== 0) {
      raf = requestAnimationFrame(frame);
    } else {
      animating = false;
      if (content) content.style.willChange = "";
    }
  };

  const onWheel = (e: WheelEvent) => {
    // Leave pinch-zoom / modifier gestures and horizontal scrolls to native.
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;

    const max = maxScroll();
    if (max <= 0) return; // nothing to scroll, nothing to bounce off

    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= LINE_HEIGHT;
    else if (e.deltaMode === 2) delta *= el.clientHeight;

    const atTop = el.scrollTop <= 0.5;
    const atBottom = el.scrollTop >= max - 0.5;
    const pushingPastTop = atTop && delta < 0;
    const pushingPastBottom = atBottom && delta > 0;

    // Engage only at an edge (or while a bounce is still settling). Otherwise
    // this is ordinary in-bounds scrolling — hands off, let the platform do it.
    if (over === 0 && !pushingPastTop && !pushingPastBottom) return;

    e.preventDefault();

    const prev = over;
    over += delta;
    // Inward motion that crosses the edge releases the band rather than
    // flipping it to the opposite side.
    if ((prev < 0 && over > 0) || (prev > 0 && over < 0)) over = 0;
    over = Math.max(-RAW_CAP, Math.min(RAW_CAP, over));

    if (content) content.style.willChange = "transform";
    if (!animating) {
      animating = true;
      raf = requestAnimationFrame(frame);
    }
  };

  el.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    el.removeEventListener("wheel", onWheel);
    cancelAnimationFrame(raf);
    setOffset(0);
    if (content) content.style.willChange = "";
  };
}
