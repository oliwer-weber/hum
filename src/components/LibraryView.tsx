import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FuseOptionKey } from "fuse.js";
import VaultFAB from "./VaultFAB";
import RightClickHint from "./RightClickHint";
import { useFuseFilter } from "../hooks/useFuseFilter";
import { useScrollFade } from "../hooks/useScrollFade";

interface LibraryViewProps {
  refreshKey: number;
  subPath: string;
  onSubPathChange: (p: string) => void;
  onOpenPath: (path: string) => void;
  onRequestMove: (path: string, name: string, onDone: () => void) => void;
  onVaultChanged: () => void;
}

interface VaultEntry { name: string; is_dir: boolean; extension: string | null; }

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
const LIB_ROOT = "wiki";

const LIBRARY_KEYS: FuseOptionKey<FindItem>[] = [
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

function joinPath(...parts: string[]): string { return parts.filter(Boolean).join("/"); }
function stripMdExt(name: string): string { return name.replace(/\.md$/i, ""); }

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

export default function LibraryView({
  refreshKey,
  subPath,
  onSubPathChange,
  onOpenPath,
  onRequestMove,
  onVaultChanged,
}: LibraryViewProps) {
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [corpus, setCorpus] = useState<FindItem[]>([]);
  const [fullCorpus, setFullCorpus] = useState<FindItem[]>([]);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [pending, setPending] = useState<
    | null
    | { kind: "rename"; path: string; name: string; isDir: boolean }
    | { kind: "delete"; path: string; name: string; isDir: boolean }
  >(null);
  const [pendingInput, setPendingInput] = useState("");
  const [pendingError, setPendingError] = useState("");
  const findRef = useRef<HTMLInputElement>(null);
  const { ref: scrollRef, edge: fadeEdge } = useScrollFade<HTMLElement>([entries, corpus, query]);

  const currentDir = subPath ? joinPath(LIB_ROOT, subPath) : LIB_ROOT;

  const load = useCallback(async () => {
    try {
      const [items, findables] = await Promise.all([
        invoke<VaultEntry[]>("vault_list", { relativePath: currentDir }),
        invoke<FindItem[]>("list_all_findables"),
      ]);
      items.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setEntries(items);
      setCorpus(findables.filter((i) => i.kind === "wiki"));
      setFullCorpus(findables);
    } catch {
      setEntries([]);
      setCorpus([]);
      setFullCorpus([]);
    }
  }, [currentDir]);

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

  // Folders in the current dir (for nav).
  const folders = useMemo(
    () => entries.filter((e) => e.is_dir),
    [entries]
  );

  // Files in the current dir, enriched with corpus metadata (title/excerpt/
  // tags/updated/pinned). Query is applied across the WHOLE wiki when set,
  // since the user may search beyond their current folder.
  const scopedFiles = useMemo(() => {
    const currentPaths = new Set(
      entries
        .filter((e) => !e.is_dir && e.name.endsWith(".md"))
        .map((e) => joinPath(currentDir, e.name))
    );
    return corpus.filter((c) => currentPaths.has(c.path));
  }, [entries, corpus, currentDir]);

  // When searching, widen to the whole vault corpus (any kind) — same
  // behavior as L0 landing, so a phrase can find its target no matter
  // which view you searched from.
  const searchMatches = useFuseFilter(fullCorpus, LIBRARY_KEYS, query);
  const filtered = query.trim() ? [] : scopedFiles;

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

  const handleCreate = useCallback(async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const existing = new Set(entries.map((e) => e.name));
    let candidate = `${stamp}.md`;
    let n = 1;
    while (existing.has(candidate)) { n += 1; candidate = `${stamp}-${n}.md`; }
    const path = joinPath(currentDir, candidate);
    try {
      await invoke("vault_create_file", { relativePath: path, content: "" });
      onVaultChanged();
      onOpenPath(path);
    } catch (err) {
      console.error("create library entry failed:", err);
    }
  }, [currentDir, entries, onOpenPath, onVaultChanged]);

  const handleSubmitPending = useCallback(async () => {
    if (!pending) return;
    setPendingError("");
    try {
      if (pending.kind === "rename") {
        const name = pendingInput.trim();
        if (!name || name === pending.name) { setPending(null); return; }
        const finalName = !pending.isDir && !name.includes(".") ? `${name}.md` : name;
        await invoke("vault_rename", { relativePath: pending.path, newName: finalName });
      } else if (pending.kind === "delete") {
        await invoke("vault_delete", { relativePath: pending.path });
      }
      setPending(null);
      onVaultChanged();
      await load();
    } catch (err) {
      setPendingError(err instanceof Error ? err.message : String(err));
    }
  }, [pending, pendingInput, load, onVaultChanged]);

  const fileName = (path: string) => path.split("/").pop() ?? path;

  const renderFileRow = (item: FindItem) => (
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

  const renderFolderRow = (e: VaultEntry) => {
    const folderPath = joinPath(currentDir, e.name);
    return (
      <div key={folderPath} className="pcard-wrapper">
        <button
          className="pcard pcard-folder"
          type="button"
          onClick={() => onSubPathChange(joinPath(subPath, e.name))}
          onContextMenu={(evt) => {
            evt.preventDefault();
            setMenu({ path: folderPath, x: evt.clientX, y: evt.clientY });
          }}
        >
          <div className="pcard-main">
            <div className="pcard-title-line">
              <span className="pcard-folder-icon" aria-hidden="true">❑</span>
              <span className="pcard-title">{e.name}</span>
            </div>
          </div>
        </button>
      </div>
    );
  };

  const breadcrumb = subPath ? subPath.split("/") : [];
  const menuItem = menu ? corpus.find((c) => c.path === menu.path) : null;
  const menuIsFolder = menu && !menuItem;

  return (
    <div className="plist-wrapper">
      <main className="plist" ref={scrollRef} data-fade={fadeEdge} data-collection="library">
        <section className="plist-header">
          <div className="plist-kicker">
            <span className="plist-kicker-dot" aria-hidden="true"></span>
            <span>Collection</span>
          </div>
          <h1 className="plist-title">Library</h1>
          <p className="plist-tagline">
            Wiki entries. Long-lived reference notes pinned by importance, the rest grouped by recency.
          </p>
        </section>

        {breadcrumb.length > 0 && (
          <nav className="plist-breadcrumb" aria-label="Library breadcrumb">
            <button
              type="button"
              className="plist-breadcrumb-btn"
              onClick={() => onSubPathChange("")}
            >Library</button>
            {breadcrumb.map((seg, i) => {
              const partial = breadcrumb.slice(0, i + 1).join("/");
              const isLast = i === breadcrumb.length - 1;
              return (
                <span key={partial} className="plist-breadcrumb-seg">
                  <span className="plist-breadcrumb-sep">/</span>
                  {isLast ? (
                    <span className="plist-breadcrumb-current">{seg}</span>
                  ) : (
                    <button
                      type="button"
                      className="plist-breadcrumb-btn"
                      onClick={() => onSubPathChange(partial)}
                    >{seg}</button>
                  )}
                </span>
              );
            })}
          </nav>
        )}

        <div className="plist-toolbar plist-toolbar-single">
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
        ) : entries.length === 0 ? (
          <div className="plist-empty">Nothing here yet. Tap + to add an entry.</div>
        ) : filtered.length === 0 && folders.length === 0 ? (
          <div className="plist-empty">Nothing here.</div>
        ) : (
          <div className="plist-groups">
            {folders.length > 0 && (
              <section className="plist-group">
                <header className="plist-group-header">
                  <h2 className="plist-group-title">Folders</h2>
                  <span className="plist-group-count">{folders.length}</span>
                  <div className="plist-group-rule" aria-hidden="true"></div>
                </header>
                <div className="plist-cards">{folders.map(renderFolderRow)}</div>
              </section>
            )}
            {groups.pinned.length > 0 && (
              <section className="plist-group" data-pinned="true">
                <header className="plist-group-header">
                  <h2 className="plist-group-title">Pinned</h2>
                  <span className="plist-group-count">{groups.pinned.length}</span>
                  <div className="plist-group-rule" aria-hidden="true"></div>
                </header>
                <div className="plist-cards">{groups.pinned.map(renderFileRow)}</div>
              </section>
            )}
            {groups.temporal.map((g) => (
              <section key={bucketKey(g.bucket)} className="plist-group">
                <header className="plist-group-header">
                  <h2 className="plist-group-title">{bucketLabel(g.bucket, now)}</h2>
                  <span className="plist-group-count">{g.items.length}</span>
                  <div className="plist-group-rule" aria-hidden="true"></div>
                </header>
                <div className="plist-cards">{g.items.map(renderFileRow)}</div>
              </section>
            ))}
          </div>
        )}
      </main>

      {menu && (
        <div
          className="vcard-menu-popover rc-popover"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {menuItem && (
            <button
              type="button"
              className="vcard-menu-item"
              role="menuitem"
              onClick={() => { setMenu(null); handlePinToggle(menuItem.path, menuItem.pinned); }}
            >
              {menuItem.pinned ? "Unpin" : "Pin"}
            </button>
          )}
          <button
            type="button"
            className="vcard-menu-item"
            role="menuitem"
            onClick={() => {
              const p = menu.path;
              const fn = fileName(p);
              setMenu(null);
              setPending({ kind: "rename", path: p, name: fn, isDir: Boolean(menuIsFolder) });
              setPendingInput(fn);
              setPendingError("");
            }}
          >Rename</button>
          <button
            type="button"
            className="vcard-menu-item"
            role="menuitem"
            onClick={() => {
              const p = menu.path;
              const fn = fileName(p);
              setMenu(null);
              onRequestMove(p, fn, () => { onVaultChanged(); load(); });
            }}
          >Move</button>
          <button
            type="button"
            className="vcard-menu-item vcard-menu-item-danger"
            role="menuitem"
            onClick={() => {
              const p = menu.path;
              const fn = fileName(p);
              setMenu(null);
              setPending({ kind: "delete", path: p, name: fn, isDir: Boolean(menuIsFolder) });
              setPendingError("");
            }}
          >Delete</button>
        </div>
      )}

      <VaultFAB label="New entry" onClick={handleCreate} />

      {pending && (
        <div className="vault-modal-overlay" onClick={() => setPending(null)}>
          <div className="vault-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="vault-modal-title">
              {pending.kind === "rename"
                ? `Rename ${pending.isDir ? "folder" : "entry"}`
                : `Delete ${pending.isDir ? "folder" : "entry"}`}
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
                placeholder={pending.isDir ? "Folder name" : "Name (.md default)"}
              />
            ) : (
              <p className="vault-modal-text">
                Permanently delete <strong>{pending.isDir ? pending.name : stripMdExt(pending.name)}</strong>
                {pending.isDir ? " and all its contents" : ""}?
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
