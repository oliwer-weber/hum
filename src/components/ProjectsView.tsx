import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FuseOptionKey } from "fuse.js";
import VaultChips from "./VaultChips";
import VaultFAB from "./VaultFAB";
import RightClickHint from "./RightClickHint";
import { useFuseFilter } from "../hooks/useFuseFilter";
import { useScrollFade } from "../hooks/useScrollFade";

type Scope = "work" | "personal" | "archive";

interface ProjectsViewProps {
  refreshKey: number;
  onOpenProject: (projectPath: string) => void;
  onOpenPath: (path: string) => void;
  onVaultChanged: () => void;
}

interface ProjectItem {
  path: string;
  title: string;
  body: string;             // aggregated note + todo content, for phrase search
  pinned: boolean;
  updated: string;          // "YYYY-MM-DDTHH:MM"
  archived: boolean;
  scope: Scope;
}

type Bucket =
  | { kind: "this_week" }
  | { kind: "last_week" }
  | { kind: "month"; year: number; month: number }
  | { kind: "older" };

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function scopeFromPath(path: string): Scope {
  if (path.startsWith("projects/archive/")) return "archive";
  if (path.startsWith("projects/personal/")) return "personal";
  return "work";
}

function startOfWeek(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  const day = out.getDay();
  const diff = (day + 6) % 7; // Monday as week start
  out.setDate(out.getDate() - diff);
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
  if (d >= yearAgo) {
    return { kind: "month", year: d.getFullYear(), month: d.getMonth() + 1 };
  }
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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatDate(iso: string, now: Date): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
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

// The backend corpus returns these fields for projects; we pick them up here.
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

const ALL_KINDS_KEYS: FuseOptionKey<FindItem>[] = [
  { name: "title", weight: 2 },
  { name: "path", weight: 1 },
  { name: "tags", weight: 1 },
  { name: "excerpt", weight: 1 },
  { name: "body", weight: 0.5 },
];

interface VaultEntry {
  name: string;
  is_dir: boolean;
}

export default function ProjectsView({
  refreshKey,
  onOpenProject,
  onOpenPath,
  onVaultChanged,
}: ProjectsViewProps) {
  const [scope, setScope] = useState<Scope>("work");
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [fullCorpus, setFullCorpus] = useState<FindItem[]>([]);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [pending, setPending] = useState<
    | null
    | { kind: "delete"; path: string; name: string }
    | { kind: "archive"; path: string; name: string }
  >(null);
  const [pendingError, setPendingError] = useState("");
  const findRef = useRef<HTMLInputElement>(null);
  const { ref: scrollRef, edge: fadeEdge } = useScrollFade<HTMLElement>([projects, query, scope]);

  const loadProjects = useCallback(async () => {
    try {
      const corpus = await invoke<FindItem[]>("list_all_findables");
      setFullCorpus(corpus);
      const active: ProjectItem[] = corpus
        .filter((i) => i.kind === "project")
        .map((i) => ({
          path: i.path,
          title: i.title,
          body: i.body,
          pinned: i.pinned,
          updated: i.updated,
          archived: false,
          scope: scopeFromPath(i.path),
        }));

      // Archive projects aren't in the manifest; scan the folder directly.
      let archived: ProjectItem[] = [];
      try {
        const entries = await invoke<VaultEntry[]>("vault_list", {
          relativePath: "projects/archive",
        });
        archived = entries
          .filter((e) => e.is_dir)
          .map((e) => ({
            path: `projects/archive/${e.name}`,
            title: e.name,
            body: "",
            pinned: false,
            updated: "0000-00-00T00:00",
            archived: true,
            scope: "archive" as const,
          }));
      } catch {
        // archive folder may not exist; that's fine
      }

      setProjects([...active, ...archived]);
    } catch (err) {
      console.error("list_all_findables failed:", err);
      setProjects([]);
    }
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects, refreshKey]);

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
    () => projects.filter((p) => p.scope === scope),
    [projects, scope]
  );

  // When searching, query the ENTIRE vault corpus (projects + wiki + notes
  // + project notes), exactly like L0 landing does, so a phrase in a note
  // finds its way back to the row even from Projects view. When idle,
  // render the scoped project list with pinned + temporal groups.
  const searchMatches = useFuseFilter(fullCorpus, ALL_KINDS_KEYS, query);

  const filtered = useMemo(() => {
    if (!query.trim()) return scoped;
    return [];
  }, [query, scoped]);

  const now = useMemo(() => new Date(), [projects]);

  const groups = useMemo(() => {
    const pinned = filtered.filter((p) => p.pinned);
    const rest = filtered.filter((p) => !p.pinned);
    const byBucket = new Map<string, { bucket: Bucket; items: ProjectItem[] }>();
    for (const p of rest) {
      const b = bucketFromISO(p.updated, now);
      const key = bucketKey(b);
      if (!byBucket.has(key)) byBucket.set(key, { bucket: b, items: [] });
      byBucket.get(key)!.items.push(p);
    }
    for (const group of byBucket.values()) {
      group.items.sort((a, b) => b.updated.localeCompare(a.updated));
    }
    const ordered = Array.from(byBucket.values())
      .sort((a, b) => bucketOrder(a.bucket) - bucketOrder(b.bucket));
    return { pinned, temporal: ordered };
  }, [filtered, now]);

  const handlePinToggle = useCallback(async (path: string, pinned: boolean) => {
    try {
      await invoke("set_project_pinned", { projectPath: path, pinned: !pinned });
      await loadProjects();
      onVaultChanged();
    } catch (err) {
      console.error("set_project_pinned failed:", err);
    }
  }, [loadProjects, onVaultChanged]);

  const handleArchive = useCallback(async (path: string) => {
    const name = path.split("/").pop() ?? path;
    const target = `projects/archive/${name}`;
    try {
      await invoke("vault_move", { relativePath: path, destinationDir: "projects/archive" });
      onVaultChanged();
      await loadProjects();
      setPending(null);
      void target;
    } catch (err) {
      setPendingError(err instanceof Error ? err.message : String(err));
    }
  }, [loadProjects, onVaultChanged]);

  const handleDelete = useCallback(async (path: string) => {
    try {
      await invoke("vault_delete", { relativePath: path });
      onVaultChanged();
      await loadProjects();
      setPending(null);
    } catch (err) {
      setPendingError(err instanceof Error ? err.message : String(err));
    }
  }, [loadProjects, onVaultChanged]);

  const handleCreate = useCallback(async () => {
    const existing = new Set(scoped.map((p) => p.title));
    let candidate = "new-project";
    let n = 1;
    while (existing.has(candidate)) {
      n += 1;
      candidate = `new-project-${n}`;
    }
    try {
      let relPath: string;
      if (scope === "archive") {
        const base = `projects/archive/${candidate}`;
        await invoke("vault_create_dir", { relativePath: base });
        await invoke("vault_create_dir", { relativePath: `${base}/notes` });
        await invoke("vault_create_file", { relativePath: `${base}/todos.md`, content: "" });
        relPath = base;
      } else {
        relPath = await invoke<string>("register_project", {
          name: candidate,
          bucket: scope,
        });
      }
      onVaultChanged();
      onOpenProject(relPath);
    } catch (err) {
      console.error("create project failed:", err);
    }
  }, [scope, scoped, onOpenProject, onVaultChanged]);

  const chipOptions = [
    { key: "work" as const, label: "Work" },
    { key: "personal" as const, label: "Personal" },
    { key: "archive" as const, label: "Archive" },
  ];

  const renderRow = (p: ProjectItem) => (
    <div
      key={p.path}
      className="pcard-wrapper"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ path: p.path, x: e.clientX, y: e.clientY });
      }}
    >
      <button
        className="pcard"
        type="button"
        data-pinned={p.pinned || undefined}
        onClick={() => onOpenProject(p.path)}
      >
        <div className="pcard-main">
          <div className="pcard-title-line">
            <span className="pcard-title">{p.title}</span>
          </div>
        </div>
        <time className="pcard-date">{p.archived ? "archived" : formatDate(p.updated, now)}</time>
      </button>
    </div>
  );

  const openFindItem = (item: FindItem) => {
    if (item.kind === "project") onOpenProject(item.path);
    else onOpenPath(item.path);
  };

  const renderSearchRow = (item: FindItem) => {
    const subtitle = item.kind === "project_note" && item.project
      ? `${KIND_LABEL[item.kind]} · ${item.project}`
      : KIND_LABEL[item.kind] ?? item.kind;
    return (
      <div key={item.path} className="pcard-wrapper">
        <button
          className="pcard pcard-search"
          type="button"
          onClick={() => openFindItem(item)}
        >
          <span className="pcard-kind-icon" aria-hidden="true">{KIND_ICON[item.kind] ?? "·"}</span>
          <div className="pcard-main">
            <div className="pcard-title-line">
              <span className="pcard-title">{item.title || item.path}</span>
            </div>
            <div className="pcard-excerpt-line">
              <span className="pcard-excerpt">{subtitle}</span>
            </div>
          </div>
        </button>
      </div>
    );
  };

  return (
    <div className="plist-wrapper">
      <main className="plist" ref={scrollRef} data-fade={fadeEdge} data-collection="projects">
        <section className="plist-header">
          <div className="plist-kicker">
            <span className="plist-kicker-dot" aria-hidden="true"></span>
            <span>Collection</span>
          </div>
          <h1 className="plist-title">Projects</h1>
          <p className="plist-tagline">
            Work, personal, archive. Pin what matters, let the rest settle into time.
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
              ariaLabel="Projects scope"
            />
          </div>
        </div>

        <RightClickHint />

        {query.trim() ? (
          searchMatches.length === 0 ? (
            <div className="plist-empty">No matches for "{query.trim()}".</div>
          ) : (
            <div className="plist-cards">{searchMatches.slice(0, 60).map(renderSearchRow)}</div>
          )
        ) : scoped.length === 0 ? (
          <div className="plist-empty">
            {scope === "archive"
              ? "No archived projects."
              : `No ${scope} projects yet. Tap + to create one.`}
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

      {menu && (() => {
        const p = projects.find((pp) => pp.path === menu.path);
        if (!p) return null;
        return (
          <div
            className="vcard-menu-popover rc-popover"
            role="menu"
            style={{ left: menu.x, top: menu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {!p.archived && (
              <button
                type="button"
                className="vcard-menu-item"
                role="menuitem"
                onClick={() => { setMenu(null); handlePinToggle(p.path, p.pinned); }}
              >
                {p.pinned ? "Unpin" : "Pin"}
              </button>
            )}
            {!p.archived && (
              <button
                type="button"
                className="vcard-menu-item"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  setPending({ kind: "archive", path: p.path, name: p.title });
                  setPendingError("");
                }}
              >Archive</button>
            )}
            <button
              type="button"
              className="vcard-menu-item vcard-menu-item-danger"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                setPending({ kind: "delete", path: p.path, name: p.title });
                setPendingError("");
              }}
            >Delete</button>
          </div>
        );
      })()}

      <VaultFAB
        label={scope === "archive" ? "New in archive" : "New project"}
        onClick={handleCreate}
      />

      {pending && (
        <div className="vault-modal-overlay" onClick={() => setPending(null)}>
          <div className="vault-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="vault-modal-title">
              {pending.kind === "delete" ? "Delete project" : "Archive project"}
            </h3>
            <p className="vault-modal-text">
              {pending.kind === "delete"
                ? <>Permanently delete <strong>{pending.name}</strong> and all its contents?</>
                : <>Move <strong>{pending.name}</strong> to archive? It will no longer be @-mentionable.</>}
            </p>
            {pendingError && <p className="vault-modal-error">{pendingError}</p>}
            <div className="vault-modal-actions">
              <button
                className="vault-modal-btn vault-modal-btn-secondary"
                onClick={() => setPending(null)}
              >Cancel</button>
              <button
                className={`vault-modal-btn ${pending.kind === "delete" ? "vault-modal-btn-danger" : "vault-modal-btn-primary"}`}
                onClick={() => {
                  if (pending.kind === "delete") handleDelete(pending.path);
                  else handleArchive(pending.path);
                }}
              >
                {pending.kind === "delete" ? "Delete" : "Archive"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
