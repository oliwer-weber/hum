import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";

/* ── Types ────────────────────────────────────────── */

interface TodoEntry {
  id: string;
  text: string;
  body: string;
  status: string; // "open" | "completed"
  created: string | null;
  completed: string | null;
  tags: string[];
  project_name: string;
  project_path: string;
}

interface TodoDetail {
  entry: TodoEntry;
  note_path: string | null;
  note_body: string | null;
}

interface TodoCardProps {
  /** UUID of the todo to act on. The card resolves everything else by id. */
  todoId: string;
  /** Bounding rect of the row that opened the card, for anchored positioning. */
  anchorRect: DOMRect | null;
  /** Close the card without committing anything further. */
  onClose: () => void;
  /** Called after any mutation so the host can refresh every surface. */
  onChanged: () => void;
  /** Whether this todo is in the day's hand-picked "Today" list. */
  inToday?: boolean;
  /** True when Today is at its cap and this todo isn't already in it. */
  todayFull?: boolean;
  /** Toggle this todo's membership in Today. Omit to hide the action entirely. */
  onToggleToday?: () => void;
}

/* ── Status model ─────────────────────────────────── */

type StatusKey = "waiting" | "blocked" | "on-hold";

const STATUS_CHIPS: { key: StatusKey; tag: string; label: string; cls: string }[] = [
  { key: "waiting", tag: "#waiting", label: "Waiting", cls: "vault-tag-waiting" },
  { key: "blocked", tag: "#blocked", label: "Blocked", cls: "vault-tag-blocked" },
  { key: "on-hold", tag: "#on-hold", label: "On hold", cls: "vault-tag-onhold" },
];

/* ── Pure helpers ─────────────────────────────────── */

function stripStatusTags(text: string): string {
  return text.replace(/#(?:blocked|waiting|on-hold)\b/g, "").replace(/\s+/g, " ").trim();
}

function activeStatus(tags: string[]): StatusKey | null {
  if (tags.includes("#blocked")) return "blocked";
  if (tags.includes("#waiting")) return "waiting";
  if (tags.includes("#on-hold")) return "on-hold";
  return null;
}

// Pre-fill the split editor: a todo's sub-tasks and body lines are the natural
// candidates to break out into their own todos. Falls back to the headline.
function splitSeed(detail: TodoDetail): string {
  const lines: string[] = [];
  for (const raw of detail.entry.body.split("\n")) {
    const t = raw.trim();
    if (t) lines.push(t);
  }
  if (lines.length === 0) lines.push(stripStatusTags(detail.entry.text));
  return lines.join("\n");
}

function ageLabel(createdISO: string | null): string {
  if (!createdISO) return "";
  const created = new Date(createdISO + "T00:00:00");
  if (Number.isNaN(created.getTime())) return "";
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const days = Math.floor((now.getTime() - created.getTime()) / (24 * 60 * 60 * 1000));
  if (days < 1) return "added today";
  if (days < 7) return `${days}d old`;
  if (days < 28) return `${Math.floor(days / 7)}w old`;
  return `${Math.floor(days / 30)}mo old`;
}

/* ── Icons ────────────────────────────────────────── */

const IconClose = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

const IconSplit = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12h6m0 0-3-3m3 3-3 3M21 6h-6m6 12h-6M9 12l6-6m-6 6 6 6" />
  </svg>
);

const IconTrash = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6" />
  </svg>
);

const IconNote = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 4h16v12l-4 4H4z" /><path d="M16 20v-4h4" />
  </svg>
);

const IconToday = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </svg>
);

const IconTodayCheck = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="m8.5 12 2.5 2.5 4.5-5" />
  </svg>
);

/* ── Positioning ──────────────────────────────────── */

const CARD_WIDTH = 340;
const VIEWPORT_MARGIN = 12;
const ANCHOR_GAP = 6;

// Clamp the card to the viewport, opening upward when there isn't room below.
function placeCard(anchor: DOMRect, cardHeight: number): { left: number; top: number } {
  let left = anchor.left;
  left = Math.min(left, window.innerWidth - CARD_WIDTH - VIEWPORT_MARGIN);
  left = Math.max(VIEWPORT_MARGIN, left);

  const below = anchor.bottom + ANCHOR_GAP;
  const fitsBelow = below + cardHeight + VIEWPORT_MARGIN <= window.innerHeight;
  const top = fitsBelow
    ? below
    : Math.max(VIEWPORT_MARGIN, anchor.top - ANCHOR_GAP - cardHeight);

  return { left, top };
}

/* ── Component ────────────────────────────────────── */

export default function TodoCard({ todoId, anchorRect, onClose, onChanged, inToday, todayFull, onToggleToday }: TodoCardProps) {
  const [detail, setDetail] = useState<TodoDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Note editing
  const [noteEditing, setNoteEditing] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");

  // Split editing
  const [splitting, setSplitting] = useState(false);
  const [splitDraft, setSplitDraft] = useState("");

  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await invoke<TodoDetail>("get_todo_detail", { id: todoId });
      setDetail(data);
    } catch (err) {
      setError(String(err));
    }
  }, [todoId]);

  useEffect(() => { load(); }, [load]);

  // Anchor + clamp once the card has measurable height. Re-runs as the card
  // grows (note/split editors open) so it never spills off-screen.
  useLayoutEffect(() => {
    if (!anchorRect || !cardRef.current) return;
    const h = cardRef.current.offsetHeight;
    setPos(placeCard(anchorRect, h));
  }, [anchorRect, detail, noteEditing, splitting]);

  // Close on Escape or outside click.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  /* ── Mutations ──────────────────────────────────── */

  // Wrap a backend call: guard double-submits, surface errors, refresh hosts.
  const run = useCallback(
    async (fn: () => Promise<void>, opts: { closeAfter?: boolean } = {}) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await fn();
        onChanged();
        if (opts.closeAfter) onClose();
      } catch (err) {
        setError(String(err));
      } finally {
        setBusy(false);
      }
    },
    [busy, onChanged, onClose],
  );

  const setStatus = (key: StatusKey) => {
    if (!detail) return;
    const current = activeStatus(detail.entry.tags);
    const next = current === key ? "" : key; // clicking the active chip clears it
    run(async () => {
      await invoke("set_todo_status", { id: todoId, status: next });
      await load();
    });
  };

  const toggleDone = () => {
    if (!detail) return;
    const checked = detail.entry.status !== "completed";
    run(async () => {
      await invoke("toggle_dashboard_todo", {
        project: detail.entry.project_name,
        todoText: todoId,
        checked,
      });
      await load();
    });
  };

  const doDelete = () => {
    run(async () => { await invoke("delete_todo", { id: todoId }); }, { closeAfter: true });
  };

  const doSplit = () => {
    const parts = splitDraft.split("\n").map((l) => l.trim()).filter(Boolean);
    if (parts.length === 0) return;
    run(async () => { await invoke("split_todo", { id: todoId, parts }); }, { closeAfter: true });
  };

  const saveNote = () => {
    run(async () => {
      await invoke("save_todo_note", { id: todoId, body: noteDraft });
      setNoteEditing(false);
      await load();
    });
  };

  /* ── Render ─────────────────────────────────────── */

  const card = (
    <div
      ref={cardRef}
      className="todocard"
      role="dialog"
      aria-label="Todo actions"
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        visibility: pos ? "visible" : "hidden",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {!detail ? (
        <div className="todocard-loading">{error ?? "Loading…"}</div>
      ) : (
        <>
          <div className="todocard-head">
            <span className="todocard-project">{detail.entry.project_name}</span>
            <button className="todocard-close" onClick={onClose} aria-label="Close">
              <IconClose />
            </button>
          </div>

          <div className="todocard-title-row">
            <input
              type="checkbox"
              className="todo-checkbox"
              checked={detail.entry.status === "completed"}
              onChange={toggleDone}
              disabled={busy}
              aria-label={detail.entry.status === "completed" ? "Mark incomplete" : "Mark complete"}
            />
            <span className={`todocard-title ${detail.entry.status === "completed" ? "todocard-title-done" : ""}`}>
              {stripStatusTags(detail.entry.text)}
            </span>
          </div>

          {ageLabel(detail.entry.created) && (
            <div className="todocard-meta">{ageLabel(detail.entry.created)}</div>
          )}

          {/* Today toggle — the primary planning gesture: commit this to the
              day's hand-picked few, or take it back off. Hidden when the host
              doesn't wire it. */}
          {onToggleToday && (
            <div className="todocard-today-wrap">
              <button
                className={`todocard-today ${inToday ? "todocard-today-on" : ""}`}
                onClick={() => { onToggleToday(); onClose(); }}
                disabled={busy || (!inToday && todayFull)}
                aria-pressed={!!inToday}
              >
                {inToday ? <IconTodayCheck /> : <IconToday />}
                {inToday ? "In today" : todayFull ? "Today is full" : "Add to today"}
              </button>
              {!inToday && todayFull && (
                <span className="todocard-today-hint">
                  Finish or remove one to add another.
                </span>
              )}
            </div>
          )}

          {/* Status chips — click the active one to clear it. */}
          <div className="todocard-status" role="group" aria-label="Status">
            {STATUS_CHIPS.map((chip) => {
              const on = activeStatus(detail.entry.tags) === chip.key;
              return (
                <button
                  key={chip.key}
                  className={`todocard-chip ${chip.cls} ${on ? "todocard-chip-on" : ""}`}
                  onClick={() => setStatus(chip.key)}
                  disabled={busy}
                  aria-pressed={on}
                >
                  {chip.label}
                </button>
              );
            })}
          </div>

          {/* Note */}
          <div className="todocard-note">
            {noteEditing ? (
              <div className="todocard-note-edit">
                <textarea
                  className="todocard-note-input"
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  placeholder="Write a note for this todo"
                  rows={4}
                  autoFocus
                />
                <div className="todocard-note-actions">
                  <button className="todocard-btn todocard-btn-ghost" onClick={() => setNoteEditing(false)} disabled={busy}>
                    Cancel
                  </button>
                  <button className="todocard-btn todocard-btn-accent" onClick={saveNote} disabled={busy}>
                    Save note
                  </button>
                </div>
              </div>
            ) : detail.note_body !== null ? (
              <button
                className="todocard-note-read"
                onClick={() => { setNoteDraft(detail.note_body ?? ""); setNoteEditing(true); }}
                title="Click to edit"
              >
                {detail.note_body.trim().length > 0 ? (
                  <p className="todocard-note-text">{detail.note_body.trim()}</p>
                ) : (
                  <span className="todocard-note-empty">Empty note. Click to write.</span>
                )}
              </button>
            ) : (
              <button
                className="todocard-note-add"
                onClick={() => { setNoteDraft(""); setNoteEditing(true); }}
                disabled={busy}
              >
                <IconNote /> Add a note
              </button>
            )}
          </div>

          {/* Split */}
          {splitting && (
            <div className="todocard-split">
              <label className="todocard-split-label">One todo per line</label>
              <textarea
                className="todocard-note-input"
                value={splitDraft}
                onChange={(e) => setSplitDraft(e.target.value)}
                rows={4}
                autoFocus
              />
              <div className="todocard-note-actions">
                <button className="todocard-btn todocard-btn-ghost" onClick={() => setSplitting(false)} disabled={busy}>
                  Cancel
                </button>
                <button className="todocard-btn todocard-btn-accent" onClick={doSplit} disabled={busy}>
                  Split into todos
                </button>
              </div>
            </div>
          )}

          {error && <div className="todocard-error">{error}</div>}

          {/* Footer actions */}
          {!splitting && (
            <div className="todocard-actions">
              <button
                className="todocard-action"
                onClick={() => { setSplitDraft(splitSeed(detail)); setSplitting(true); }}
                disabled={busy}
              >
                <IconSplit /> Split
              </button>
              <button
                className="todocard-action todocard-action-danger"
                onClick={doDelete}
                disabled={busy}
              >
                <IconTrash /> Delete
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );

  return createPortal(
    <div className="todocard-layer" onClick={onClose}>
      {card}
    </div>,
    document.body,
  );
}
