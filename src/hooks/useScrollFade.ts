import { useState, useEffect, useCallback, useRef } from "react";

export type FadeEdge = "none" | "top" | "bottom" | "both";

/**
 * Tracks whether the scroll container has content above or below the
 * visible window so CSS can mask only those edges. Replaces hard
 * scrollbars with a soft fade. Pass any deps that affect scroll height
 * (filtered item count, expanded sections) so the calculation stays
 * accurate after layout changes.
 */
export function useScrollFade<T extends HTMLElement = HTMLDivElement>(deps: unknown[] = []) {
  const ref = useRef<T>(null);
  const [edge, setEdge] = useState<FadeEdge>("none");

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const atTop = scrollTop <= 2;
    const atBottom = scrollTop + clientHeight >= scrollHeight - 2;
    if (atTop && atBottom) setEdge("none");
    else if (atTop) setEdge("bottom");
    else if (atBottom) setEdge("top");
    else setEdge("both");
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", update); ro.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update, ...deps]);

  return { ref, edge };
}
