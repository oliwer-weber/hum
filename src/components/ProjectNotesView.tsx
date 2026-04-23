import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Fuse from "fuse.js";
import VaultFAB from "./VaultFAB";

type Bucket =
  | { kind: "this_week" }
  | { kind: "last_week" }
  | { kind: "month"; year: number; month: number }
  | { kind: "older" };

interface NoteSummary {
  path: string;
  title: string;
  excerpt: string;
  tags: string[];
  created: string;
  updated: string;
  pinned: boolean;
  bucket: Bucket;
}

interface ProjectNotesViewProps {
  refreshKey: number;
  projectPath: string;
  onOpenPath: (path: string) => void;
  onRequestMove: (path: string, name: string, onDone: () => void) => void;
  onVaultChanged: () => void;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function projectName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function bucketKey(b: Bucket): string {
  switch (b.kind) {
    case "this_week": return "this_week";
    case "last_week": return "last_week";
    case "month": return `month:${b.year}-${b.month}`;
    case "older": return "older";
  }
}

function bucketLabel(b: Bucket, now: Date): string {
  switch (b.kind) {
    case "this_week": return "This week";
    case "last_week": return "Last week";
    case "month": {
      const n = MONTH_NAMES[b.month - 1];
      return b.year === now.getFullYear() ? n : `${n} ${b.year}`;
    }
    case "older": return "Older";
  }
}

function bucketOrder(b: Bucket): number {
  switch (b.kind) {
    case "this_week": return 0;
    case "last_week": return 1;
    case "month": return 1_000_000 - (b.year * 12 + b.month);
    case "older": return Number.MAX_SAFE_INTEGER;
  }
}

function formatDate(iso: string, now: Date): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  const ageDays = (now.getTime() - d.getTime()) / (24 * 3600 * 1000);
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (ageDays < 7 && ageDays >= 0) {
    return `${WEEKDAYS[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const monthAbbr = MONTH_NAMES[d.getMonth()].slice(0, 3);
  if (d.getFullYear() === now.getFullYear()) {
    return `${monthAbbr} ${d.getDate()}`;
  }
  return `${monthAbbr} ${d.getFullYear()}`;
}

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

type PendingAction =
  | { kind: "rename"; path: string; name: string }
  | { kind: "delete"; path: string; name: string };

export default function ProjectNotesView({
  refreshKey,
  projectPath,
  onOpenPath,
  onRequestMove,
  onVaultChanged,
}: ProjectNotesViewProps) {
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [query, setQuery] = useState("");
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [pendingInput, setPendingInput] = useState("");
  const [pendingError, setPendingError] = useState("");
  const findRef = useRef<HTMLInputElement>(null);

  const loadNotes = useCallback(async () => {
    try {
      const result = await invoke<NoteSummary[]>("list_project_notes", { projectPath });
      setNotes(result);
    } catch (err) {
      console.error("list_project_notes failed:", err);
      setNotes([]);
    }
  }, [projectPath]);

  useEffect(() => { loadNotes(); }, [loadNotes, refreshKey]);

  useEffect(() => {
    if (!menuFor) return;
    const onClick = () => setMenuFor(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuFor(null); };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuFor]);

  // `/` focuses Find when no other input is active.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
      e.preventDefault();
      findRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const allTags = useMemo(() => {
    const set = new Map<string, string>(); // lowercase → first-seen casing
    for (const n of notes) for (const t of n.tags) {
      const key = t.toLowerCase();
      if (!set.has(key)) set.set(key, t);
    }
    return Array.from(set.values()).sort((a, b) => a.localeCompare(b));
  }, [notes]);

  const fuse = useMemo(() => new Fuse(notes, {
    keys: [
      { name: "title", weight: 2 },
      { name: "excerpt", weight: 1 },
      { name: "tags", weight: 1 },
    ],
    threshold: 0.35,
    ignoreLocation: true,
  }), [notes]);

  const filtered = useMemo(() => {
    let out = notes;
    if (activeTags.size > 0) {
      out = out.filter((n) => n.tags.some((t) => activeTags.has(t.toLowerCase())));
    }
    const q = query.trim();
    if (q) {
      const matched = new Set(fuse.search(q).map((r) => r.item.path));
      out = out.filter((n) => matched.has(n.path));
    }
    return out;
  }, [notes, query, activeTags, fuse]);

  const groups = useMemo(() => {
    const pinned = filtered.filter((n) => n.pinned);
    const rest = filtered.filter((n) => !n.pinned);
    const byBucket = new Map<string, { bucket: Bucket; notes: NoteSummary[] }>();
    for (const n of rest) {
      const key = bucketKey(n.bucket);
      if (!byBucket.has(key)) byBucket.set(key, { bucket: n.bucket, notes: [] });
      byBucket.get(key)!.notes.push(n);
    }
    const ordered = Array.from(byBucket.values())
      .sort((a, b) => bucketOrder(a.bucket) - bucketOrder(b.bucket));
    return { pinned, temporal: ordered };
  }, [filtered]);

  const now = useMemo(() => new Date(), [notes]);

  const handleTagToggle = useCallback((tag: string) => {
    const key = tag.toLowerCase();
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handlePinToggle = useCallback(async (path: string, pinned: boolean) => {
    try {
      await invoke("set_note_pinned", { relPath: path, pinned: !pinned });
      await loadNotes();
      onVaultChanged();
    } catch (err) {
      console.error("set_note_pinned failed:", err);
    }
  }, [loadNotes, onVaultChanged]);

  const handleCreate = useCallback(async () => {
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const notesDir = `${projectPath}/notes`;
    try {
      try { await invoke("vault_create_dir", { relativePath: notesDir }); } catch { /* exists */ }
      const path = `${notesDir}/${stamp}.md`;
      await invoke("vault_create_file", { relativePath: path, content: "" });
      onVaultChanged();
      onOpenPath(path);
    } catch (err) {
      console.error("create note failed:", err);
    }
  }, [projectPath, onOpenPath, onVaultChanged]);

  const handleSubmitPending = useCallback(async () => {
    if (!pending) return;
    setPendingError("");
    try {
      if (pending.kind === "rename") {
        const name = pendingInput.trim();
        if (!name || name === pending.name) {
          setPending(null);
          return;
        }
        const finalName = name.includes(".") ? name : `${name}.md`;
        await invoke("vault_rename", { relativePath: pending.path, newName: finalName });
      } else if (pending.kind === "delete") {
        await invoke("vault_delete", { relativePath: pending.path });
      }
      setPending(null);
      onVaultChanged();
      await loadNotes();
    } catch (err) {
      setPendingError(err instanceof Error ? err.message : String(err));
    }
  }, [pending, pendingInput, loadNotes, onVaultChanged]);

  const name = projectName(projectPath);
  const isEmpty = notes.length === 0;
  const hasFilter = query.trim().length > 0 || activeTags.size > 0;

  const renderRow = (note: NoteSummary) => {
    const isOpen = menuFor === note.path;
    return (
      <div key={note.path} className="pcard-wrapper">
        <button
          className="pcard"
          type="button"
          data-pinned={note.pinned || undefined}
          onClick={() => onOpenPath(note.path)}
        >
          <div className="pcard-main">
            <div className="pcard-title-line">
              <span className="pcard-title">{note.title || fileName(note.path)}</span>
            </div>
            <div className="pcard-excerpt-line">
              <span className="pcard-excerpt">{note.excerpt}</span>
              {note.tags.length > 0 && (
                <span className="pcard-tags">
                  {note.tags.map((tag) => (
                    <span key={tag} className="pcard-tag">
                      <span className="pcard-tag-hash">#</span>{tag}
                    </span>
                  ))}
                </span>
              )}
            </div>
          </div>
          <time className="pcard-date">{formatDate(note.created, now)}</time>
        </button>
        <button
          type="button"
          className="pcard-menu-btn"
          aria-label={`Actions for ${note.title || fileName(note.path)}`}
          onClick={(e) => {
            e.stopPropagation();
            setMenuFor(isOpen ? null : note.path);
          }}
        >
          ⋯
        </button>
        {isOpen && (
          <div
            className="vcard-menu-popover"
            role="menu"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="vcard-menu-item"
              role="menuitem"
              onClick={() => { setMenuFor(null); handlePinToggle(note.path, note.pinned); }}
            >
              {note.pinned ? "Unpin" : "Pin"}
            </button>
            <button
              type="button"
              className="vcard-menu-item"
              role="menuitem"
              onClick={() => {
                setMenuFor(null);
                const fn = fileName(note.path);
                setPending({ kind: "rename", path: note.path, name: fn });
                setPendingInput(fn);
                setPendingError("");
              }}
            >Rename</button>
            <button
              type="button"
              className="vcard-menu-item"
              role="menuitem"
              onClick={() => {
                setMenuFor(null);
                onRequestMove(note.path, fileName(note.path), () => {
                  onVaultChanged();
                  loadNotes();
                });
              }}
            >Move</button>
            <button
              type="button"
              className="vcard-menu-item vcard-menu-item-danger"
              role="menuitem"
              onClick={() => {
                setMenuFor(null);
                setPending({ kind: "delete", path: note.path, name: fileName(note.path) });
                setPendingError("");
              }}
            >Delete</button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="plist-wrapper">
      <main className="plist">
        <section className="plist-header">
          <div className="plist-kicker">
            <span className="plist-kicker-dot" aria-hidden="true"></span>
            <span>Project</span>
          </div>
          <h1 className="plist-title">{name}</h1>
          <p className="plist-tagline">
            Every capture lives as its own note. Pinned items float on top, the rest settle into time.
          </p>
        </section>

        <label className="plist-find">
          <span className="plist-find-icon" aria-hidden="true">⌕</span>
          <input
            ref={findRef}
            className="plist-find-input"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find in this project"
            aria-label="Find in this project"
          />
          <span className="plist-find-kbd">/</span>
        </label>

        {allTags.length > 0 && (
          <div className="plist-filters" role="group" aria-label="Filter by tag">
            <span className="plist-filter-label">Tags</span>
            {allTags.map((tag) => (
              <button
                key={tag}
                className="plist-chip"
                type="button"
                aria-pressed={activeTags.has(tag.toLowerCase())}
                onClick={() => handleTagToggle(tag)}
              >
                <span className="plist-chip-hash">#</span>{tag}
              </button>
            ))}
          </div>
        )}

        {isEmpty ? (
          <div className="plist-empty">
            No notes in this project yet. Capture one via the inbox, or tap + to start.
          </div>
        ) : filtered.length === 0 ? (
          <div className="plist-empty">
            No matches{hasFilter ? " for this filter" : ""}.
          </div>
        ) : (
          <div className="plist-groups">
            {groups.pinned.length > 0 && (
              <section className="plist-group" data-pinned="true">
                <header className="plist-group-header">
                  <h2 className="plist-group-title">Pinned</h2>
                  <span className="plist-group-count">{groups.pinned.length}</span>
                  <div className="plist-group-rule" aria-hidden="true"></div>
                </header>
                <div className="plist-cards">
                  {groups.pinned.map(renderRow)}
                </div>
              </section>
            )}
            {groups.temporal.map((g) => (
              <section key={bucketKey(g.bucket)} className="plist-group">
                <header className="plist-group-header">
                  <h2 className="plist-group-title">{bucketLabel(g.bucket, now)}</h2>
                  <span className="plist-group-count">{g.notes.length}</span>
                  <div className="plist-group-rule" aria-hidden="true"></div>
                </header>
                <div className="plist-cards">
                  {g.notes.map(renderRow)}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>

      <VaultFAB label="New note" onClick={handleCreate} />

      {pending && (
        <div className="vault-modal-overlay" onClick={() => setPending(null)}>
          <div className="vault-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="vault-modal-title">
              {pending.kind === "rename" ? "Rename note" : "Delete note"}
            </h3>
            {pending.kind === "rename" ? (
              <input
                className="vault-modal-input"
                autoFocus
                value={pendingInput}
                onChange={(e) => setPendingInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSubmitPending();
                  if (e.key === "Escape") setPending(null);
                }}
                placeholder="File name (.md default)"
              />
            ) : (
              <p className="vault-modal-text">
                Permanently delete <strong>{pending.name}</strong>?
              </p>
            )}
            {pendingError && <p className="vault-modal-error">{pendingError}</p>}
            <div className="vault-modal-actions">
              <button
                className="vault-modal-btn vault-modal-btn-secondary"
                onClick={() => setPending(null)}
              >Cancel</button>
              <button
                className={`vault-modal-btn ${pending.kind === "delete" ? "vault-modal-btn-danger" : "vault-modal-btn-primary"}`}
                onClick={handleSubmitPending}
              >
                {pending.kind === "delete" ? "Delete" : "Rename"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
