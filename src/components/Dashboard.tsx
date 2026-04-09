import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import SolarSystem from "./SolarSystem";
import type { ProjectGravity } from "./SolarSystem";

interface Todo {
  text: string;
  completed: boolean;
  subtasks?: string[];
}

interface Project {
  name: string;
  openCount: number;
  todos: Todo[];
}

interface ActivityItem {
  date: string;
  description: string;
}

interface DashboardData {
  lastUpdated: string;
  projects: Project[];
  blocked: string[];
  activity: ActivityItem[];
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

function parseDashboard(raw: string): DashboardData {
  const lines = raw.split("\n");
  const data: DashboardData = {
    lastUpdated: "",
    projects: [],
    blocked: [],
    activity: [],
  };

  let section = "";
  let currentProject: Project | null = null;

  for (const line of lines) {
    if (line.startsWith("*Last updated:")) {
      data.lastUpdated = line.replace(/\*/g, "").replace("Last updated:", "").trim();
      continue;
    }
    if (line.startsWith("## Open Todos")) { section = "todos"; continue; }
    if (line.startsWith("## Blocked")) { section = "blocked"; continue; }
    if (line.startsWith("## Recent Activity")) { section = "activity"; continue; }

    if (section === "todos" && line.startsWith("### ")) {
      const nameMatch = line.match(/\\?\[\\?\[(?:.*?\/)?(.+?)\\?\]\\?\]/);
      const countMatch = line.match(/\((\d+) open\)/);
      if (nameMatch) {
        currentProject = {
          name: nameMatch[1],
          openCount: countMatch ? parseInt(countMatch[1]) : 0,
          todos: [],
        };
        data.projects.push(currentProject);
      }
      continue;
    }

    if (section === "todos" && currentProject && line.match(/^- \[[ x]\]/)) {
      const completed = line.includes("[x]");
      const text = line.replace(/^- \[[ x]\]\s*/, "").trim();
      currentProject.todos.push({ text, completed });
      continue;
    }

    if (section === "todos" && currentProject && line.match(/^\t/)) {
      const lastTodo = currentProject.todos[currentProject.todos.length - 1];
      if (lastTodo) {
        if (!lastTodo.subtasks) lastTodo.subtasks = [];
        lastTodo.subtasks.push(line.trim().replace(/^- /, ""));
      }
      continue;
    }

    if (section === "activity" && line.startsWith("- ")) {
      const actMatch = line.match(/^- (\d{4}-\d{2}-\d{2}):\s*(.+)/);
      if (actMatch) {
        data.activity.push({ date: actMatch[1], description: actMatch[2] });
      }
      continue;
    }
  }

  return data;
}


function getTodayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

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

  // Monday = 0
  let startDow = firstDay.getDay() - 1;
  if (startDow < 0) startDow = 6;

  const weeks: { weekNum: number; days: (number | null)[] }[] = [];
  let currentDay = 1;

  // Build weeks
  while (currentDay <= daysInMonth) {
    const week: (number | null)[] = [];
    const weekDate = new Date(year, month, currentDay);
    const weekNum = getWeekNumber(weekDate);

    for (let dow = 0; dow < 7; dow++) {
      if (weeks.length === 0 && dow < startDow) {
        week.push(null);
      } else if (currentDay > daysInMonth) {
        week.push(null);
      } else {
        week.push(currentDay);
        currentDay++;
      }
    }

    weeks.push({ weekNum, days: week });
  }

  return { year, month, monthName: monthNames[month], weeks };
}

function MonthCalendar({ events }: { events: CalendarEvent[] }) {
  const now = new Date();
  const today = now.getDate();
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
            {week.days.map((day, di) => (
              <span
                key={di}
                className={[
                  "month-cal-day",
                  day === null ? "month-cal-day-empty" : "",
                  day === today ? "month-cal-day-today" : "",
                  day && eventDates.has(day) ? "month-cal-day-event" : "",
                  di >= 5 ? "month-cal-day-weekend" : "",
                ].filter(Boolean).join(" ")}
              >
                {day ?? ""}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

interface DashProps {
  refreshKey: number;
}

export default function Dashboard({ refreshKey }: DashProps) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [calendar, setCalendar] = useState<CalendarData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gravityData, setGravityData] = useState<ProjectGravity[]>([]);

  async function loadDashboard() {
    try {
      const raw = await invoke<string>("read_dashboard");
      setData(parseDashboard(raw));
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
    loadDashboard();
    loadCalendar();
    invoke<ProjectGravity[]>("get_project_gravity").then(setGravityData).catch(console.error);
  }, [refreshKey]);

  if (error) {
    return (
      <div className="dash">
        <div className="dash-error">Failed to load dashboard: {error}</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="dash">
        <div className="dash-loading">Loading...</div>
      </div>
    );
  }

  const totalOpen = data.projects.reduce((sum, p) => sum + p.todos.filter(t => !t.completed).length, 0);
  const activeProjects = data.projects.filter((p) => p.todos.some(t => !t.completed)).length;
  const today = getTodayStr();
  const todayEvents = calendar?.events.filter((e) => e.date === today) ?? [];

  return (
    <div className="dash">
      {/* ── Stats row ────────────────────────────── */}
      <div className="dash-stats">
        <div className="stat-card">
          <span className="stat-value stat-value-aqua">{totalOpen}</span>
          <span className="stat-label">Open todos</span>
        </div>
        <div className="stat-card">
          <span className="stat-value stat-value-green">{activeProjects}</span>
          <span className="stat-label">Active projects</span>
        </div>
        <div className="stat-card">
          <span className="stat-value stat-value-orange">{todayEvents.length}</span>
          <span className="stat-label">Meetings today</span>
        </div>
        <div className="stat-card stat-card-meta">
          <span className="stat-label">Updated {data.lastUpdated}</span>
          <button className="secondary dash-refresh" onClick={() => { loadDashboard(); loadCalendar(); }}>
            Refresh
          </button>
        </div>
      </div>

      {/* ── Solar System ────────────────────────── */}
      {gravityData.length > 0 && (
        <SolarSystem
          projects={gravityData}
          onNavigate={(path) => console.log("Navigate to project:", path)}
        />
      )}

      {/* ── Main content ─────────────────────────── */}
      <div className="dash-layout">
        {/* Left: Projects + Activity */}
        <div className="dash-main">
          <div className="dash-section">
            <h3 className="dash-section-title">Open Todos</h3>
            {data.projects.map((project) => (
              <div key={project.name} className="project-group">
                <h4 className="project-group-name">
                  {project.name}
                  <span className="project-group-count">({project.todos.filter(t => !t.completed).length})</span>
                </h4>
                {project.todos.map((todo, i) => (
                  <div
                    key={i}
                    className={`todo-row ${todo.completed ? "todo-done" : ""}`}
                  >
                    <input
                      type="checkbox"
                      className="todo-checkbox"
                      checked={todo.completed}
                      onChange={async () => {
                        // Optimistic local update — instant feedback
                        setData((prev) => {
                          if (!prev) return prev;
                          return {
                            ...prev,
                            projects: prev.projects.map((p) =>
                              p.name === project.name
                                ? {
                                    ...p,
                                    todos: p.todos.map((t, ti) =>
                                      ti === i ? { ...t, completed: !t.completed } : t
                                    ),
                                  }
                                : p
                            ),
                          };
                        });
                        // Persist to file
                        try {
                          await invoke("toggle_dashboard_todo", {
                            project: project.name,
                            todoText: todo.text,
                            checked: !todo.completed,
                          });
                        } catch (err) {
                          console.error("Failed to toggle todo:", err);
                          loadDashboard(); // revert on error
                        }
                      }}
                    />
                    <div>
                      <span className="todo-label">{todo.text}</span>
                      {todo.subtasks && (
                        <div className="todo-subs">
                          {todo.subtasks.map((st, j) => (
                            <div key={j} className="todo-sub">{st}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {data.activity.length > 0 && (
            <div className="dash-section">
              <h3 className="dash-section-title">Recent Activity</h3>
              <div className="activity-compact">
                {data.activity.slice(0, 5).map((item, i) => (
                  <div key={i} className="activity-row-compact">
                    <span className="activity-date-compact">{item.date.slice(5)}</span>
                    <span className="activity-desc-compact">{item.description}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: Calendar sidebar */}
        <div className="dash-sidebar">
          <MonthCalendar events={calendar?.events ?? []} />

          <div className="dash-section">
            <h3 className="dash-section-title">Today's Schedule</h3>
            {todayEvents.length === 0 ? (
              <div className="calendar-empty">No meetings today</div>
            ) : (
              <div className="calendar-events">
                {todayEvents.map((ev, i) => (
                  <div key={i} className="cal-event">
                    <div className="cal-time">
                      {ev.start}
                      {ev.end && <span className="cal-time-end"> — {ev.end}</span>}
                    </div>
                    <div className="cal-details">
                      <span className="cal-title">{ev.title}</span>
                      {ev.location && <span className="cal-location">{ev.location}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
