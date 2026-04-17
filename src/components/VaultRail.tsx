import { useState, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { VaultFileInfo } from "./wikilink";

export type RailMode = "trails" | "links" | "query";

export interface RecentEntry {
  path: string;
  name: string;
  openedAt: number;
}

export interface BacklinkEntry {
  path: string;
  name: string;
  line_number: number;
  line_content: string;
}

interface VaultRailProps {
  mode: RailMode;
  onModeChange: (mode: RailMode) => void;
  currentPath: string | null;
  currentFolder: string;
  recents: RecentEntry[];
  backlinks: BacklinkEntry[];
  onOpenFile: (path: string) => void;
}

const MODES: { id: RailMode; label: string }[] = [
  { id: "trails", label: "Trails" },
  { id: "links", label: "Links" },
  { id: "query", label: "Query" },
];

export function VaultRail({ mode, onModeChange, currentPath, currentFolder, recents, backlinks, onOpenFile }: VaultRailProps) {
  const modeIndex = MODES.findIndex((m) => m.id === mode);

  return (
    <aside className="vault-rail" aria-label="Vault context rail">
      <div className="vault-rail-switcher">
        <div
          className="vault-rail-switcher-pill"
          style={{ transform: `translateX(${modeIndex * 100}%)` }}
        />
        {MODES.map((m) => (
          <button
            key={m.id}
            className={`vault-rail-mode ${mode === m.id ? "vault-rail-mode-active" : ""}`}
            onClick={() => onModeChange(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="vault-rail-content">
        {mode === "trails" && (
          <TrailsMode recents={recents} currentFolder={currentFolder} onOpenFile={onOpenFile} />
        )}
        {mode === "links" && (
          <LinksMode backlinks={backlinks} currentPath={currentPath} onOpenFile={onOpenFile} />
        )}
        {mode === "query" && (
          <QueryMode currentFolder={currentFolder} onOpenFile={onOpenFile} />
        )}
      </div>
    </aside>
  );
}

/* ── Trails ───────────────────────────────────────── */

function TrailsMode({ recents, currentFolder, onOpenFile }: {
  recents: RecentEntry[];
  currentFolder: string;
  onOpenFile: (path: string) => void;
}) {
  const [scopeToFolder, setScopeToFolder] = useState(true);

  const scoped = useMemo(() => {
    if (!scopeToFolder || !currentFolder) return recents;
    const prefix = currentFolder + "/";
    return recents.filter((r) => r.path.startsWith(prefix));
  }, [recents, currentFolder, scopeToFolder]);

  return (
    <div className="vault-rail-panel">
      {currentFolder && (
        <div className="vault-rail-scope-bar">
          <span className="vault-rail-scope-label">
            {scopeToFolder ? `in ${folderLabel(currentFolder)}` : "all vault"}
          </span>
          <button
            className="vault-rail-scope-toggle"
            onClick={() => setScopeToFolder((v) => !v)}
          >
            {scopeToFolder ? "widen" : "scope"}
          </button>
        </div>
      )}
      {scoped.length === 0 ? (
        <div className="vault-rail-empty">
          {scopeToFolder && currentFolder
            ? "Nothing opened here yet"
            : "Open a note and it'll show up here"}
        </div>
      ) : (
        <div className="vault-rail-list">
          {scoped.map((r) => (
            <button
              key={`${r.path}-${r.openedAt}`}
              className="vault-rail-item"
              onClick={() => onOpenFile(r.path)}
            >
              <span className="vault-rail-item-name">{stripExt(r.name)}</span>
              <span className="vault-rail-item-path">{parentPath(r.path)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Links ────────────────────────────────────────── */

function LinksMode({ backlinks, currentPath, onOpenFile }: {
  backlinks: BacklinkEntry[];
  currentPath: string | null;
  onOpenFile: (path: string) => void;
}) {
  if (!currentPath) {
    return (
      <div className="vault-rail-panel">
        <div className="vault-rail-empty">Open a note to see its connections</div>
      </div>
    );
  }
  if (backlinks.length === 0) {
    return (
      <div className="vault-rail-panel">
        <div className="vault-rail-empty">No backlinks</div>
      </div>
    );
  }
  return (
    <div className="vault-rail-panel">
      <div className="vault-rail-section-label">Backlinks · {backlinks.length}</div>
      <div className="vault-rail-list">
        {backlinks.map((bl, i) => (
          <button
            key={`${bl.path}-${bl.line_number}-${i}`}
            className="vault-rail-item"
            onClick={() => onOpenFile(bl.path)}
          >
            <span className="vault-rail-item-name">{stripExt(bl.name)}</span>
            <span className="vault-rail-item-context">{bl.line_content}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── Query ────────────────────────────────────────── */

interface QueryResult {
  path: string;
  name: string;
  line_number?: number;
  line_content?: string;
}

function QueryMode({ currentFolder, onOpenFile }: {
  currentFolder: string;
  onOpenFile: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"files" | "content">("files");
  const [scopeToFolder, setScopeToFolder] = useState(true);
  const [results, setResults] = useState<QueryResult[]>([]);
  const debounceRef = useRef<number | null>(null);
  const genRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const gen = ++genRef.current;
    debounceRef.current = window.setTimeout(async () => {
      try {
        let raw: QueryResult[];
        if (kind === "files") {
          const r = await invoke<VaultFileInfo[]>("vault_search_files", { query });
          raw = r.map((f) => ({ path: f.path, name: f.name }));
        } else {
          raw = await invoke<QueryResult[]>("vault_search_content", { query, maxResults: 40 });
        }
        if (gen !== genRef.current) return;
        const prefix = currentFolder ? currentFolder + "/" : "";
        const filtered = (scopeToFolder && prefix)
          ? raw.filter((r) => r.path.startsWith(prefix))
          : raw;
        setResults(filtered);
      } catch (err) {
        if (gen === genRef.current) console.error("Rail query failed:", err);
      }
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, kind, scopeToFolder, currentFolder]);

  return (
    <div className="vault-rail-panel">
      <div className="vault-rail-query-bar">
        <input
          ref={inputRef}
          className="vault-rail-query-input"
          placeholder={kind === "files" ? "Find file..." : "Search contents..."}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="vault-rail-query-controls">
        <div className="vault-rail-chip-group">
          <button
            className={`vault-rail-chip ${kind === "files" ? "vault-rail-chip-active" : ""}`}
            onClick={() => setKind("files")}
          >files</button>
          <button
            className={`vault-rail-chip ${kind === "content" ? "vault-rail-chip-active" : ""}`}
            onClick={() => setKind("content")}
          >content</button>
        </div>
        {currentFolder && (
          <button
            className={`vault-rail-chip ${scopeToFolder ? "vault-rail-chip-active" : ""}`}
            onClick={() => setScopeToFolder((v) => !v)}
            title={scopeToFolder ? `Scoped to ${folderLabel(currentFolder)}` : "Searching all of vault"}
          >
            {scopeToFolder ? "in folder" : "all vault"}
          </button>
        )}
      </div>
      <div className="vault-rail-list">
        {query && results.length === 0 && (
          <div className="vault-rail-empty">No results</div>
        )}
        {results.map((r, i) => (
          <button
            key={`${r.path}-${r.line_number ?? 0}-${i}`}
            className="vault-rail-item"
            onClick={() => onOpenFile(r.path)}
          >
            <span className="vault-rail-item-name">{stripExt(r.name)}</span>
            {r.line_content
              ? <span className="vault-rail-item-context">{r.line_content}</span>
              : <span className="vault-rail-item-path">{parentPath(r.path)}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── Helpers ──────────────────────────────────────── */

function stripExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash) : "";
}

function folderLabel(folder: string): string {
  const parts = folder.split("/").filter(Boolean);
  return parts[parts.length - 1] || folder;
}
