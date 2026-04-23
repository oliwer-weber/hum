import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FuseOptionKey } from "fuse.js";
import VaultChips from "./VaultChips";
import VaultFAB from "./VaultFAB";
import RightClickHint from "./RightClickHint";
import { useFuseFilter } from "../hooks/useFuseFilter";
import { useScrollFade } from "../hooks/useScrollFade";

type Scope = "recent" | "archive";

interface NotesViewProps {
  refreshKey: number;
  onOpenPath: (path: string) => void;
  onRequestMove: (path: string, name: string, onDone: () => void) => void;
  onVaultChanged: () => void;
}

interface FindItem {
  kind: string;
  path: string;
  title: string;
  excerpt: string;
  body: string;
  tags: string[];
  pinned: boolean;
  updated: string;
  project: string | null;
}

type Bucket =
  | { kind: "this_week" }
  | { kind: "last_week" }
  | { kind: "month"; year: number; month: number }
  | { kind: "older" };

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
const WEEKDAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

const NOTES_KEYS: FuseOptionKey<FindItem>[] = [
  { name: "title", weight: 2 },
  { name: "path", weight: 1 },
  { name: "tags", weight: 1 },
  { name: "excerpt", weight: 1 },
  { name: "body", weight: 0.5 },
];

const KIND_ICON: Record<string, string> = {
  project: "◆",
  wiki: "❑",
  note: "✎",
  project_note: "→",
};

const KIND_LABEL: Record<string, string> = {
  project: "Project",
  wiki: "Library",
  note: "Note",
  project_note: "Project note",
};

function stripMdExt(name: string): string { return name.replace(/\.md$/i, ""); }
function fileName(path: string): string { return path.split("/").pop() ?? path; }

function startOfWeek(d: Date): Date {
  const out = new Date(d);
  out.setHours(0,0,0,0);
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7));
  return out;
}

function bucketFromISO(iso: string, now: Date): Bucket {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { kind: "older" };
  const wkStart = startOfWeek(now);
  const lastWkStart = new Date(wkStart);
  lastWkStart.setDate(lastWkStart.getDate() - 7);
  if (d >= wkStart) return { kind: "this_week" };
  if (d >= lastWkStart) return { kind: "last_week" };
  const yearAgo = new Date(now);
  yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  if (d >= yearAgo) return { kind: "month", year: d.getFullYear(), month: d.getMonth() + 1 };
  return { kind: "older" };
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
  if (isNaN(d.getTime())) return "";
  const age = (now.getTime() - d.getTime()) / (24 * 3600 * 1000);
  const pad = (n: number) => n.toString().padStart(2,"0");
  if (age < 7 && age >= 0) return `${WEEKDAYS[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const abbr = MONTH_NAMES[d.getMonth()].slice(0,3);
  if (d.getFullYear() === now.getFullYear()) return `${abbr} ${d.getDate()}`;
  return `${abbr} ${d.getFullYear()}`;
}

function scopeOf(path: string): Scope {
  return path.startsWith("notes/archive/") ? "archive" : "recent";
}

export default function NotesView({
  refreshKey,
  onOpenPath,
  onRequestMove,
  onVaultChanged,
}: NotesViewProps) {
  const [scope, setScope] = useState<Scope>("recent");
  const [corpus, setCorpus] = useState<FindItem[]>([]);
  const [fullCorpus, setFullCorpus] = useState<FindItem[]>([]);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [pending, setPending] = useState<
    | null
    | { kind: "rename"; path: string; name: string }
    | { kind: "delete"; path: string; name: string }
    | { kind: "archive"; path: string; name: string }
  >(null);
  const [pendingInput, setPendingInput] = useState("");
  const [pendingError, setPendingError] = useState("");
  const findRef = useRef<HTMLInputElement>(null);
  const { ref: scrollRef, edge: fadeEdge } = useScrollFade<HTMLElement>([corpus, query, scope]);

  const load = useCallback(async () => {
    try {
      const items = await invoke<FindItem[]>("list_all_findables");
      setCorpus(items.filter((i) => i.kind === "note"));
      setFullCorpus(items);
    } catch {
      setCorpus([]);
      setFullCorpus([]);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  useEffect(() => {
    if (!menu) return;
    const onClick = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    const onScroll = () => setMenu(null);
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [menu]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const a = document.activeElement;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")) return;
      e.preventDefault();
      findRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const scoped = useMemo(
    () => corpus.filter((f) => scopeOf(f.path) === scope),
    [corpus, scope]
  );

  // When searching, widen to the ENTIRE vault corpus (matches L0 behavior)
  // so a phrase can find its target no matter which view you searched from.
  const searchMatches = useFuseFilter(fullCorpus, NOTES_KEYS, query);
  const filtered = query.trim() ? [] : scoped;

  const now = useMemo(() => new Date(), [corpus]);

  const groups = useMemo(() => {
    const pinned = filtered.filter((f) => f.pinned);
    const rest = filtered.filter((f) => !f.pinned);
    const byBucket = new Map<string, { bucket: Bucket; items: FindItem[] }>();
    for (const f of rest) {
      const b = bucketFromISO(f.updated, now);
      const key = bucketKey(b);
      if (!byBucket.has(key)) byBucket.set(key, { bucket: b, items: [] });
      byBucket.get(key)!.items.push(f);
    }
    for (const g of byBucket.values()) {
      g.items.sort((a, b) => b.updated.localeCompare(a.updated));
    }
    const ordered = Array.from(byBucket.values())
      .sort((a, b) => bucketOrder(a.bucket) - bucketOrder(b.bucket));
    return { pinned, temporal: ordered };
  }, [filtered, now]);

  const handlePinToggle = useCallback(async (path: string, pinned: boolean) => {
    try {
      await invoke("set_note_pinned", { relPath: path, pinned: !pinned });
      await load();
      onVaultChanged();
    } catch (err) {
      console.error("set_note_pinned failed:", err);
    }
  }, [load, onVaultChanged]);

  const handleArchive = useCallback(async (path: string) => {
    try {
      await invoke("vault_move", { relativePath: path, destinationDir: "notes/archive" });
      onVaultChanged();
      await load();
      setPending(null);
    } catch (err) {
      setPendingError(err instanceof Error ? err.message : String(err));
    }
  }, [load, onVaultChanged]);

  const handleCreate = useCallback(async () => {
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const existing = new Set(corpus.map((c) => fileName(c.path)));
    let candidate = `${stamp}.md`;
    let n = 1;
    while (existing.has(candidate)) { n += 1; candidate = `${stamp}-${n}.md`; }
    const path = `notes/${candidate}`;
    try {
      await invoke("vault_create_file", { relativePath: path, content: "" });
      onVaultChanged();
      onOpenPath(path);
    } catch (err) {
      console.error("create note failed:", err);
    }
  }, [corpus, onOpenPath, onVaultChanged]);

  const handleSubmitPending = useCallback(async () => {
    if (!pending) return;
    setPendingError("");
    try {
      if (pending.kind === "rename") {
        const name = pendingInput.trim();
        if (!name || name === pending.name) { setPending(null); return; }
        const finalName = name.includes(".") ? name : `${name}.md`;
        await invoke("vault_rename", { relativePath: pending.path, newName: finalName });
      } else if (pending.kind === "delete") {
        await invoke("vault_delete", { relativePath: pending.path });
      } else if (pending.kind === "archive") {
        await handleArchive(pending.path);
        return;
      }
      setPending(null);
      onVaultChanged();
      await load();
    } catch (err) {
      setPendingError(err instanceof Error ? err.message : String(err));
    }
  }, [pending, pendingInput, load, onVaultChanged, handleArchive]);

  const chipOptions = [
    { key: "recent" as const, label: "Recent" },
    { key: "archive" as const, label: "Archive" },
  ];

  const renderRow = (item: FindItem) => (
    <div
      key={item.path}
      className="pcard-wrapper"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ path: item.path, x: e.clientX, y: e.clientY });
      }}
    >
      <button
        className="pcard"
        type="button"
        data-pinned={item.pinned || undefined}
        onClick={() => onOpenPath(item.path)}
      >
        <div className="pcard-main">
          <div className="pcard-title-line">
            <span className="pcard-title">{item.title || stripMdExt(fileName(item.path))}</span>
          </div>
          <div className="pcard-excerpt-line">
            <span className="pcard-excerpt">{item.excerpt}</span>
            {item.tags.length > 0 && (
              <span className="pcard-tags">
                {item.tags.map((tag) => (
                  <span key={tag} className="pcard-tag">
                    <span className="pcard-tag-hash">#</span>{tag}
                  </span>
                ))}
              </span>
            )}
          </div>
        </div>
        <time className="pcard-date">{formatDate(item.updated, now)}</time>
      </button>
    </div>
  );

  const menuItem = menu ? corpus.find((c) => c.path === menu.path) : null;

  return (
    <div className="plist-wrapper">
      <main className="plist" ref={scrollRef} data-fade={fadeEdge} data-collection="notes">
        <section className="plist-header">
          <div className="plist-kicker">
            <span className="plist-kicker-dot" aria-hidden="true"></span>
            <span>Collection</span>
          </div>
          <h1 className="plist-title">Notes</h1>
          <p className="plist-tagline">
            Standalone notes not attached to a project. Pin the keepers, let the rest settle into time.
          </p>
        </section>

        <div className="plist-toolbar">
          <label className="plist-find">
            <span className="plist-find-icon" aria-hidden="true">⌕</span>
            <input
              ref={findRef}
              className="plist-find-input"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find..."
              aria-label="Find"
            />
            <span className="plist-find-kbd">/</span>
          </label>
          <div className="plist-scope">
            <VaultChips
              options={chipOptions}
              value={scope}
              onChange={setScope}
              ariaLabel="Notes scope"
            />
          </div>
        </div>

        <RightClickHint />

        {query.trim() ? (
          searchMatches.length === 0 ? (
            <div className="plist-empty">No matches for "{query.trim()}".</div>
          ) : (
            <div className="plist-cards">
              {searchMatches.slice(0, 60).map((item) => (
                <div key={item.path} className="pcard-wrapper">
                  <button
                    className="pcard pcard-search"
                    type="button"
                    onClick={() => onOpenPath(item.path)}
                  >
                    <span className="pcard-kind-icon" aria-hidden="true">{KIND_ICON[item.kind] ?? "·"}</span>
                    <div className="pcard-main">
                      <div className="pcard-title-line">
                        <span className="pcard-title">{item.title || fileName(item.path)}</span>
                      </div>
                      <div className="pcard-excerpt-line">
                        <span className="pcard-excerpt">
                          {item.kind === "project_note" && item.project
                            ? `${KIND_LABEL[item.kind]} · ${item.project}`
                            : KIND_LABEL[item.kind] ?? item.kind}
                        </span>
                      </div>
                    </div>
                  </button>
                </div>
              ))}
            </div>
          )
        ) : scoped.length === 0 ? (
          <div className="plist-empty">
            {scope === "archive"
              ? "No archived notes."
              : "No notes yet. Tap + to add one."}
          </div>
        ) : filtered.length === 0 ? (
          <div className="plist-empty">Nothing here.</div>
        ) : (
          <div className="plist-groups">
            {groups.pinned.length > 0 && (
              <section className="plist-group" data-pinned="true">
                <header className="plist-group-header">
                  <h2 className="plist-group-title">Pinned</h2>
                  <span className="plist-group-count">{groups.pinned.length}</span>
                  <div className="plist-group-rule" aria-hidden="true"></div>
                </header>
                <div className="plist-cards">{groups.pinned.map(renderRow)}</div>
              </section>
            )}
            {groups.temporal.map((g) => (
              <section key={bucketKey(g.bucket)} className="plist-group">
                <header className="plist-group-header">
                  <h2 className="plist-group-title">{bucketLabel(g.bucket, now)}</h2>
                  <span className="plist-group-count">{g.items.length}</span>
                  <div className="plist-group-rule" aria-hidden="true"></div>
                </header>
                <div className="plist-cards">{g.items.map(renderRow)}</div>
              </section>
            ))}
          </div>
        )}
      </main>

      {menu && menuItem && (
        <div
          className="vcard-menu-popover rc-popover"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="vcard-menu-item"
            role="menuitem"
            onClick={() => { setMenu(null); handlePinToggle(menuItem.path, menuItem.pinned); }}
          >
            {menuItem.pinned ? "Unpin" : "Pin"}
          </button>
          {!menuItem.path.startsWith("notes/archive/") && (
            <button
              type="button"
              className="vcard-menu-item"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                setPending({ kind: "archive", path: menuItem.path, name: fileName(menuItem.path) });
                setPendingError("");
              }}
            >Archive</button>
          )}
          <button
            type="button"
            className="vcard-menu-item"
            role="menuitem"
            onClick={() => {
              setMenu(null);
              const fn = fileName(menuItem.path);
              setPending({ kind: "rename", path: menuItem.path, name: fn });
              setPendingInput(fn);
              setPendingError("");
            }}
          >Rename</button>
          <button
            type="button"
            className="vcard-menu-item"
            role="menuitem"
            onClick={() => {
              setMenu(null);
              onRequestMove(menuItem.path, fileName(menuItem.path), () => {
                onVaultChanged(); load();
              });
            }}
          >Move</button>
          <button
            type="button"
            className="vcard-menu-item vcard-menu-item-danger"
            role="menuitem"
            onClick={() => {
              setMenu(null);
              setPending({ kind: "delete", path: menuItem.path, name: fileName(menuItem.path) });
              setPendingError("");
            }}
          >Delete</button>
        </div>
      )}

      <VaultFAB label="New note" onClick={handleCreate} />

      {pending && (
        <div className="vault-modal-overlay" onClick={() => setPending(null)}>
          <div className="vault-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="vault-modal-title">
              {pending.kind === "rename" ? "Rename note"
                : pending.kind === "archive" ? "Archive note"
                : "Delete note"}
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
            ) : pending.kind === "archive" ? (
              <p className="vault-modal-text">
                Move <strong>{stripMdExt(pending.name)}</strong> to archive?
              </p>
            ) : (
              <p className="vault-modal-text">
                Permanently delete <strong>{stripMdExt(pending.name)}</strong>?
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
                {pending.kind === "delete" ? "Delete"
                  : pending.kind === "archive" ? "Archive"
                  : "Rename"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
