import { useState, useEffect, useCallback, useRef } from "react";

export type FadeEdge = "none" | "top" | "bottom" | "both";

export function useScrollFade(deps: unknown[] = []) {
  const ref = useRef<HTMLDivElement>(null);
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
  }, [update, ...deps]);

  return { ref, edge };
}
