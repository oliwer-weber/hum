import { useEffect, useRef, useState, useCallback } from "react";

export interface ProjectGravity {
  name: string;
  path: string;
  open_todos: number;
  completed_todos: number;
  gravity: number;
  color_index: number;
}

interface SolarSystemProps {
  projects: ProjectGravity[];
  onNavigate: (path: string) => void;
}

const PLANET_COLORS = [
  "var(--aqua)",
  "var(--green)",
  "var(--yellow)",
  "var(--blue)",
  "var(--purple)",
  "var(--orange)",
  "var(--red)",
];

const MAX_TIERS = 5;

interface PlanetState {
  project: ProjectGravity;
  angle: number;
  orbitRadius: number;
  planetRadius: number;
  speed: number; // radians per second
  direction: number; // 1 or -1
  color: string;
}

function buildPlanets(projects: ProjectGravity[], cx: number, cy: number): PlanetState[] {
  if (projects.length === 0) return [];

  const sorted = [...projects].sort((a, b) => b.gravity - a.gravity);
  const maxGravity = Math.max(...sorted.map((p) => p.gravity), 1);

  // If >12, cluster bottom 30% on outermost ring
  const clusterThreshold = projects.length > 12 ? Math.ceil(projects.length * 0.7) : projects.length;

  const minOrbit = Math.min(cx, cy) * 0.2;
  const maxOrbit = Math.min(cx, cy) * 0.85;

  return sorted.map((project, i) => {
    const gravNorm = project.gravity / maxGravity; // 0..1, 1 = highest

    // Orbit: high gravity = close, low = far
    let tier: number;
    if (i >= clusterThreshold) {
      tier = MAX_TIERS - 1; // outermost
    } else {
      tier = Math.min(
        Math.floor((1 - gravNorm) * MAX_TIERS),
        MAX_TIERS - 1
      );
    }
    const orbitRadius = minOrbit + ((maxOrbit - minOrbit) * tier) / (MAX_TIERS - 1);

    // Planet size: 10..28 based on gravity, clustered get minimum 8
    let planetRadius: number;
    if (i >= clusterThreshold) {
      planetRadius = 8;
    } else {
      planetRadius = 10 + gravNorm * 18;
    }

    // Speed: heavy = 60-90s period, light = 120-180s
    const periodBase = 60 + (1 - gravNorm) * 120;
    // Add some variation per project
    const periodVariation = (project.color_index * 7) % 20;
    const period = periodBase + periodVariation;
    const speed = (2 * Math.PI) / period;

    const direction = i % 2 === 0 ? 1 : -1;

    // Spread initial angles
    const angle = (i * 2.399) % (2 * Math.PI); // golden angle

    return {
      project,
      angle,
      orbitRadius,
      planetRadius,
      speed,
      direction,
      color: PLANET_COLORS[project.color_index] || PLANET_COLORS[0],
    };
  });
}

export default function SolarSystem({ projects, onNavigate }: SolarSystemProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const planetsRef = useRef<PlanetState[]>([]);
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const visibleRef = useRef(true);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    name: string;
    openTodos: number;
  } | null>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  const prefersReducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Measure container
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setDimensions({ width, height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cx = dimensions.width / 2;
  const cy = dimensions.height / 2;

  // Build planet state when projects or dimensions change
  useEffect(() => {
    if (dimensions.width === 0) return;
    planetsRef.current = buildPlanets(projects, cx, cy);
  }, [projects, dimensions, cx, cy]);

  // Get unique orbit radii for drawing orbit rings
  const orbitRadii = [...new Set(planetsRef.current.map((p) => p.orbitRadius))];

  // Animate
  useEffect(() => {
    if (prefersReducedMotion) return;
    if (dimensions.width === 0) return;

    const container = containerRef.current;
    if (!container) return;

    // IntersectionObserver to pause when off-screen
    const io = new IntersectionObserver(
      ([entry]) => {
        visibleRef.current = entry.isIntersecting;
      },
      { threshold: 0 }
    );
    io.observe(container);

    // Document visibility
    const onVisChange = () => {
      if (document.hidden) {
        visibleRef.current = false;
      }
    };
    document.addEventListener("visibilitychange", onVisChange);

    lastTimeRef.current = 0;

    function animate(time: number) {
      rafRef.current = requestAnimationFrame(animate);

      if (!visibleRef.current) {
        lastTimeRef.current = 0;
        return;
      }

      if (lastTimeRef.current === 0) {
        lastTimeRef.current = time;
        return;
      }

      const dt = (time - lastTimeRef.current) / 1000;
      lastTimeRef.current = time;

      // Clamp dt to avoid jumps
      const clampedDt = Math.min(dt, 0.1);

      const svg = svgRef.current;
      if (!svg) return;

      const planets = planetsRef.current;
      for (let i = 0; i < planets.length; i++) {
        const p = planets[i];
        p.angle += p.speed * p.direction * clampedDt;

        const el = svg.getElementById(`planet-${i}`);
        if (el) {
          const px = cx + Math.cos(p.angle) * p.orbitRadius;
          const py = cy + Math.sin(p.angle) * p.orbitRadius;
          el.setAttribute("cx", String(px));
          el.setAttribute("cy", String(py));
        }
      }
    }

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafRef.current);
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisChange);
    };
  }, [prefersReducedMotion, dimensions, cx, cy]);

  const handleMouseEnter = useCallback(
    (i: number) => {
      const p = planetsRef.current[i];
      if (!p) return;
      const px = cx + Math.cos(p.angle) * p.orbitRadius;
      const py = cy + Math.sin(p.angle) * p.orbitRadius;
      setTooltip({
        x: px,
        y: py - p.planetRadius - 10,
        name: p.project.name,
        openTodos: p.project.open_todos,
      });
    },
    [cx, cy]
  );

  const handleMouseMove = useCallback(
    (i: number) => {
      const p = planetsRef.current[i];
      if (!p) return;
      const px = cx + Math.cos(p.angle) * p.orbitRadius;
      const py = cy + Math.sin(p.angle) * p.orbitRadius;
      setTooltip({
        x: px,
        y: py - p.planetRadius - 10,
        name: p.project.name,
        openTodos: p.project.open_todos,
      });
    },
    [cx, cy]
  );

  const handleMouseLeave = useCallback(() => {
    setTooltip(null);
  }, []);

  // Static positions for reduced motion
  const staticPositions = planetsRef.current.map((p) => ({
    x: cx + Math.cos(p.angle) * p.orbitRadius,
    y: cy + Math.sin(p.angle) * p.orbitRadius,
  }));

  return (
    <div className="solar-system-card" ref={containerRef}>
      {dimensions.width > 0 && (
        <>
          <svg
            ref={svgRef}
            width={dimensions.width}
            height={dimensions.height}
            style={{ position: "absolute", top: 0, left: 0 }}
          >
            <defs>
              <filter id="sun-glow">
                <feGaussianBlur stdDeviation="4" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* Orbit rings */}
            {orbitRadii.map((r, i) => (
              <circle
                key={`orbit-${i}`}
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke="var(--bg3)"
                strokeOpacity={0.08}
                strokeDasharray="4 4"
                strokeWidth={1}
              />
            ))}

            {/* Nucleus */}
            <circle
              cx={cx}
              cy={cy}
              r={6}
              fill="var(--yellow)"
              filter="url(#sun-glow)"
            />
            <circle cx={cx} cy={cy} r={3} fill="var(--yellow)" opacity={0.9} />

            {/* Planets */}
            {planetsRef.current.map((p, i) => {
              const pos = prefersReducedMotion
                ? staticPositions[i]
                : {
                    x: cx + Math.cos(p.angle) * p.orbitRadius,
                    y: cy + Math.sin(p.angle) * p.orbitRadius,
                  };
              return (
                <circle
                  key={`planet-${i}`}
                  id={`planet-${i}`}
                  cx={pos.x}
                  cy={pos.y}
                  r={p.planetRadius}
                  fill={p.color}
                  opacity={0.85}
                  style={{ cursor: "pointer", transition: "r 0.2s" }}
                  onMouseEnter={() => handleMouseEnter(i)}
                  onMouseMove={() => handleMouseMove(i)}
                  onMouseLeave={handleMouseLeave}
                  onClick={() => onNavigate(p.project.path)}
                />
              );
            })}
          </svg>

          {/* HTML tooltip overlay */}
          {tooltip && (
            <div
              className="solar-system-tooltip"
              style={{
                left: tooltip.x,
                top: tooltip.y,
                transform: "translate(-50%, -100%)",
              }}
            >
              <span className="solar-system-tooltip-name">{tooltip.name}</span>
              <span className="solar-system-tooltip-count">
                {tooltip.openTodos} open todo{tooltip.openTodos !== 1 ? "s" : ""}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
