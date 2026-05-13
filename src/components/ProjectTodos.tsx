import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/* ── Types ────────────────────────────────────────── */

interface TodoBlock {
  text: string;
  body: string;
  raw_lines: string[];
  checked: boolean;
  id: string | null;
  created: string | null;
  completed: string | null;
  tags: string[];
  line_number: number;
  line_count: number;
  subtasks: TodoBlock[];
}

interface ProjectTodosProps {
  refreshKey: number;
  projectPath: string;
  onBack: () => void;
  onOpenRaw: () => void;
}

/* ── Pure helpers ─────────────────────────────────── */

function projectNameFromPath(path: string): string {
  return path.split("/").pop() ?? path;
}

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function ageDays(createdISO: string | null): number | null {
  if (!createdISO) return null;
  const created = new Date(createdISO + "T00:00:00");
  if (Number.isNaN(created.getTime())) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const diff = now.getTime() - created.getTime();
  if (diff < 0) return 0;
  return Math.floor(diff / (24 * 60 * 60 * 1000));
}

function formatAge(days: number | null): string {
  if (days === null) return "";
  if (days < 1) return "now";
  if (days < 7) return `${days}d`;
  if (days < 28) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

function stripStatusTags(text: string): string {
  return text.replace(/#(?:blocked|waiting|on-hold)\b/g, "").replace(/\s+/g, " ").trim();
}

// Monday-reset calendar week. Returns epoch-ms of this week's Monday 00:00 local.
function startOfThisWeekMondayMs(): number {
  const now = new Date();
  const dow = now.getDay(); // 0=Sun ... 6=Sat
  const daysBack = dow === 0 ? 6 : dow - 1;
  const mon = new Date(now);
  mon.setHours(0, 0, 0, 0);
  mon.setDate(mon.getDate() - daysBack);
  return mon.getTime();
}

function startOfTodayMs(): number {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.getTime();
}

type CompletedBucket = "today" | "week" | "earlier";

function bucketForCompleted(completedISO: string): CompletedBucket | null {
  const d = new Date(completedISO + "T00:00:00");
  if (Number.isNaN(d.getTime())) return null;
  const t = d.getTime();
  if (t >= startOfTodayMs()) return "today";
  if (t >= startOfThisWeekMondayMs()) return "week";
  return "earlier";
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatCompletedDate(iso: string, bucket: CompletedBucket): string {
  const d = new Date(iso + "T00:00:00");
  if (bucket === "today") return "";
  if (bucket === "week") return WEEKDAY_SHORT[d.getDay()];
  return `${MONTH_SHORT[d.getMonth()]} ${String(d.getDate()).padStart(2, "0")}`;
}

function hasExtras(block: TodoBlock): boolean {
  return block.body.trim().length > 0 || block.subtasks.length > 0;
}

/* ── Icons ────────────────────────────────────────── */

const IconChevronLeft = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m15 18-6-6 6-6" />
  </svg>
);

const IconChevronRight = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m9 18 6-6-6-6" />
  </svg>
);

const IconPlus = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const IconClose = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

const IconOverflow = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
    <circle cx="5" cy="12" r="1" />
  </svg>
);

/* ── Sub-task cluster ──────────────────────────────
   Shared between Open and Completed lists. Renders the body + sub-task
   rows; the parent caller owns the parent row. Age on sub-tasks reflects
   the parent's created date (sub-tasks inherit). */

function TodoExtras({
  block,
  parentAge,
  onToggle,
  onDelete,
}: {
  block: TodoBlock;
  parentAge: number | null;
  onToggle: (block: TodoBlock, checked: boolean) => void;
  onDelete: (block: TodoBlock) => void;
}) {
  if (!hasExtras(block)) return null;

  return (
    <div className="ptodos-extras">
      {block.body.trim().length > 0 && (
        <p className="ptodos-body">{block.body}</p>
      )}
      {block.subtasks.length > 0 && (
        <ul className="ptodos-subtasks">
          {block.subtasks.map((sub) => {
            const key = `${sub.line_number}-${sub.id ?? sub.text}`;
            return (
              <li key={key} className="ptodos-subtask-row">
                <input
                  type="checkbox"
                  className="todo-checkbox"
                  checked={sub.checked}
                  onChange={() => onToggle(sub, !sub.checked)}
                  aria-label={sub.checked ? "Mark sub-task incomplete" : "Mark sub-task complete"}
                />
                <span className={`ptodos-subtask-text ${sub.checked ? "ptodos-subtask-text-done" : ""}`}>
                  {stripStatusTags(sub.text)}
                </span>
                <span className="ptodos-age">{formatAge(parentAge)}</span>
                <button
                  className="ptodos-delete"
                  onClick={() => onDelete(sub)}
                  aria-label="Delete sub-task"
                >
                  <IconClose />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ── Component ────────────────────────────────────── */

export default function ProjectTodos({
  refreshKey,
  projectPath,
  onBack,
  onOpenRaw,
}: ProjectTodosProps) {
  const [blocks, setBlocks] = useState<TodoBlock[]>([]);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [addValue, setAddValue] = useState("");
  // Keyed by parent id (or fallback to line_number) — tracks which completed
  // rows are currently expanded. Resets on each loadTodos to avoid drift if
  // a previously-expanded row went away after a re-parse.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const addRef = useRef<HTMLInputElement>(null);

  const projectName = projectNameFromPath(projectPath);
  const todosRelPath = `${projectPath}/todos.md`;

  const loadTodos = useCallback(async () => {
    try {
      const data = await invoke<TodoBlock[]>("read_project_todos", {
        projectRelPath: projectPath,
      });
      setBlocks(data);
      setExpanded(new Set());
    } catch (err) {
      console.error("Failed to load todos:", err);
    }
  }, [projectPath]);

  useEffect(() => { loadTodos(); }, [loadTodos, refreshKey]);

  // Refresh when the window regains focus (handles external edits gracefully)
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible") loadTodos(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [loadTodos]);

  // Close overflow menu on click-away or Escape
  useEffect(() => {
    if (!overflowOpen) return;
    const onClick = () => setOverflowOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOverflowOpen(false); };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [overflowOpen]);

  /* ── Derived data ─────────────────────────────── */

  const openBlocks = useMemo(() => blocks.filter((b) => !b.checked), [blocks]);
  const completedBlocks = useMemo(() => blocks.filter((b) => b.checked), [blocks]);

  // Sort open parents by age desc — oldest things float to the top, the way
  // gravity-ranked todos do elsewhere in the app.
  const openOrdered = useMemo(() => {
    return [...openBlocks].sort((a, b) => {
      const aAge = ageDays(a.created) ?? 0;
      const bAge = ageDays(b.created) ?? 0;
      return bAge - aAge;
    });
  }, [openBlocks]);

  const buckets = useMemo(() => {
    const result: Record<CompletedBucket, TodoBlock[]> = {
      today: [],
      week: [],
      earlier: [],
    };
    for (const b of completedBlocks) {
      if (!b.completed) continue;
      const bucket = bucketForCompleted(b.completed);
      if (!bucket) continue;
      result[bucket].push(b);
    }
    const byDateDesc = (a: TodoBlock, b: TodoBlock) => {
      const aT = a.completed ?? "";
      const bT = b.completed ?? "";
      if (aT !== bT) return aT < bT ? 1 : -1;
      return b.line_number - a.line_number;
    };
    result.today.sort(byDateDesc);
    result.week.sort(byDateDesc);
    result.earlier.sort(byDateDesc);
    return result;
  }, [completedBlocks]);

  const doneTodayCount = buckets.today.length;
  const totalOpenCount = useMemo(() => {
    // Count parents + open sub-tasks so the header reflects all open work.
    let n = 0;
    for (const b of openBlocks) {
      n += 1;
      for (const s of b.subtasks) if (!s.checked) n += 1;
    }
    return n;
  }, [openBlocks]);

  /* ── Handlers ─────────────────────────────────── */

  const handleToggle = useCallback(
    async (block: TodoBlock, checked: boolean) => {
      try {
        await invoke("toggle_dashboard_todo", {
          project: projectName,
          todoText: block.id ?? block.text,
          checked,
        });
        await loadTodos();
      } catch (err) {
        console.error("toggle_dashboard_todo failed:", err);
        await loadTodos();
      }
    },
    [projectName, loadTodos],
  );

  const handleAdd = useCallback(async () => {
    const text = addValue.trim();
    if (!text) return;
    const id = crypto.randomUUID();
    const line = `- [ ] ${text} <!-- id:${id} --> <!-- created:${todayISO()} -->`;
    try {
      let content = "";
      try {
        content = await invoke<string>("vault_read_file", { relativePath: todosRelPath });
      } catch {
        // File may not exist yet — that's fine, we'll create it via write
      }
      const newContent = content.length === 0
        ? line + "\n"
        : line + "\n" + content.replace(/^\n+/, "");
      await invoke("vault_write_file", { relativePath: todosRelPath, content: newContent });
      setAddValue("");
      await loadTodos();
      addRef.current?.focus();
    } catch (err) {
      console.error("add todo failed:", err);
    }
  }, [addValue, todosRelPath, loadTodos]);

  const handleDelete = useCallback(async (block: TodoBlock) => {
    try {
      const content = await invoke<string>("vault_read_file", { relativePath: todosRelPath });
      const lines = content.split("\n");
      const startIdx = block.line_number - 1;
      const endIdx = Math.min(startIdx + block.line_count, lines.length);
      const next = [...lines.slice(0, startIdx), ...lines.slice(endIdx)].join("\n");
      await invoke("vault_write_file", { relativePath: todosRelPath, content: next });
      await loadTodos();
    } catch (err) {
      console.error("delete todo failed:", err);
    }
  }, [todosRelPath, loadTodos]);

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const onAddKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAdd();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setAddValue("");
      (e.target as HTMLInputElement).blur();
    }
  }, [handleAdd]);

  /* ── Render ───────────────────────────────────── */

  return (
    <div className="ptodos">
      <header className="ptodos-head">
        <div className="ptodos-head-bar">
          <button className="ptodos-back" onClick={onBack} aria-label="Back to project">
            <IconChevronLeft />
            <span>{projectName}</span>
          </button>

          <div className="ptodos-overflow-wrap">
            <button
              className="ptodos-overflow"
              aria-label="More options"
              onClick={(e) => { e.stopPropagation(); setOverflowOpen((v) => !v); }}
            >
              <IconOverflow />
            </button>
            {overflowOpen && (
              <div className="ptodos-overflow-menu" onClick={(e) => e.stopPropagation()}>
                <button
                  className="ptodos-overflow-item"
                  onClick={() => { setOverflowOpen(false); onOpenRaw(); }}
                >
                  Edit raw markdown
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="ptodos-title-row">
          <h1 className="ptodos-title">Todos</h1>
          <p className="ptodos-subtitle">
            <span><strong>{totalOpenCount}</strong> open</span>
            <span className="ptodos-sep">·</span>
            <span><strong>{doneTodayCount}</strong> done today</span>
          </p>
        </div>
      </header>

      <section className="ptodos-grid">
        {/* LEFT: Open list */}
        <div className="ptodos-col-open">
          <div className="ptodos-col-label-row">
            <h2 className="ptodos-col-label">Open</h2>
            <span className="ptodos-col-count">{openBlocks.length}</span>
          </div>

          <form
            className="ptodos-add"
            onSubmit={(e) => { e.preventDefault(); handleAdd(); }}
          >
            <span className="ptodos-add-glyph" aria-hidden="true"><IconPlus /></span>
            <input
              ref={addRef}
              className="ptodos-add-input"
              type="text"
              placeholder="Add a todo, press return to save"
              value={addValue}
              onChange={(e) => setAddValue(e.target.value)}
              onKeyDown={onAddKeyDown}
            />
          </form>

          {openOrdered.length === 0 ? (
            <p className="ptodos-empty-list">Nothing open. Quiet day.</p>
          ) : (
            <ul className="ptodos-list">
              {openOrdered.map((block) => {
                const age = ageDays(block.created);
                const hasBlocked = block.tags.includes("#blocked");
                const hasWaiting = block.tags.includes("#waiting");
                const stuck = hasBlocked || hasWaiting;
                const displayText = stripStatusTags(block.text);
                const key = `${block.line_number}-${block.id ?? block.text}`;

                return (
                  <li key={key} className="ptodos-item">
                    <div className={`ptodos-row ${stuck ? "ptodos-row-stuck" : ""}`}>
                      <input
                        type="checkbox"
                        className="todo-checkbox"
                        checked={false}
                        onChange={() => handleToggle(block, true)}
                        aria-label="Mark complete"
                      />
                      <span className="ptodos-text">{displayText}</span>
                      {hasBlocked ? (
                        <span className="vault-tag vault-tag-blocked">#blocked</span>
                      ) : hasWaiting ? (
                        <span className="vault-tag vault-tag-waiting">#waiting</span>
                      ) : null}
                      <span className={`ptodos-age ${age !== null && age >= 14 ? "ptodos-age-warm" : ""}`}>
                        {formatAge(age)}
                      </span>
                      <button
                        className="ptodos-delete"
                        onClick={() => handleDelete(block)}
                        aria-label="Delete todo"
                      >
                        <IconClose />
                      </button>
                    </div>
                    <TodoExtras
                      block={block}
                      parentAge={age}
                      onToggle={handleToggle}
                      onDelete={handleDelete}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="ptodos-divider" aria-hidden="true" />

        {/* RIGHT: Completed rail */}
        <aside className="ptodos-col-rail">
          <RailSection
            label="Today"
            blocks={buckets.today}
            bucket="today"
            expanded={expanded}
            onToggleExpand={toggleExpanded}
            onToggle={handleToggle}
            onDelete={handleDelete}
          />
          <RailSection
            label="This Week"
            blocks={buckets.week}
            bucket="week"
            expanded={expanded}
            onToggleExpand={toggleExpanded}
            onToggle={handleToggle}
            onDelete={handleDelete}
          />
          <RailSection
            label="Earlier"
            blocks={buckets.earlier}
            bucket="earlier"
            expanded={expanded}
            onToggleExpand={toggleExpanded}
            onToggle={handleToggle}
            onDelete={handleDelete}
          />
        </aside>
      </section>
    </div>
  );
}

/* ── Rail section ─────────────────────────────────── */

const EMPTY_COPY: Record<CompletedBucket, string> = {
  today: "Nothing finished today yet.",
  week: "Nothing completed this week yet.",
  earlier: "Nothing older yet.",
};

function RailSection({
  label,
  blocks,
  bucket,
  expanded,
  onToggleExpand,
  onToggle,
  onDelete,
}: {
  label: string;
  blocks: TodoBlock[];
  bucket: CompletedBucket;
  expanded: Set<string>;
  onToggleExpand: (key: string) => void;
  onToggle: (block: TodoBlock, checked: boolean) => void;
  onDelete: (block: TodoBlock) => void;
}) {
  return (
    <div className="ptodos-rail-section">
      <div className="ptodos-rail-label-row">
        <h3 className="ptodos-rail-label">{label}</h3>
        <span className="ptodos-rail-count">{blocks.length}</span>
      </div>
      {blocks.length === 0 ? (
        <p className="ptodos-rail-empty">{EMPTY_COPY[bucket]}</p>
      ) : (
        <ul className="ptodos-done-list">
          {blocks.map((block) => {
            const dateLabel = block.completed ? formatCompletedDate(block.completed, bucket) : "";
            const key = `${block.line_number}-${block.id ?? block.text}`;
            const canExpand = hasExtras(block);
            const isOpen = canExpand && expanded.has(key);
            const parentAge = ageDays(block.created);

            return (
              <li key={key} className="ptodos-done-item">
                <div
                  className={`ptodos-done ${canExpand ? "ptodos-done-expandable" : ""} ${isOpen ? "ptodos-done-open" : ""}`}
                  onClick={canExpand ? () => onToggleExpand(key) : undefined}
                  role={canExpand ? "button" : undefined}
                  tabIndex={canExpand ? 0 : undefined}
                  onKeyDown={canExpand ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onToggleExpand(key);
                    }
                  } : undefined}
                >
                  <input
                    type="checkbox"
                    className="todo-checkbox"
                    checked={true}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => onToggle(block, false)}
                    aria-label="Mark incomplete"
                  />
                  <span className="ptodos-done-text">{stripStatusTags(block.text)}</span>
                  {canExpand && (
                    <span className={`ptodos-done-chevron ${isOpen ? "ptodos-done-chevron-open" : ""}`} aria-hidden="true">
                      <IconChevronRight />
                    </span>
                  )}
                  {dateLabel && <span className="ptodos-done-date">{dateLabel}</span>}
                </div>
                {isOpen && (
                  <TodoExtras
                    block={block}
                    parentAge={parentAge}
                    onToggle={onToggle}
                    onDelete={onDelete}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
