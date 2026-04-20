import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import VaultCard from "./VaultCard";
import type { VaultFileInfo } from "./wikilink";

export type CollectionKey = "projects" | "library" | "notes";

interface VaultLandingProps {
  refreshKey: number;
  onOpenCollection: (key: CollectionKey) => void;
  onOpenPath: (path: string) => void;
}

interface RecentEntry {
  path: string;
  name: string;
  openedAt: number;
}

const COLLECTION_LABELS: Record<CollectionKey, string> = {
  projects: "Projects",
  library: "Library",
  notes: "Notes",
};

function loadRecents(): RecentEntry[] {
  try {
    const raw = localStorage.getItem("vault-recents");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function recentTitlesFor(prefix: string, recents: RecentEntry[]): string[] {
  return recents
    .filter((r) => r.path.startsWith(prefix))
    .slice(0, 3)
    .map((r) => r.name.replace(/\.md$/i, ""));
}

function countWhere(files: VaultFileInfo[], predicate: (path: string) => boolean): number {
  let n = 0;
  for (const f of files) if (predicate(f.path)) n++;
  return n;
}

function pluralize(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}

function collectionForPath(path: string): CollectionKey | "other" {
  if (path.startsWith("projects/")) return "projects";
  if (path.startsWith("wiki/")) return "library";
  if (path.startsWith("notes/")) return "notes";
  return "other";
}

function displayPath(path: string): string {
  // Show a friendly path: strip the on-disk collection prefix and .md ext.
  let p = path.replace(/^wiki\//, "Library / ");
  p = p.replace(/^notes\//, "Notes / ");
  p = p.replace(/^projects\//, "Projects / ");
  p = p.replace(/\/notes\//, " / Notes / ");
  p = p.replace(/\.md$/i, "");
  return p;
}

export default function VaultLanding({ refreshKey, onOpenCollection, onOpenPath }: VaultLandingProps) {
  const [files, setFiles] = useState<VaultFileInfo[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<VaultFileInfo[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const debounceRef = useRef<number | null>(null);

  const recents = loadRecents();

  useEffect(() => {
    invoke<VaultFileInfo[]>("vault_all_files").then(setFiles).catch(() => setFiles([]));
  }, [refreshKey]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setShowResults(false);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      try {
        const rs = await invoke<VaultFileInfo[]>("vault_search_files", { query: trimmed });
        setResults(rs);
        setShowResults(true);
        setActiveIdx(0);
      } catch {
        setResults([]);
      }
    }, 180);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  // Group results by collection, preserving match order inside each group.
  const grouped = useMemo(() => {
    const g: Record<"projects" | "library" | "notes" | "other", VaultFileInfo[]> = {
      projects: [], library: [], notes: [], other: [],
    };
    for (const r of results) g[collectionForPath(r.path)].push(r);
    return g;
  }, [results]);

  // Flat array of visible results in render order (for keyboard nav).
  const flatResults = useMemo(
    () => [...grouped.projects, ...grouped.library, ...grouped.notes, ...grouped.other],
    [grouped]
  );

  const handleOpenResult = (path: string) => {
    setShowResults(false);
    setQuery("");
    onOpenPath(path);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, Math.max(0, flatResults.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && flatResults[activeIdx]) {
      e.preventDefault();
      handleOpenResult(flatResults[activeIdx].path);
    } else if (e.key === "Escape") {
      setShowResults(false);
      setQuery("");
    }
  };

  const projectSet = new Set<string>();
  for (const f of files) {
    if (!f.path.startsWith("projects/")) continue;
    if (f.path.startsWith("projects/archive/")) continue;
    const parts = f.path.split("/");
    if (parts.length >= 3) projectSet.add(`${parts[0]}/${parts[1]}/${parts[2]}`);
  }
  const projectCount = projectSet.size;
  const libraryCount = countWhere(files, (p) => p.startsWith("wiki/"));
  const notesCount = countWhere(files, (p) => p.startsWith("notes/") && !p.startsWith("notes/archive/"));

  const projectRecents = recentTitlesFor("projects/", recents);
  const libraryRecents = recentTitlesFor("wiki/", recents);
  const notesRecents = recentTitlesFor("notes/", recents);

  const orderedCollections: Array<"projects" | "library" | "notes"> = ["projects", "library", "notes"];

  return (
    <div className="vlanding-shell">
      <div className="vlanding-header">
        <h1 className="vlanding-title">Your vault</h1>
        <p className="vlanding-tagline">Where your work, notes, and knowledge live.</p>
      </div>

      <div className="vsearch-container">
        <div className="vsearch" role="search">
          <span className="vsearch-icon" aria-hidden="true">⌕</span>
          <input
            className="vsearch-input"
            type="text"
            placeholder="Search the vault…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => { if (results.length > 0) setShowResults(true); }}
            onKeyDown={handleKeyDown}
            aria-label="Search the vault"
          />
          <span className="vsearch-kbd">↵</span>
        </div>

        {showResults && query.trim() && (
          <div className="vsearch-results" role="listbox">
            {flatResults.length === 0 ? (
              <div className="vsearch-no-results">No matches for "{query.trim()}"</div>
            ) : (
              orderedCollections.map((key) => {
                const group = grouped[key];
                if (group.length === 0) return null;
                return (
                  <div key={key} className="vsearch-group" data-collection={key}>
                    <div className="vsearch-group-label">{COLLECTION_LABELS[key]}</div>
                    {group.map((r) => {
                      const flatIdx = flatResults.indexOf(r);
                      return (
                        <button
                          key={r.path}
                          type="button"
                          className="vsearch-result"
                          role="option"
                          data-active={flatIdx === activeIdx}
                          onClick={() => handleOpenResult(r.path)}
                        >
                          <span className="vsearch-result-name">{r.name}</span>
                          <span className="vsearch-result-path">{displayPath(r.path)}</span>
                        </button>
                      );
                    })}
                  </div>
                );
              })
            )}
            {grouped.other.length > 0 && flatResults.length > 0 && (
              <div className="vsearch-group">
                <div className="vsearch-group-label">Other</div>
                {grouped.other.map((r) => {
                  const flatIdx = flatResults.indexOf(r);
                  return (
                    <button
                      key={r.path}
                      type="button"
                      className="vsearch-result"
                      role="option"
                      data-active={flatIdx === activeIdx}
                      onClick={() => handleOpenResult(r.path)}
                    >
                      <span className="vsearch-result-name">{r.name}</span>
                      <span className="vsearch-result-path">{displayPath(r.path)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="vgrid-hero">
        <VaultCard
          variant="hero"
          collection="projects"
          title="Projects"
          subtitle={pluralize(projectCount, "project")}
          icon="◆"
          recentItems={projectRecents}
          onClick={() => onOpenCollection("projects")}
        />
        <VaultCard
          variant="hero"
          collection="library"
          title="Library"
          subtitle={pluralize(libraryCount, "entry", "entries")}
          icon="❑"
          recentItems={libraryRecents}
          onClick={() => onOpenCollection("library")}
        />
        <VaultCard
          variant="hero"
          collection="notes"
          title="Notes"
          subtitle={pluralize(notesCount, "note")}
          icon="✎"
          recentItems={notesRecents}
          onClick={() => onOpenCollection("notes")}
        />
      </div>
    </div>
  );
}
