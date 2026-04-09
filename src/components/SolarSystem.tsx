import { useEffect, useRef, useState, useCallback, useMemo } from "react";

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

/* Resolve CSS variable to a hex/rgb string for SVG gradient use */
const COLOR_FALLBACKS: Record<string, string> = {
  "var(--aqua)": "#8ec07c",
  "var(--green)": "#b8bb26",
  "var(--yellow)": "#fabd2f",
  "var(--blue)": "#83a598",
  "var(--purple)": "#d3869b",
  "var(--orange)": "#fe8019",
  "var(--red)": "#fb4934",
};

interface PlanetState {
  project: ProjectGravity;
  angle: number;
  orbitRadius: number;
  planetRadius: number;
  speed: number; // radians per second
  direction: number; // 1 or -1
  color: string;
  colorHex: string;
}

function buildPlanets(projects: ProjectGravity[], cx: number, cy: number): PlanetState[] {
  if (projects.length === 0) return [];

  const sorted = [...projects].sort((a, b) => b.gravity - a.gravity);
  const maxGravity = Math.max(...sorted.map((p) => p.gravity), 1);
  const count = sorted.length;

  const minOrbit = Math.min(cx, cy) * 0.2;
  const maxOrbit = Math.min(cx, cy) * 0.85;

  return sorted.map((project, i) => {
    const gravNorm = project.gravity / maxGravity; // 0..1, 1 = highest

    // Continuous orbit distribution — each planet gets its own unique orbit
    const orbitRadius = minOrbit + ((maxOrbit - minOrbit) * i) / Math.max(count - 1, 1);

    // Planet size: 12..32 based on gravity
    const planetRadius = 12 + gravNorm * 20;

    // Speed: heavy = 40-70s period, light = 100-200s
    const periodBase = 40 + (1 - gravNorm) * 160;
    const periodVariation = (project.color_index * 7) % 20;
    const period = periodBase + periodVariation;
    const speed = (2 * Math.PI) / period;

    const direction = i % 2 === 0 ? 1 : -1;

    // Spread initial angles
    const angle = (i * 2.399) % (2 * Math.PI); // golden angle

    const color = PLANET_COLORS[project.color_index] || PLANET_COLORS[0];

    return {
      project,
      angle,
      orbitRadius,
      planetRadius,
      speed,
      direction,
      color,
      colorHex: COLOR_FALLBACKS[color] || "#8ec07c",
    };
  });
}

/** Deterministic pseudo-random from a seed */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function generateStars(width: number, height: number, count: number) {
  const rand = seededRandom(42);
  const stars: { x: number; y: number; opacity: number }[] = [];
  for (let i = 0; i < count; i++) {
    stars.push({
      x: rand() * width,
      y: rand() * height,
      opacity: 0.1 + rand() * 0.25,
    });
  }
  return stars;
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

  // Filter out zero-gravity projects
  const activeProjects = useMemo(
    () => projects.filter((p) => p.open_todos > 0),
    [projects]
  );

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
    planetsRef.current = buildPlanets(activeProjects, cx, cy);
  }, [activeProjects, dimensions, cx, cy]);

  // Get unique orbit radii for drawing orbit rings
  const orbitRadii = [...new Set(planetsRef.current.map((p) => p.orbitRadius))];

  // Stars (deterministic)
  const stars = useMemo(
    () =>
      dimensions.width > 0
        ? generateStars(dimensions.width, dimensions.height, 60)
        : [],
    [dimensions.width, dimensions.height]
  );

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

  // Empty state
  if (activeProjects.length === 0 && dimensions.width > 0) {
    return (
      <div className="solar-system-card" ref={containerRef}>
        <div className="solar-system-empty">
          <span className="solar-system-empty-text">All clear -- no active projects</span>
        </div>
      </div>
    );
  }

  return (
    <div className="solar-system-card" ref={containerRef}>
      {dimensions.width > 0 && (
        <>
          <svg
            ref={svgRef}
            width={dimensions.width}
            height={dimensions.height}
            className="solar-system-svg"
          >
            <defs>
              {/* Sun glow filter */}
              <filter id="sun-glow" x="-100%" y="-100%" width="300%" height="300%">
                <feGaussianBlur stdDeviation="6" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>

              {/* Per-planet 3D sphere gradient and glow filter */}
              {planetsRef.current.map((p, i) => (
                <g key={`defs-${i}`}>
                  <radialGradient
                    id={`planet-grad-${i}`}
                    cx="35%"
                    cy="35%"
                    r="65%"
                    fx="35%"
                    fy="35%"
                  >
                    <stop offset="0%" stopColor="white" stopOpacity={0.6} />
                    <stop offset="40%" stopColor={p.colorHex} stopOpacity={1} />
                    <stop offset="100%" stopColor="#1d2021" stopOpacity={0.9} />
                  </radialGradient>
                  <filter
                    id={`glow-${i}`}
                    x="-50%"
                    y="-50%"
                    width="200%"
                    height="200%"
                  >
                    <feGaussianBlur stdDeviation="3" result="blur" />
                    <feFlood
                      floodColor={p.colorHex}
                      floodOpacity={0.35}
                      result="color"
                    />
                    <feComposite in="color" in2="blur" operator="in" result="shadow" />
                    <feMerge>
                      <feMergeNode in="shadow" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                </g>
              ))}
            </defs>

            {/* Stars */}
            {stars.map((s, i) => (
              <circle
                key={`star-${i}`}
                cx={s.x}
                cy={s.y}
                r={1}
                fill="#fff"
                opacity={s.opacity}
              />
            ))}

            {/* Orbit rings */}
            {orbitRadii.map((r, i) => (
              <circle
                key={`orbit-${i}`}
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke="#928374"
                strokeOpacity={0.06}
                strokeWidth={0.5}
              />
            ))}

            {/* Layered Sun */}
            {/* Corona (pulsing) */}
            <circle
              className="solar-system-corona"
              cx={cx}
              cy={cy}
              r={20}
              fill="var(--yellow)"
              opacity={0.12}
              filter="url(#sun-glow)"
            />
            {/* Mid glow */}
            <circle cx={cx} cy={cy} r={12} fill="var(--yellow)" opacity={0.4} />
            {/* Bright core */}
            <circle cx={cx} cy={cy} r={6} fill="white" opacity={0.9} />

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
                  fill={`url(#planet-grad-${i})`}
                  filter={`url(#glow-${i})`}
                  style={{ cursor: "pointer", transition: "r 0.2s" }}
                  onMouseEnter={() => handleMouseEnter(i)}
                  onMouseMove={() => handleMouseMove(i)}
                  onMouseLeave={handleMouseLeave}
                  onClick={() => onNavigate(p.project.path)}
                />
              );
            })}
          </svg>

          {/* HTML tooltip overlay — outside SVG/perspective */}
          {tooltip && (
            <div
              className="solar-system-tooltip"
              style={{
                left: tooltip.x,
                top: tooltip.y,
                transform: "translate(-50%, -100%)",
                transformStyle: "flat",
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
