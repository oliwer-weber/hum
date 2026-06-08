import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TaggedText } from "./TaggedText";
import TodoCard from "./TodoCard";
import { useScrollFade } from "../hooks/useScrollFade";

/* ── Interfaces ─────────────────────────────────────── */

interface SubtaskRow {
  id: string | null;
  text: string;
  checked: boolean;
}

interface GravityTodo {
  id: string | null;
  text: string;
  project_name: string;
  project_path: string;
  color_index: number;
  age_days: number;
  is_blocked: boolean;
  is_waiting: boolean;
  body: string;
  subtasks: SubtaskRow[];
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

interface SnoozeEntry {
  project: string;
  until: string;
}

interface FocusState {
  focus: string[];
  focusSetAt: string;
  snoozed: SnoozeEntry[];
  today: string[];
}

// A todo resolved from the day's hand-picked list (get_today_todos).
interface TodayTodo {
  id: string;
  text: string;
  body: string;
  status: string;
  created: string | null;
  completed: string | null;
  tags: string[];
  project_name: string;
  project_path: string;
}

const DAMPEN_FACTOR = 0.3;

// Hard cap on the Today list. Forces a conscious trade: to add another you
// must complete or remove one, so Today never silently becomes a pile.
const TODAY_CAP = 5;

/* ── Constants ──────────────────────────────────────── */

const PROJECT_COLORS = [
  "var(--emerald)", "var(--sage)", "var(--lime)",
  "var(--emerald-dim)", "var(--sage-dim)", "var(--lime-dim)",
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

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDaysStr(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return ymd(d);
}

function nextMondayStr(): string {
  const d = new Date();
  const dow = d.getDay(); // 0=Sun..6=Sat
  const daysUntilMonday = dow === 0 ? 1 : (8 - dow);
  d.setDate(d.getDate() + daysUntilMonday);
  return ymd(d);
}

function formatSnoozeUntil(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return dateStr;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}`;
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

// "08:30" -> 510 minutes past midnight. Null for anything unparseable.
function timeToMin(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(t.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function minToLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function nowMinutes(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// "Fri · 5 June" — the calm date line that replaces the month grid in Today.
function formatTodayHeader(): string {
  const d = new Date();
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  return `${days[d.getDay()]} · ${d.getDate()} ${months[d.getMonth()]}`;
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

/* ── Day timeline (horizontal time track) ────────────
 * A conventional schedule track: a left-to-right time axis with each meeting as
 * a true-to-time block (positioned by start, sized by duration). A now-line
 * marks the current moment, hour ticks anchor the axis, and blocks are tinted
 * by activity (same title -> same colour) using theme tokens, so the theme
 * engine owns the look. Titles that don't fit a narrow block fall back to hover. */

interface TimelineSeg {
  title: string;
  location: string | null;
  startMin: number;
  endMin: number;
  dur: number;
}

// Same title -> same colour, so a repeated meeting reads as the same thing
// across the day. Reuses the project pips' green-family tokens (aqua stays
// reserved for the now-line).
function activityKey(title: string): string {
  return title.trim().toLowerCase();
}

function DayTimeline({ events }: { events: CalendarEvent[] }) {
  const [nowMin, setNowMin] = useState(() => nowMinutes());
  const [hovered, setHovered] = useState<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNowMin(nowMinutes()), 30000);
    return () => clearInterval(id);
  }, []);

  const segs = useMemo<TimelineSeg[]>(() => {
    const out: TimelineSeg[] = [];
    for (const e of events) {
      const s = timeToMin(e.start);
      if (s === null) continue;
      let en = timeToMin(e.end);
      if (en === null || en <= s) en = s + 30; // sane fallback for open/instant events
      out.push({ title: e.title, location: e.location, startMin: s, endMin: en, dur: en - s });
    }
    out.sort((a, b) => a.startMin - b.startMin);
    return out;
  }, [events]);

  // One colour per distinct activity, assigned in order of first appearance.
  const activityColor = useMemo(() => {
    const map = new Map<string, string>();
    let i = 0;
    for (const s of segs) {
      const key = activityKey(s.title);
      if (!map.has(key)) {
        map.set(key, PROJECT_COLORS[i % PROJECT_COLORS.length]);
        i++;
      }
    }
    return map;
  }, [segs]);
  const colorFor = useCallback(
    (s: TimelineSeg) => activityColor.get(activityKey(s.title)) ?? PROJECT_COLORS[0],
    [activityColor],
  );

  // Window snaps to whole hours around the day, so the hour ticks read cleanly.
  // Falls back to a calm working day when nothing's scheduled.
  const [winStart, winEnd] = useMemo(() => {
    if (segs.length === 0) return [8 * 60, 17 * 60];
    const minS = Math.min(...segs.map((s) => s.startMin));
    const maxE = Math.max(...segs.map((s) => s.endMin));
    return [Math.floor(minS / 60) * 60, Math.ceil(maxE / 60) * 60];
  }, [segs]);

  const span = winEnd - winStart || 1;
  const pct = useCallback((min: number) => ((min - winStart) / span) * 100, [winStart, span]);

  const blocks = useMemo(
    () => segs.map((s, i) => ({
      i,
      left: pct(s.startMin),
      width: pct(s.endMin) - pct(s.startMin),
      color: colorFor(s),
      time: minToLabel(s.startMin),
      title: s.title,
    })),
    [segs, pct, colorFor],
  );

  const hours = useMemo(() => {
    const out: { left: number; label: string }[] = [];
    for (let m = winStart; m <= winEnd; m += 60) {
      out.push({ left: pct(m), label: String(Math.floor(m / 60)).padStart(2, "0") });
    }
    return out;
  }, [winStart, winEnd, pct]);

  const nowPct = segs.length > 0 && nowMin >= winStart && nowMin <= winEnd ? pct(nowMin) : null;

  const current = segs.find((s) => nowMin >= s.startMin && nowMin < s.endMin) ?? null;
  const next = segs.find((s) => s.startMin > nowMin) ?? null;

  const tipSeg = hovered !== null ? segs[hovered] : null;

  return (
    <div className="today-timeline">
      <div className="timeline-meta">
        <span className="timeline-now">
          {current ? (
            <><span className="timeline-meta-label">Now</span> {current.title}</>
          ) : (
            <span className="timeline-meta-dim">{segs.length ? "Between things" : "Nothing scheduled"}</span>
          )}
        </span>
        {next && (
          <span className="timeline-next">
            <span className="timeline-meta-label">Next</span> {minToLabel(next.startMin)} {next.title}
          </span>
        )}
      </div>

      <div className="timeline-track">
        {blocks.map((b) => (
          <div
            key={b.i}
            className={`timeline-block${hovered === b.i ? " is-hovered" : ""}`}
            style={{ left: `${b.left}%`, width: `calc(${b.width}% - 2px)`, ["--block-color" as string]: b.color }}
            onMouseEnter={() => setHovered(b.i)}
            onMouseLeave={() => setHovered((p) => (p === b.i ? null : p))}
          >
            <span className="timeline-block-time">{b.time}</span>
            <span className="timeline-block-title">{b.title}</span>
          </div>
        ))}

        {nowPct !== null && (
          <div className="timeline-nowmark" style={{ left: `${nowPct}%` }}>
            <span className="timeline-nowmark-dot" />
          </div>
        )}

        {tipSeg && (
          <div
            className="timeline-tip"
            style={{ left: `${pct(tipSeg.startMin) + (pct(tipSeg.endMin) - pct(tipSeg.startMin)) / 2}%` }}
          >
            <span className="timeline-tip-time">{minToLabel(tipSeg.startMin) + "–" + minToLabel(tipSeg.endMin)}</span>
            <span className="timeline-tip-title">{tipSeg.title}</span>
            {tipSeg.location && <span className="timeline-tip-loc">{tipSeg.location}</span>}
          </div>
        )}
      </div>

      <div className="timeline-axis">
        {hours.map((h, i) => (
          <span key={i} className="timeline-tick-wrap" style={{ left: `${h.left}%` }}>
            <span className="timeline-tick-mark" />
            <span className="timeline-tick">{h.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── Main Dashboard ────────────────────────────────── */

interface DashProps {
  refreshKey: number;
  onOpenProjectHub?: (projectPath: string) => void;
}

export default function Dashboard({ refreshKey, onOpenProjectHub }: DashProps) {
  const [projects, setProjects] = useState<ProjectGravity[]>([]);
  const [calendar, setCalendar] = useState<CalendarData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(getTodayStr());
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  const [focusState, setFocusState] = useState<FocusState>({ focus: [], focusSetAt: "", snoozed: [], today: [] });
  // The day's hand-picked todos, resolved to full rows for the calm Today view.
  const [todayTodos, setTodayTodos] = useState<TodayTodo[]>([]);
  // "today" is the calm default; "plan" is the deliberate context switch into
  // the full board, where you triage and pick the day's few.
  const [view, setView] = useState<"today" | "plan">("today");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draftFocus, setDraftFocus] = useState<string[]>([]);
  const [snoozeMenuFor, setSnoozeMenuFor] = useState<string | null>(null);
  // The todo whose action card is open, with the row rect for anchoring.
  const [card, setCard] = useState<{ id: string; rect: DOMRect } | null>(null);

  // When `preserveOrder` is true, the fresh backend data is re-sorted to match
  // the previous visual order. Used after in-place interactions (ticking a
  // todo) so the list doesn't shuffle under the user's cursor. External
  // refreshes (mount, refreshKey) call with the default — the order resets
  // naturally next time the user returns to the tab.
  async function loadGravity(preserveOrder = false) {
    try {
      const data = await invoke<ProjectGravity[]>("get_project_gravity");
      setProjects((prev) => {
        if (!preserveOrder || prev.length === 0) return data;
        const prevOrder = new Map(prev.map((p, i) => [p.path, i]));
        return [...data].sort((a, b) => {
          const ai = prevOrder.get(a.path) ?? Infinity;
          const bi = prevOrder.get(b.path) ?? Infinity;
          return ai - bi;
        });
      });
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

  async function loadFocus() {
    try {
      const data = await invoke<FocusState>("get_focus_state");
      setFocusState(data);
    } catch (err) {
      console.error("Failed to load focus state:", err);
    }
  }

  async function loadToday() {
    try {
      const data = await invoke<TodayTodo[]>("get_today_todos");
      setTodayTodos(data);
    } catch (err) {
      console.error("Failed to load today's todos:", err);
    }
  }

  useEffect(() => {
    loadGravity();
    loadCalendar();
    loadFocus();
    loadToday();
  }, [refreshKey]);

  const focusSet = useMemo(() => new Set(focusState.focus), [focusState.focus]);
  const hasFocus = focusSet.size > 0;
  const todayIdSet = useMemo(() => new Set(focusState.today), [focusState.today]);
  const snoozedSet = useMemo(
    () => new Set(focusState.snoozed.map((s) => s.project)),
    [focusState.snoozed],
  );
  const snoozeUntilByPath = useMemo(
    () => new Map(focusState.snoozed.map((s) => [s.project, s.until])),
    [focusState.snoozed],
  );

  // ── Tier 1: Top 5 gravity-ranked todos across all projects ──
  const gravityMap = useMemo(() => new Map(projects.map(p => [p.name, p.gravity])), [projects]);

  const topTodos = useMemo(() => {
    const all: GravityTodo[] = [];
    for (const p of projects) {
      if (snoozedSet.has(p.path)) continue;
      for (const t of p.top_todos) {
        if (!t.is_blocked && !t.is_waiting) {
          all.push(t);
        }
      }
    }
    all.sort((a, b) => {
      const factorA = hasFocus && !focusSet.has(a.project_path) ? DAMPEN_FACTOR : 1;
      const factorB = hasFocus && !focusSet.has(b.project_path) ? DAMPEN_FACTOR : 1;
      const aScore = Math.min(a.age_days / 14, 5.0) + ((gravityMap.get(a.project_name) ?? 0) / 10) * factorA;
      const bScore = Math.min(b.age_days / 14, 5.0) + ((gravityMap.get(b.project_name) ?? 0) / 10) * factorB;
      return bScore - aScore;
    });
    return all.slice(0, 5);
  }, [projects, gravityMap, focusSet, hasFocus, snoozedSet]);

  // ── Tier 2: Blocked & waiting todos ──
  const stuckTodos = useMemo(() => {
    const all: GravityTodo[] = [];
    for (const p of projects) {
      if (snoozedSet.has(p.path)) continue;
      for (const t of p.top_todos) {
        if (t.is_blocked || t.is_waiting) {
          all.push(t);
        }
      }
    }
    return all;
  }, [projects, snoozedSet]);

  // ── Tier 3: Projects sorted by gravity (snoozed filtered to separate list) ──
  const allOpenProjects = useMemo(
    () => projects.filter(p => p.open_todos > 0),
    [projects],
  );
  const projectsWithOpenTodos = useMemo(
    () => allOpenProjects.filter(p => !snoozedSet.has(p.path)),
    [allOpenProjects, snoozedSet],
  );
  const snoozedProjects = useMemo(
    () => allOpenProjects.filter(p => snoozedSet.has(p.path)),
    [allOpenProjects, snoozedSet],
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
    for (const p of allOpenProjects) {
      if (!assigned.has(p.name)) {
        const idx = pipCounterRef.current++;
        // Order: first 6 filled-circle, next 6 filled-square, next 6 outline-circle, next 6 outline-square, then wrap
        const colorIdx = idx % PROJECT_COLORS.length;
        const shapeIdx = Math.floor((idx % 24) / PROJECT_COLORS.length);
        assigned.set(p.name, { color: PROJECT_COLORS[colorIdx], shape: PIP_SHAPES[shapeIdx] });
      }
    }
    return new Map(assigned);
  }, [allOpenProjects]);

  const pipFor = useCallback(
    (name: string) => projectPipMap.get(name) ?? { color: PROJECT_COLORS[0], shape: PIP_SHAPES[0] },
    [projectPipMap],
  );

  // Schedule events for selected date
  const selectedDateEvents = useMemo(
    () => calendar?.events.filter((e) => parseDateStr(e.date) === selectedDate) ?? [],
    [calendar, selectedDate],
  );

  // Today's events drive the Today-view wave (always today, not the selectable
  // date the Plan board's calendar uses).
  const todayEvents = useMemo(
    () => calendar?.events.filter((e) => parseDateStr(e.date) === getTodayStr()) ?? [],
    [calendar],
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
      loadGravity(true);
      loadToday();
    } catch (err) {
      console.error("Failed to toggle todo:", err);
      loadGravity(true);
      loadToday();
    }
  }, []);

  // Open the action card for a todo by id, anchored to its row. Needs a stamped
  // id; the index stamps every todo on launch, so this is virtually always
  // present. Used from both the gravity tiers and the calm Today rows.
  const openCardAt = useCallback((target: HTMLElement, id: string | null) => {
    if (!id) return;
    const row = target.closest(".gravity-todo, .today-row");
    const rect = (row ?? target).getBoundingClientRect();
    setCard({ id, rect });
  }, []);

  const openCard = useCallback((e: React.MouseEvent | React.KeyboardEvent, todo: GravityTodo) => {
    openCardAt(e.currentTarget as HTMLElement, todo.id);
  }, [openCardAt]);

  // Card actions edit todos.md + the index server-side; re-derive gravity so
  // status changes, splits and deletes move the todo across tiers live, and
  // refresh the Today list since a deleted/split/completed pick should drop out.
  const handleCardChanged = useCallback(() => {
    loadGravity(true);
    loadToday();
  }, []);

  // Toggle a todo's membership in the day's hand-picked few. The card stays
  // open and reflects the new state via its `inToday` prop.
  const handleToggleToday = useCallback(async (id: string) => {
    const current = focusState.today ?? [];
    const isIn = current.includes(id);
    // Guard the cap (the card also disables the button, this is belt-and-suspenders).
    if (!isIn && current.length >= TODAY_CAP) return;
    const next = isIn
      ? current.filter((x) => x !== id)
      : [...current, id];
    try {
      await invoke("set_today", { ids: next });
      await loadFocus();
      await loadToday();
    } catch (err) {
      console.error("Failed to update today:", err);
    }
  }, [focusState.today]);

  // Complete a todo straight from the calm Today list. Optimistically drop it,
  // then persist + refresh both the Today list and gravity.
  const handleCompleteToday = useCallback(async (todo: TodayTodo) => {
    setTodayTodos((prev) => prev.filter((t) => t.id !== todo.id));
    try {
      await invoke("toggle_dashboard_todo", {
        project: todo.project_name,
        todoText: todo.id,
        checked: true,
      });
      loadGravity(true);
      // loadToday self-heals the stored list (drops the now-completed pick);
      // loadFocus then refreshes the count so the freed slot registers.
      await loadToday();
      await loadFocus();
    } catch (err) {
      console.error("Failed to complete today todo:", err);
      loadToday();
    }
  }, []);

  const handleToggleSubtask = useCallback(async (parent: GravityTodo, sub: SubtaskRow) => {
    try {
      await invoke("toggle_dashboard_todo", {
        project: parent.project_name,
        todoText: sub.id ?? sub.text,
        checked: !sub.checked,
      });
      loadGravity(true);
    } catch (err) {
      console.error("Failed to toggle sub-task:", err);
      loadGravity(true);
    }
  }, []);

  const handleToggleProjectFocus = useCallback(async (projectPath: string) => {
    const next = focusSet.has(projectPath)
      ? focusState.focus.filter((p) => p !== projectPath)
      : [...focusState.focus, projectPath];
    try {
      await invoke("set_focus", { projects: next });
      await loadFocus();
    } catch (err) {
      console.error("Failed to toggle focus:", err);
    }
  }, [focusSet, focusState.focus]);

  const handleSnooze = useCallback(async (projectPath: string, until: string) => {
    try {
      await invoke("snooze_project", { project: projectPath, until });
      await loadFocus();
      setSnoozeMenuFor(null);
    } catch (err) {
      console.error("Failed to snooze:", err);
    }
  }, []);

  const handleUnsnooze = useCallback(async (projectPath: string) => {
    try {
      await invoke("unsnooze_project", { project: projectPath });
      await loadFocus();
    } catch (err) {
      console.error("Failed to unsnooze:", err);
    }
  }, []);

  const handleOpenProjectHub = useCallback((projectPath: string) => {
    onOpenProjectHub?.(projectPath);
  }, [onOpenProjectHub]);

  const { ref: mainRef, edge: mainEdge } = useScrollFade([projects]);

  // ── Render ───────────────────────────────────────

  if (error) {
    return <div className="dash"><div className="dash-error">Failed to load: {error}</div></div>;
  }

  // Calendar + schedule column — shared by the Today view and the Plan board so
  // the day's overview stays glanceable from either.
  const calendarSidebar = (
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
  );

  return (
    <div className="dash">
      {view === "today" ? (
        /* ── Calm default: the day's hand-picked few, the day's wave below ── */
        <div className="today">
          <div className="today-page">
            <div className="today-head">
              <div className="today-head-left">
                <h2 className="today-title">Today</h2>
                <span className="today-count">{todayTodos.length}/{TODAY_CAP}</span>
              </div>
              <div className="today-head-right">
                <span className="today-date">{formatTodayHeader()}</span>
                <button
                  type="button"
                  className="today-plan-btn"
                  onClick={() => setView("plan")}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="7" height="7" rx="1" />
                    <rect x="14" y="3" width="7" height="7" rx="1" />
                    <rect x="3" y="14" width="7" height="7" rx="1" />
                    <rect x="14" y="14" width="7" height="7" rx="1" />
                  </svg>
                  Plan
                </button>
              </div>
            </div>

            {todayTodos.length === 0 ? (
              <div className="today-empty">
                <p className="today-empty-title">Nothing set for today.</p>
                <p className="today-empty-sub">Pick a few things worth your focus.</p>
                <button
                  type="button"
                  className="today-empty-btn"
                  onClick={() => setView("plan")}
                >
                  Plan today
                </button>
              </div>
            ) : (
              <ul className="today-list">
                {todayTodos.map((todo) => (
                  <li key={todo.id} className="today-row">
                    <input
                      type="checkbox"
                      className="todo-checkbox"
                      checked={false}
                      onChange={() => handleCompleteToday(todo)}
                      aria-label="Mark complete"
                    />
                    <span
                      className="today-row-text"
                      role="button"
                      tabIndex={0}
                      onClick={(e) => openCardAt(e.currentTarget, todo.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openCardAt(e.currentTarget, todo.id);
                        }
                      }}
                    >
                      <TaggedText text={todo.text} />
                    </span>
                    <span className="today-row-project">{todo.project_name}</span>
                  </li>
                ))}
              </ul>
            )}

            <DayTimeline events={todayEvents} />
          </div>
        </div>
      ) : (
      /* ── Plan: the full board, entered on purpose ── */
      <div className="dash-plan">
        <div className="dash-plan-bar">
          <button
            type="button"
            className="dash-plan-back"
            onClick={() => setView("today")}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 18-6-6 6-6" />
            </svg>
            Today
          </button>
          <span className="dash-plan-title">Planning</span>
        </div>
      <div className="dash-layout">
        {/* Left: Gravity tiers */}
        <div className={`dash-main dash-fade-${mainEdge}`} ref={mainRef}>

          {/* Focus strip — only renders when focus is set or picker is open */}
          {(hasFocus || pickerOpen) && (
          <div className="focus-strip">
            {!pickerOpen && hasFocus && (
              <div className="focus-strip-active">
                <span className="focus-strip-label">Focused</span>
                <div className="focus-strip-pills">
                  {focusState.focus.map((path) => {
                    const p = projects.find((x) => x.path === path);
                    if (!p) return null;
                    return (
                      <span key={path} className="focus-strip-pill">
                        <span
                          className={`project-pip project-pip-${pipFor(p.name).shape}`}
                          style={{ "--pip-color": pipFor(p.name).color } as React.CSSProperties}
                        />
                        {p.name}
                      </span>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="focus-strip-btn focus-strip-btn-ghost"
                  onClick={() => { setDraftFocus(focusState.focus); setPickerOpen(true); }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="focus-strip-btn focus-strip-btn-ghost"
                  onClick={async () => {
                    await invoke("set_focus", { projects: [] });
                    await loadFocus();
                  }}
                >
                  Clear
                </button>
              </div>
            )}

            {pickerOpen && (
              <div className="focus-picker">
                <div className="focus-picker-header">Focus for today</div>
                <div className="focus-picker-list">
                  {projects.map((p) => {
                    const checked = draftFocus.includes(p.path);
                    return (
                      <label key={p.path} className="focus-picker-item">
                        <input
                          type="checkbox"
                          className="todo-checkbox"
                          checked={checked}
                          onChange={() =>
                            setDraftFocus((prev) =>
                              prev.includes(p.path)
                                ? prev.filter((x) => x !== p.path)
                                : [...prev, p.path]
                            )
                          }
                        />
                        <span
                          className={`project-pip project-pip-${pipFor(p.name).shape}`}
                          style={{ "--pip-color": pipFor(p.name).color } as React.CSSProperties}
                        />
                        <span className="focus-picker-item-name">{p.name}</span>
                      </label>
                    );
                  })}
                </div>
                <div className="focus-picker-actions">
                  <button
                    type="button"
                    className="focus-strip-btn focus-strip-btn-ghost"
                    onClick={() => setPickerOpen(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="focus-strip-btn focus-strip-btn-primary"
                    onClick={async () => {
                      await invoke("set_focus", { projects: draftFocus });
                      await loadFocus();
                      setPickerOpen(false);
                    }}
                  >
                    Save
                  </button>
                </div>
              </div>
            )}
          </div>
          )}

          {/* Tier 1: Needs attention */}
          <div className="dash-tier">
            <h3 className="dash-tier-title">Needs attention</h3>
            {topTodos.length === 0 && (
              <div className="dash-empty">No open items</div>
            )}
            {topTodos.map((todo, i) => {
              const subtasksVisible = todo.subtasks.slice(0, 2);
              const hiddenSubtasks = Math.max(0, todo.subtasks.length - subtasksVisible.length);
              return (
                <div key={i} className="gravity-todo-group">
                  <div className="gravity-todo">
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
                    <span
                      className="gravity-todo-text gravity-todo-text-clickable"
                      role="button"
                      tabIndex={0}
                      onClick={(e) => openCard(e, todo)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openCard(e, todo);
                        }
                      }}
                    ><TaggedText text={todo.text} /></span>
                    <span className={`gravity-todo-age ${todo.age_days >= 14 ? "gravity-todo-age-warm" : ""}`}>
                      {formatAge(todo.age_days)}
                    </span>
                  </div>
                  {(todo.body.trim().length > 0 || subtasksVisible.length > 0) && (
                    <div className="gravity-todo-extras">
                      {todo.body.trim().length > 0 && (
                        <p className="gravity-todo-body" title={todo.body}>{todo.body}</p>
                      )}
                      {subtasksVisible.length > 0 && (
                        <ul className="gravity-todo-subtasks">
                          {subtasksVisible.map((sub, si) => (
                            <li key={si} className="gravity-todo-subtask">
                              <input
                                type="checkbox"
                                className="todo-checkbox"
                                checked={sub.checked}
                                onChange={() => handleToggleSubtask(todo, sub)}
                                aria-label={sub.checked ? "Mark sub-task incomplete" : "Mark sub-task complete"}
                              />
                              <span className={`gravity-todo-subtask-text ${sub.checked ? "gravity-todo-subtask-text-done" : ""}`}>
                                {sub.text}
                              </span>
                              <span className={`gravity-todo-age ${todo.age_days >= 14 ? "gravity-todo-age-warm" : ""}`}>
                                {formatAge(todo.age_days)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {hiddenSubtasks > 0 && (
                        <button
                          type="button"
                          className="gravity-todo-more"
                          onClick={() => handleOpenProjectHub(todo.project_path)}
                        >
                          + {hiddenSubtasks} more in {todo.project_name}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
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
                  <span
                    className="gravity-todo-text gravity-todo-text-clickable"
                    role="button"
                    tabIndex={0}
                    onClick={(e) => openCard(e, todo)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openCard(e, todo);
                      }
                    }}
                  ><TaggedText text={todo.text} /></span>
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
              {projectsWithOpenTodos.map((project) => {
                const rowActive = snoozeMenuFor === project.path;
                return (
                <div
                  key={project.name}
                  className={`dash-project-row${focusSet.has(project.path) ? " is-focused" : ""}${rowActive ? " is-active" : ""}`}
                  style={{ "--row-accent": pipFor(project.name).color } as React.CSSProperties}
                >
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
                    <div className="dash-project-actions-anchor">
                      <span className="dash-project-count">{project.open_todos}</span>
                      <button
                        className="dash-project-hub-btn"
                        onClick={(e) => { e.stopPropagation(); handleOpenProjectHub(project.path); }}
                        data-tooltip={`Open ${project.name} hub`}
                        aria-label={`Open ${project.name} hub`}
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M2 4.5V13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6.5a1 1 0 0 0-1-1H8.5L7 4H3a1 1 0 0 0-1 .5Z" />
                        </svg>
                      </button>
                    </div>
                    <div className="dash-project-actions-slide" onClick={(e) => e.stopPropagation()}>
                      <button
                        className={`dash-project-hub-btn dash-project-focus-btn${focusSet.has(project.path) ? " is-focused" : ""}`}
                        onClick={(e) => { e.stopPropagation(); handleToggleProjectFocus(project.path); }}
                        data-tooltip={focusSet.has(project.path) ? `Remove ${project.name} from focus` : `Focus ${project.name}`}
                        aria-label={focusSet.has(project.path) ? `Remove ${project.name} from focus` : `Focus ${project.name}`}
                        aria-pressed={focusSet.has(project.path)}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                        </svg>
                      </button>
                      <button
                        className="dash-project-hub-btn dash-project-snooze-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSnoozeMenuFor(snoozeMenuFor === project.path ? null : project.path);
                        }}
                        data-tooltip={`Snooze ${project.name}`}
                        aria-label={`Snooze ${project.name}`}
                        aria-expanded={snoozeMenuFor === project.path}
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="8" cy="8" r="6" />
                          <path d="M8 4.5V8l2.5 1.75" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  {snoozeMenuFor === project.path && (
                    <div className="snooze-menu">
                      <span className="snooze-menu-label">Snooze until</span>
                      <button
                        type="button"
                        className="snooze-preset"
                        onClick={() => handleSnooze(project.path, addDaysStr(1))}
                      >
                        Tomorrow
                      </button>
                      <button
                        type="button"
                        className="snooze-preset"
                        onClick={() => handleSnooze(project.path, nextMondayStr())}
                      >
                        Next Mon
                      </button>
                      <button
                        type="button"
                        className="snooze-preset"
                        onClick={() => handleSnooze(project.path, addDaysStr(7))}
                      >
                        1 week
                      </button>
                    </div>
                  )}
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
                          <span
                      className="gravity-todo-text gravity-todo-text-clickable"
                      role="button"
                      tabIndex={0}
                      onClick={(e) => openCard(e, todo)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openCard(e, todo);
                        }
                      }}
                    ><TaggedText text={todo.text} /></span>
                          <span className={`gravity-todo-age ${todo.age_days >= 14 ? "gravity-todo-age-warm" : ""}`}>
                            {formatAge(todo.age_days)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                );
              })}
            </div>

            {snoozedProjects.length > 0 && (
              <div className="snoozed-section">
                <div className="snoozed-section-title">Snoozed</div>
                {snoozedProjects.map((project) => {
                  const until = snoozeUntilByPath.get(project.path);
                  return (
                    <div key={project.name} className="snoozed-row">
                      <span
                        className={`project-pip project-pip-${pipFor(project.name).shape}`}
                        style={{ "--pip-color": pipFor(project.name).color } as React.CSSProperties}
                      />
                      <span className="snoozed-row-name">{project.name}</span>
                      {until && (
                        <span className="snoozed-row-until">until {formatSnoozeUntil(until)}</span>
                      )}
                      <button
                        type="button"
                        className="focus-strip-btn focus-strip-btn-ghost snoozed-row-unsnooze"
                        onClick={() => handleUnsnooze(project.path)}
                      >
                        Unsnooze
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right: Calendar sidebar (read-only) */}
        {calendarSidebar}
      </div>
      </div>
      )}

      {card && (
        <TodoCard
          todoId={card.id}
          anchorRect={card.rect}
          onClose={() => setCard(null)}
          onChanged={handleCardChanged}
          inToday={todayIdSet.has(card.id)}
          todayFull={!todayIdSet.has(card.id) && todayIdSet.size >= TODAY_CAP}
          onToggleToday={() => handleToggleToday(card.id)}
        />
      )}
    </div>
  );
}
