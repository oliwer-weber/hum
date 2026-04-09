import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type {
  DragStartEvent,
  DragEndEvent,
  DragOverEvent,
} from "@dnd-kit/core";
import { motion, AnimatePresence } from "framer-motion";

/* ── Interfaces ─────────────────────────────────────── */

interface TodoItem {
  id: string;
  text: string;
  project_name: string;
  project_path: string;
  color_index: number;
}

interface FocusBlock {
  title: string;
  date: string;
  start_time: string;
  end_time: string;
  project_name: string;
  color_index: number;
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
  "var(--aqua)",
  "var(--green)",
  "var(--yellow)",
  "var(--blue)",
  "var(--purple)",
  "var(--orange)",
  "var(--red)",
];

const PROJECT_COLORS_RAW = [
  [142, 192, 124],
  [184, 187, 38],
  [250, 189, 47],
  [131, 165, 152],
  [211, 134, 155],
  [254, 128, 25],
  [251, 73, 52],
];

const HOUR_START = 7;
const HOUR_END = 19;
const SLOT_HEIGHT = 24; // px per 30min

const TEMPERATURE_COLORS: [number, [number, number, number, number]][] = [
  [0.25, [0, 0, 0, 0]],
  [0.5, [184, 187, 38, 0.04]],   // green tint
  [0.75, [250, 189, 47, 0.06]],  // yellow tint
  [0.9, [254, 128, 25, 0.08]],   // orange tint
  [1.0, [251, 73, 52, 0.1]],     // red tint
];

/* ── Helpers ────────────────────────────────────────── */

function getMondayOfWeek(d: Date): Date {
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d);
  monday.setDate(diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function formatDateYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getWeekDays(monday: Date): Date[] {
  return Array.from({ length: 5 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

const DAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri"];

function timeToSlotY(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h - HOUR_START) * 2 * SLOT_HEIGHT + (m >= 30 ? SLOT_HEIGHT : 0);
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function addHour(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${String(h + 1).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function parseDateStr(dateStr: string): string {
  // Handles "2026-04-09" or "April 9, 2026" etc
  // Calendar events may have different formats
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    return dateStr.substring(0, 10);
  }
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) {
    return formatDateYMD(d);
  }
  return dateStr;
}

function getDayTemperatureStyle(
  focusBlocks: FocusBlock[],
  meetings: CalendarEvent[],
  dateStr: string
): React.CSSProperties {
  const totalSlots = (HOUR_END - HOUR_START) * 2; // 24 half-hour slots

  let usedMinutes = 0;

  focusBlocks
    .filter((b) => b.date === dateStr)
    .forEach((b) => {
      usedMinutes += timeToMinutes(b.end_time) - timeToMinutes(b.start_time);
    });

  meetings
    .filter((e) => parseDateStr(e.date) === dateStr)
    .forEach((e) => {
      if (e.end) {
        usedMinutes += timeToMinutes(e.end) - timeToMinutes(e.start);
      } else {
        usedMinutes += 30;
      }
    });

  const ratio = usedMinutes / (totalSlots * 30);
  let color: [number, number, number, number] = [0, 0, 0, 0];

  for (const [threshold, c] of TEMPERATURE_COLORS) {
    if (ratio >= threshold) {
      color = c;
    }
  }

  if (color[3] === 0) return {};
  return {
    backgroundColor: `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${color[3]})`,
  };
}

/* ── Draggable Todo Pill ────────────────────────────── */

function TodoPill({
  todo,
  isScheduled,
}: {
  todo: TodoItem;
  isScheduled: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: todo.id,
    data: todo,
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`plan-todo-pill ${isScheduled ? "plan-todo-pill-scheduled" : ""}`}
      style={{
        borderLeftColor: PROJECT_COLORS[todo.color_index],
        opacity: isDragging ? 0.4 : undefined,
        cursor: "grab",
      }}
      title={todo.text}
    >
      {isScheduled && <span className="plan-todo-clock">&#x1F552;</span>}
      <span className="plan-todo-pill-text">{todo.text}</span>
    </div>
  );
}

/* ── Droppable Time Slot ────────────────────────────── */

function TimeSlot({
  id,
  isHour,
  activeOverId,
}: {
  id: string;
  isHour: boolean;
  activeOverId: string | null;
}) {
  const { setNodeRef } = useDroppable({ id });
  const isOver = activeOverId === id;

  return (
    <div
      ref={setNodeRef}
      className={`plan-slot ${isHour ? "plan-slot-hour" : ""} ${isOver ? "plan-slot-active" : ""}`}
    />
  );
}

/* ── Focus Block Rendered ───────────────────────────── */

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function FocusBlockCard({
  block,
  onDelete,
  onResize,
}: {
  block: FocusBlock;
  onDelete: () => void;
  onResize: (newEndTime: string) => void;
}) {
  const top = timeToSlotY(block.start_time);
  const baseHeight =
    ((timeToMinutes(block.end_time) - timeToMinutes(block.start_time)) / 30) *
    SLOT_HEIGHT;
  const colorRaw = PROJECT_COLORS_RAW[block.color_index] || [142, 192, 124];
  const [resizeHeight, setResizeHeight] = useState<number | null>(null);
  const resizing = useRef(false);
  const startY = useRef(0);
  const startHeight = useRef(0);

  const displayHeight = resizeHeight ?? baseHeight;
  const displayEndMinutes =
    timeToMinutes(block.start_time) + (displayHeight / SLOT_HEIGHT) * 30;
  const displayEnd = minutesToTime(
    Math.min(displayEndMinutes, HOUR_END * 60)
  );

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      resizing.current = true;
      startY.current = e.clientY;
      startHeight.current = resizeHeight ?? baseHeight;

      const onMove = (ev: MouseEvent) => {
        if (!resizing.current) return;
        const dy = ev.clientY - startY.current;
        const raw = startHeight.current + dy;
        // Snap to 15min increments (SLOT_HEIGHT = 24px per 30min, so 12px = 15min)
        const snapPx = SLOT_HEIGHT / 2; // 12px = 15min
        const snapped = Math.max(snapPx, Math.round(raw / snapPx) * snapPx);
        // Don't exceed end of day
        const maxHeight =
          ((HOUR_END * 60 - timeToMinutes(block.start_time)) / 30) *
          SLOT_HEIGHT;
        setResizeHeight(Math.min(snapped, maxHeight));
      };

      const onUp = () => {
        resizing.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        // Commit the new end time
        const finalHeight = resizeHeight ?? baseHeight;
        const newEndMinutes =
          timeToMinutes(block.start_time) + (finalHeight / SLOT_HEIGHT) * 30;
        const clamped = Math.min(newEndMinutes, HOUR_END * 60);
        const newEnd = minutesToTime(clamped);
        if (newEnd !== block.end_time) {
          onResize(newEnd);
        }
        setResizeHeight(null);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [baseHeight, resizeHeight, block.start_time, block.end_time, onResize]
  );

  return (
    <AnimatePresence>
      <motion.div
        className="plan-block"
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.2 }}
        style={{
          top: `${top}px`,
          height: `${displayHeight}px`,
          backgroundColor: `rgba(${colorRaw[0]}, ${colorRaw[1]}, ${colorRaw[2]}, 0.8)`,
          borderLeftColor: `rgb(${colorRaw[0]}, ${colorRaw[1]}, ${colorRaw[2]})`,
        }}
      >
        <span className="plan-block-title">{block.title}</span>
        {resizeHeight !== null && (
          <span className="plan-block-duration">
            {block.start_time}–{displayEnd}
          </span>
        )}
        <button
          className="plan-block-delete"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Remove focus block"
        >
          &#x2715;
        </button>
        <div
          className="plan-block-resize-handle"
          onMouseDown={handleResizeStart}
        />
      </motion.div>
    </AnimatePresence>
  );
}

/* ── Meeting Block ──────────────────────────────────── */

function MeetingBlock({ event }: { event: CalendarEvent }) {
  const top = timeToSlotY(event.start);
  const endTime = event.end || addHour(event.start);
  const height =
    ((timeToMinutes(endTime) - timeToMinutes(event.start)) / 30) * SLOT_HEIGHT;

  if (height <= 0) return null;

  return (
    <div
      className="plan-meeting"
      style={{
        top: `${top}px`,
        height: `${Math.max(height, SLOT_HEIGHT)}px`,
      }}
    >
      <span className="plan-meeting-title">{event.title}</span>
    </div>
  );
}

/* ── Main Plan Component ────────────────────────────── */

export default function Plan({ refreshKey }: { refreshKey: number }) {
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [focusBlocks, setFocusBlocks] = useState<FocusBlock[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [weekOffset, setWeekOffset] = useState(0);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(
    new Set()
  );
  const [activeDragTodo, setActiveDragTodo] = useState<TodoItem | null>(null);
  const [activeOverId, setActiveOverId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  // Compute week dates
  const monday = useMemo(() => {
    const m = getMondayOfWeek(new Date());
    m.setDate(m.getDate() + weekOffset * 7);
    return m;
  }, [weekOffset]);

  const weekDays = useMemo(() => getWeekDays(monday), [monday]);

  const weekLabel = useMemo(() => {
    const months = [
      "Jan","Feb","Mar","Apr","May","Jun",
      "Jul","Aug","Sep","Oct","Nov","Dec",
    ];
    return `Week of ${months[monday.getMonth()]} ${monday.getDate()}`;
  }, [monday]);

  // Fetch data
  useEffect(() => {
    invoke<TodoItem[]>("get_all_open_todos")
      .then(setTodos)
      .catch(() => setTodos([]));
  }, [refreshKey]);

  useEffect(() => {
    invoke<FocusBlock[]>("get_focus_blocks")
      .then(setFocusBlocks)
      .catch(() => setFocusBlocks([]));
  }, [refreshKey]);

  useEffect(() => {
    invoke<string>("fetch_calendar")
      .then((json) => {
        try {
          const data: CalendarData = JSON.parse(json);
          setCalendarEvents(data.events || []);
        } catch {
          setCalendarEvents([]);
        }
      })
      .catch(() => setCalendarEvents([]));
  }, [refreshKey]);

  // Group todos by project
  const todosByProject = useMemo(() => {
    const grouped = new Map<string, TodoItem[]>();
    for (const todo of todos) {
      const list = grouped.get(todo.project_name) || [];
      list.push(todo);
      grouped.set(todo.project_name, list);
    }
    return grouped;
  }, [todos]);

  // Scheduled todo ids
  const scheduledTodoTexts = useMemo(() => {
    const set = new Set<string>();
    for (const block of focusBlocks) {
      set.add(`${block.project_name}:${block.title}`);
    }
    return set;
  }, [focusBlocks]);

  const isTodoScheduled = useCallback(
    (todo: TodoItem) =>
      scheduledTodoTexts.has(`${todo.project_name}:${todo.text}`),
    [scheduledTodoTexts]
  );

  // Toggle project collapse
  const toggleProject = useCallback((name: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  // DnD handlers
  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const todo = todos.find((t) => t.id === event.active.id);
      if (todo) setActiveDragTodo(todo);
    },
    [todos]
  );

  const handleDragOver = useCallback((event: DragOverEvent) => {
    setActiveOverId(event.over?.id ? String(event.over.id) : null);
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveDragTodo(null);
      setActiveOverId(null);

      const todo = event.active.data.current as TodoItem | undefined;
      const overId = event.over?.id ? String(event.over.id) : null;
      if (!todo || !overId || !overId.startsWith("slot-")) return;

      // Parse slot-YYYY-MM-DD-HH-MM
      const parts = overId.replace("slot-", "").split("-");
      if (parts.length < 5) return;
      const date = `${parts[0]}-${parts[1]}-${parts[2]}`;
      const start_time = `${parts[3]}:${parts[4]}`;
      const end_time = addHour(start_time);

      const block: FocusBlock = {
        title: todo.text,
        date,
        start_time,
        end_time,
        project_name: todo.project_name,
        color_index: todo.color_index,
      };

      try {
        await invoke("create_focus_block", {
          title: block.title,
          date: block.date,
          startTime: block.start_time,
          endTime: block.end_time,
          projectName: block.project_name,
          colorIndex: block.color_index,
        });
        setFocusBlocks((prev) => [...prev, block]);
      } catch (err) {
        console.error("Failed to create focus block:", err);
      }
    },
    []
  );

  const handleResizeBlock = useCallback(
    async (block: FocusBlock, newEndTime: string) => {
      try {
        // Delete old block and create with new end time
        await invoke("delete_focus_block", {
          title: block.title,
          date: block.date,
          startTime: block.start_time,
          endTime: block.end_time,
        });
        await invoke("create_focus_block", {
          title: block.title,
          date: block.date,
          startTime: block.start_time,
          endTime: newEndTime,
          projectName: block.project_name,
          colorIndex: block.color_index,
        });
        setFocusBlocks((prev) =>
          prev.map((b) =>
            b.title === block.title &&
            b.date === block.date &&
            b.start_time === block.start_time &&
            b.end_time === block.end_time
              ? { ...b, end_time: newEndTime }
              : b
          )
        );
      } catch (err) {
        console.error("Failed to resize focus block:", err);
      }
    },
    []
  );

  const handleDeleteBlock = useCallback(async (block: FocusBlock) => {
    try {
      await invoke("delete_focus_block", {
        title: block.title,
        date: block.date,
        startTime: block.start_time,
        endTime: block.end_time,
      });
      setFocusBlocks((prev) =>
        prev.filter(
          (b) =>
            !(
              b.title === block.title &&
              b.date === block.date &&
              b.start_time === block.start_time &&
              b.end_time === block.end_time
            )
        )
      );
    } catch (err) {
      console.error("Failed to delete focus block:", err);
    }
  }, []);

  // Hour labels
  const hours = useMemo(
    () =>
      Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i),
    []
  );

  // Check if any focus blocks exist in the visible week
  const hasBlocksThisWeek = useMemo(() => {
    const weekDateStrs = weekDays.map(formatDateYMD);
    return focusBlocks.some((b) => weekDateStrs.includes(b.date));
  }, [focusBlocks, weekDays]);

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="plan-container">
        {/* ── Left: Todo Sidebar ── */}
        <div className="plan-sidebar">
          <div className="plan-sidebar-header">Open Todos</div>
          {todos.length === 0 && (
            <div className="plan-sidebar-empty">No open todos found</div>
          )}
          {Array.from(todosByProject.entries()).map(([project, items]) => {
            const collapsed = collapsedProjects.has(project);
            const colorIdx = items[0]?.color_index ?? 0;
            return (
              <div key={project} className="plan-project-group">
                <button
                  className="plan-project-header"
                  onClick={() => toggleProject(project)}
                >
                  <span
                    className="plan-project-pip"
                    style={{ backgroundColor: PROJECT_COLORS[colorIdx] }}
                  />
                  <span className="plan-project-name">{project}</span>
                  <span className="plan-project-count">{items.length}</span>
                  <span
                    className="plan-project-chevron"
                    style={{
                      transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
                    }}
                  >
                    &#x25BE;
                  </span>
                </button>
                {!collapsed && (
                  <div className="plan-project-todos">
                    {items.map((todo) => (
                      <TodoPill
                        key={todo.id}
                        todo={todo}
                        isScheduled={isTodoScheduled(todo)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* ── Right: Week View ── */}
        <div className="plan-week">
          <div className="plan-week-header">
            <button
              className="plan-nav-btn"
              onClick={() => setWeekOffset((o) => o - 1)}
            >
              &#x25C0;
            </button>
            <span className="plan-week-label">{weekLabel}</span>
            <button
              className="plan-nav-btn"
              onClick={() => setWeekOffset((o) => o + 1)}
            >
              &#x25B6;
            </button>
          </div>

          <div className="plan-week-grid">
            {/* Hour labels */}
            <div className="plan-hour-labels">
              <div className="plan-day-header-spacer" />
              {hours.map((h) => (
                <div key={h} className="plan-hour-label">
                  {String(h).padStart(2, "0")}:00
                </div>
              ))}
            </div>

            {/* Day columns */}
            {weekDays.map((day, di) => {
              const dateStr = formatDateYMD(day);
              const dayBlocks = focusBlocks.filter((b) => b.date === dateStr);
              const dayMeetings = calendarEvents.filter(
                (e) => parseDateStr(e.date) === dateStr
              );
              const tempStyle = getDayTemperatureStyle(
                focusBlocks,
                calendarEvents,
                dateStr
              );

              return (
                <div
                  key={dateStr}
                  className="plan-day-column"
                  style={tempStyle}
                >
                  <div className="plan-day-header">
                    {DAY_ABBR[di]} {day.getDate()}
                  </div>
                  <div className="plan-time-grid">
                    {/* Time slots */}
                    {hours.map((h) => (
                      <div key={h} className="plan-hour-row">
                        <TimeSlot
                          id={`slot-${dateStr}-${String(h).padStart(2, "0")}-00`}
                          isHour={true}
                          activeOverId={activeOverId}
                        />
                        <TimeSlot
                          id={`slot-${dateStr}-${String(h).padStart(2, "0")}-30`}
                          isHour={false}
                          activeOverId={activeOverId}
                        />
                      </div>
                    ))}

                    {/* Focus blocks overlay */}
                    {dayBlocks.map((block, i) => (
                      <FocusBlockCard
                        key={`${block.date}-${block.start_time}-${i}`}
                        block={block}
                        onDelete={() => handleDeleteBlock(block)}
                        onResize={(newEnd) => handleResizeBlock(block, newEnd)}
                      />
                    ))}

                    {/* Meeting blocks overlay */}
                    {dayMeetings.map((event, i) => (
                      <MeetingBlock key={`meeting-${i}`} event={event} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Empty state */}
          {!hasBlocksThisWeek &&
            focusBlocks.length === 0 &&
            calendarEvents.length === 0 && (
              <div className="plan-empty-state">
                <div className="plan-empty-pill">
                  Drag a todo here to schedule focus time
                </div>
              </div>
            )}
        </div>
      </div>

      {/* Drag overlay */}
      <DragOverlay>
        {activeDragTodo && (
          <div
            className="plan-todo-pill plan-todo-pill-dragging"
            style={{
              borderLeftColor: PROJECT_COLORS[activeDragTodo.color_index],
            }}
          >
            {activeDragTodo.text}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
