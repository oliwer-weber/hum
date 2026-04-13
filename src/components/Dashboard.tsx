import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TaggedText } from "./TaggedText";

/* ── Scroll-fade hook ──────────────────────────────── */

type FadeEdge = "none" | "top" | "bottom" | "both";

function useScrollFade(deps: unknown[] = []) {
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

/* ── Interfaces ─────────────────────────────────────── */

interface GravityTodo {
  text: string;
  project_name: string;
  project_path: string;
  color_index: number;
  age_days: number;
  is_blocked: boolean;
  is_waiting: boolean;
}

interface ProjectGravity {
  name: string;
  path: string;
  open_todos: number;
  completed_todos: number;
  gravity: number;
  color_index: number;
  todo_pressure: number;
  neglect_signal: number;
  silence_penalty: number;
  blocked_weight: number;
  blocked_count: number;
  waiting_count: number;
  days_silent: number;
  top_todos: GravityTodo[];
}

interface CalendarEvent {
  title: string;
  date: string;
  day: string;
  start: string;
  end: string | null;
  location: string | null;
  attendees: string[] | null;
}

interface CalendarData {
  week: string;
  total_events: number;
  events: CalendarEvent[];
}

/* ── Constants ──────────────────────────────────────── */

const PROJECT_COLORS = [
  "var(--aqua)", "var(--green)", "var(--yellow)",
  "var(--blue)", "var(--purple)", "var(--orange)",
];

/* ── Helpers ────────────────────────────────────────── */

function getTodayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseDateStr(dateStr: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return dateStr.substring(0, 10);
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  return dateStr;
}

function formatDateLabel(dateStr: string): string {
  const today = getTodayStr();
  if (dateStr === today) return "Today";
  const d = new Date(dateStr + "T00:00:00");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
}

function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function formatAge(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "1d";
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

/* ── Month calendar ────────────────────────────────── */

interface MonthGrid {
  year: number;
  month: number;
  monthName: string;
  weeks: { weekNum: number; days: (number | null)[] }[];
}

function buildMonthGrid(now: Date): MonthGrid {
  const year = now.getFullYear();
  const month = now.getMonth();
  const monthNames = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const daysInMonth = lastDay.getDate();
  let startDow = firstDay.getDay() - 1;
  if (startDow < 0) startDow = 6;
  const weeks: { weekNum: number; days: (number | null)[] }[] = [];
  let currentDay = 1;
  while (currentDay <= daysInMonth) {
    const week: (number | null)[] = [];
    const weekDate = new Date(year, month, currentDay);
    const weekNum = getWeekNumber(weekDate);
    for (let dow = 0; dow < 7; dow++) {
      if (weeks.length === 0 && dow < startDow) week.push(null);
      else if (currentDay > daysInMonth) week.push(null);
      else { week.push(currentDay); currentDay++; }
    }
    weeks.push({ weekNum, days: week });
  }
  return { year, month, monthName: monthNames[month], weeks };
}

function MonthCalendar({
  events,
  selectedDate,
  onDayClick,
}: {
  events: CalendarEvent[];
  selectedDate: string;
  onDayClick: (dateStr: string) => void;
}) {
  const now = new Date();
  const today = now.getDate();
  const todayStr = getTodayStr();
  const grid = buildMonthGrid(now);

  const eventDates = new Set(events.map((e) => {
    const d = new Date(e.date);
    return d.getMonth() === grid.month ? d.getDate() : -1;
  }));

  return (
    <div className="month-cal">
      <div className="month-cal-header">
        <span className="month-cal-title">{grid.monthName} {grid.year}</span>
      </div>
      <div className="month-cal-grid">
        <div className="month-cal-row month-cal-row-header">
          <span className="month-cal-wk">W</span>
          {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => (
            <span key={d} className="month-cal-day-header">{d}</span>
          ))}
        </div>
        {grid.weeks.map((week, wi) => (
          <div key={wi} className="month-cal-row">
            <span className="month-cal-wk">{week.weekNum}</span>
            {week.days.map((day, di) => {
              const dateStr = day !== null
                ? `${grid.year}-${String(grid.month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
                : null;
              return (
                <span
                  key={di}
                  className={[
                    "month-cal-day",
                    day === null ? "month-cal-day-empty" : "",
                    day === today ? "month-cal-day-today" : "",
                    dateStr === selectedDate && dateStr !== todayStr ? "month-cal-day-selected" : "",
                    day !== null && eventDates.has(day) ? "month-cal-day-event" : "",
                    di >= 5 ? "month-cal-day-weekend" : "",
                  ].filter(Boolean).join(" ")}
                  onClick={() => dateStr && day !== null && onDayClick(dateStr)}
                  style={{ cursor: day !== null ? "pointer" : undefined }}
                >
                  {day ?? ""}
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Schedule (read-only) ──────────────────────────── */

function ScheduleCard({ event }: { event: CalendarEvent }) {
  return (
    <div className="dash-meeting-block">
      <span className="dash-meeting-time">{event.start}{event.end ? `\u2013${event.end}` : ""}</span>
      <span className="dash-meeting-title">{event.title}</span>
      {event.location && <span className="dash-meeting-location">{event.location}</span>}
    </div>
  );
}

/* ── Main Dashboard ────────────────────────────────── */

interface DashProps {
  refreshKey: number;
  onNavigateToFile?: (path: string) => void;
  isActive?: boolean;
}

export default function Dashboard({ refreshKey, onNavigateToFile, isActive }: DashProps) {
  const [projects, setProjects] = useState<ProjectGravity[]>([]);
  const [calendar, setCalendar] = useState<CalendarData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(getTodayStr());
  const [expandedProject, setExpandedProject] = useState<string | null>(null);

  async function loadGravity() {
    try {
      const data = await invoke<ProjectGravity[]>("get_project_gravity");
      setProjects(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadCalendar() {
    try {
      const raw = await invoke<string>("fetch_calendar");
      setCalendar(JSON.parse(raw));
    } catch (err) {
      console.error("Failed to load calendar:", err);
    }
  }

  useEffect(() => {
    if (isActive === false) return;
    loadGravity();
    loadCalendar();
  }, [refreshKey, isActive]);

  // ── Tier 1: Top 5 gravity-ranked todos across all projects ──
  const gravityMap = useMemo(() => new Map(projects.map(p => [p.name, p.gravity])), [projects]);

  const topTodos = useMemo(() => {
    const all: GravityTodo[] = [];
    for (const p of projects) {
      for (const t of p.top_todos) {
        if (!t.is_blocked && !t.is_waiting) {
          all.push(t);
        }
      }
    }
    all.sort((a, b) => {
      const aScore = Math.min(a.age_days / 14, 5.0) + (gravityMap.get(a.project_name) ?? 0) / 10;
      const bScore = Math.min(b.age_days / 14, 5.0) + (gravityMap.get(b.project_name) ?? 0) / 10;
      return bScore - aScore;
    });
    return all.slice(0, 5);
  }, [projects, gravityMap]);

  // ── Tier 2: Blocked & waiting todos ──
  const stuckTodos = useMemo(() => {
    const all: GravityTodo[] = [];
    for (const p of projects) {
      for (const t of p.top_todos) {
        if (t.is_blocked || t.is_waiting) {
          all.push(t);
        }
      }
    }
    return all;
  }, [projects]);

  // ── Tier 3: Projects sorted by gravity ──
  const projectsWithOpenTodos = useMemo(
    () => projects.filter(p => p.open_todos > 0),
    [projects],
  );

  // ── Assign unique color+shape to visible projects ──
  // Deterministic: derived from project name hash so assignments never shift
  // 4 shape tiers × 6 colors = 24 unique combos before repeating
  const PIP_SHAPES = ["filled-circle", "filled-square", "outline-circle", "outline-square"] as const;

  // Persistent pip assignments — survives re-renders, gravity reorders, projects dropping to 0
  const pipAssignmentsRef = useRef(new Map<string, { color: string; shape: string }>());
  const pipCounterRef = useRef(0);

  const projectPipMap = useMemo(() => {
    const assigned = pipAssignmentsRef.current;
    for (const p of projectsWithOpenTodos) {
      if (!assigned.has(p.name)) {
        const idx = pipCounterRef.current++;
        // Order: first 6 filled-circle, next 6 filled-square, next 6 outline-circle, next 6 outline-square, then wrap
        const colorIdx = idx % PROJECT_COLORS.length;
        const shapeIdx = Math.floor((idx % 24) / PROJECT_COLORS.length);
        assigned.set(p.name, { color: PROJECT_COLORS[colorIdx], shape: PIP_SHAPES[shapeIdx] });
      }
    }
    return new Map(assigned);
  }, [projectsWithOpenTodos]);

  const pipFor = useCallback(
    (name: string) => projectPipMap.get(name) ?? { color: PROJECT_COLORS[0], shape: PIP_SHAPES[0] },
    [projectPipMap],
  );

  // Schedule events for selected date
  const selectedDateEvents = useMemo(
    () => calendar?.events.filter((e) => parseDateStr(e.date) === selectedDate) ?? [],
    [calendar, selectedDate],
  );

  const handleToggleTodo = useCallback(async (todo: GravityTodo) => {
    // Optimistic: remove the todo from local state immediately
    setProjects((prev) =>
      prev.map((p) =>
        p.name === todo.project_name
          ? {
              ...p,
              open_todos: Math.max(0, p.open_todos - 1),
              completed_todos: p.completed_todos + 1,
              top_todos: p.top_todos.filter((t) => t.text !== todo.text),
            }
          : p
      )
    );
    try {
      await invoke("toggle_dashboard_todo", {
        project: todo.project_name,
        todoText: todo.text,
        checked: true,
      });
      // Reload full gravity data so rankings recalculate
      loadGravity();
    } catch (err) {
      console.error("Failed to toggle todo:", err);
      // Revert on error
      loadGravity();
    }
  }, []);

  const handleNavigateToProject = useCallback((name: string) => {
    invoke<string>("vault_resolve_link", { target: name })
      .then((path) => onNavigateToFile?.(path))
      .catch((err) => console.error("Failed to resolve link:", err));
  }, [onNavigateToFile]);

  const { ref: mainRef, edge: mainEdge } = useScrollFade([projects]);

  // ── Render ───────────────────────────────────────

  if (error) {
    return <div className="dash"><div className="dash-error">Failed to load: {error}</div></div>;
  }

  return (
    <div className="dash">
      <div className="dash-layout">
        {/* Left: Gravity tiers */}
        <div className={`dash-main dash-fade-${mainEdge}`} ref={mainRef}>

          {/* Tier 1: Needs attention */}
          <div className="dash-tier">
            <h3 className="dash-tier-title">Needs attention</h3>
            {topTodos.length === 0 && (
              <div className="dash-empty">No open items</div>
            )}
            {topTodos.map((todo, i) => (
              <div key={i} className="gravity-todo">
                <input
                  type="checkbox"
                  className="todo-checkbox"
                  checked={false}
                  onChange={() => handleToggleTodo(todo)}
                />
                <span
                  className={`project-pip project-pip-${pipFor(todo.project_name).shape}`}
                  style={{ "--pip-color": pipFor(todo.project_name).color } as React.CSSProperties}
                />
                <span className="gravity-todo-text"><TaggedText text={todo.text} /></span>
                <span className={`gravity-todo-age ${todo.age_days >= 14 ? "gravity-todo-age-warm" : ""}`}>
                  {formatAge(todo.age_days)}
                </span>
              </div>
            ))}
          </div>

          {/* Tier 2: Stuck */}
          {stuckTodos.length > 0 && (
            <div className="dash-tier dash-tier-stuck">
              <h3 className="dash-tier-title">Stuck</h3>
              {stuckTodos.slice(0, 3).map((todo, i) => (
                <div key={i} className="gravity-todo gravity-todo-stuck">
                  <input
                    type="checkbox"
                    className="todo-checkbox"
                    checked={false}
                    onChange={() => handleToggleTodo(todo)}
                  />
                  <span className="gravity-todo-text"><TaggedText text={todo.text} /></span>
                  <span className={`vault-tag ${todo.is_blocked ? "vault-tag-blocked" : "vault-tag-waiting"}`}>
                    {todo.is_blocked ? "#blocked" : "#waiting"}
                  </span>
                </div>
              ))}
              {stuckTodos.length > 3 && (
                <span className="gravity-more">+{stuckTodos.length - 3} more</span>
              )}
            </div>
          )}

          {/* Tier 3: All projects (collapsed) */}
          <div className="dash-tier dash-tier-projects">
            <h3 className="dash-tier-title">Projects</h3>
            <div className="dash-projects-list">
              {projectsWithOpenTodos.map((project) => (
                <div key={project.name} className="dash-project-row">
                  <div
                    className="dash-project-header"
                    onClick={() => setExpandedProject(
                      expandedProject === project.name ? null : project.name
                    )}
                  >
                    <span
                      className={`project-pip project-pip-${pipFor(project.name).shape}`}
                      style={{ "--pip-color": pipFor(project.name).color } as React.CSSProperties}
                    />
                    <span className="dash-project-name">
                      {project.name}
                    </span>
                    <span className="dash-project-count">{project.open_todos}</span>
                    <button
                      className="dash-project-hub-btn"
                      onClick={(e) => { e.stopPropagation(); handleNavigateToProject(project.name); }}
                      title={`Open ${project.name} hub`}
                      aria-label={`Open ${project.name} hub`}
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 4.5V13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6.5a1 1 0 0 0-1-1H8.5L7 4H3a1 1 0 0 0-1 .5Z" />
                      </svg>
                    </button>
                  </div>
                  {expandedProject === project.name && (
                    <div className="dash-project-todos">
                      {project.top_todos.map((todo, i) => (
                        <div key={i} className="gravity-todo gravity-todo-nested">
                          <input
                            type="checkbox"
                            className="todo-checkbox"
                            checked={false}
                            onChange={() => handleToggleTodo(todo)}
                          />
                          <span className="gravity-todo-text"><TaggedText text={todo.text} /></span>
                          <span className={`gravity-todo-age ${todo.age_days >= 14 ? "gravity-todo-age-warm" : ""}`}>
                            {formatAge(todo.age_days)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right: Calendar sidebar (read-only) */}
        <div className="dash-sidebar">
          <MonthCalendar
            events={calendar?.events ?? []}
            selectedDate={selectedDate}
            onDayClick={setSelectedDate}
          />

          <div className="dash-tier dash-tier-fill">
            <div className="dash-schedule-header">
              <h3 className="dash-tier-title" style={{ marginBottom: 0 }}>
                {formatDateLabel(selectedDate)}
              </h3>
              {selectedDate !== getTodayStr() && (
                <button
                  className="dash-today-btn"
                  onClick={() => setSelectedDate(getTodayStr())}
                >
                  Today
                </button>
              )}
            </div>

            <div className="dash-schedule">
              {selectedDateEvents.map((event, i) => (
                <ScheduleCard key={i} event={event} />
              ))}

              {selectedDateEvents.length === 0 && (
                <div className="dash-schedule-empty">No events</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
