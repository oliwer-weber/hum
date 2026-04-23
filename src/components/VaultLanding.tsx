import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FuseOptionKey } from "fuse.js";
import VaultCard from "./VaultCard";
import { useFuseFilter } from "../hooks/useFuseFilter";

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

interface FindItem {
  kind: "project" | "wiki" | "note" | "project_note";
  path: string;
  title: string;
  excerpt: string;
  body: string;
  tags: string[];
  pinned: boolean;
  updated: string;
  project: string | null;
}

const KIND_ICON: Record<FindItem["kind"], string> = {
  project: "◆",
  wiki: "❑",
  note: "✎",
  project_note: "→",
};

const KIND_LABEL: Record<FindItem["kind"], string> = {
  project: "Project",
  wiki: "Library",
  note: "Note",
  project_note: "Project note",
};

const FIND_KEYS: FuseOptionKey<FindItem>[] = [
  { name: "title", weight: 2 },
  { name: "path", weight: 1 },
  { name: "tags", weight: 1 },
  { name: "excerpt", weight: 1 },
  { name: "body", weight: 0.5 },
];

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

function pluralize(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}

function resultSubtitle(item: FindItem): string {
  switch (item.kind) {
    case "project":
      return `${KIND_LABEL[item.kind]} · ${item.path}`;
    case "project_note":
      return item.project
        ? `${KIND_LABEL[item.kind]} · ${item.project}`
        : KIND_LABEL[item.kind];
    default: {
      // Strip collection prefix for cleaner display.
      const cleaned = item.path
        .replace(/^wiki\//, "")
        .replace(/^notes\//, "")
        .replace(/\.md$/i, "");
      return `${KIND_LABEL[item.kind]} · ${cleaned}`;
    }
  }
}

export default function VaultLanding({ refreshKey, onOpenCollection, onOpenPath }: VaultLandingProps) {
  const [corpus, setCorpus] = useState<FindItem[]>([]);
  const [query, setQuery] = useState("");
  const [showResults, setShowResults] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  const recents = loadRecents();

  useEffect(() => {
    invoke<FindItem[]>("list_all_findables")
      .then(setCorpus)
      .catch(() => setCorpus([]));
  }, [refreshKey]);

  const matched = useFuseFilter(corpus, FIND_KEYS, query);

  useEffect(() => {
    if (query.trim()) {
      setShowResults(true);
      setActiveIdx(0);
    } else {
      setShowResults(false);
    }
  }, [query]);

  const handleOpenResult = (item: FindItem) => {
    setShowResults(false);
    setQuery("");
    if (item.kind === "project") {
      // Projects route through the project-hub flow, not the editor.
      onOpenPath(item.path);
    } else {
      onOpenPath(item.path);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, Math.max(0, matched.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && matched[activeIdx]) {
      e.preventDefault();
      handleOpenResult(matched[activeIdx]);
    } else if (e.key === "Escape") {
      setShowResults(false);
      setQuery("");
    }
  };

  // Derive counts from the corpus so the hero cards stay in sync without
  // a second roundtrip to the backend.
  const counts = useMemo(() => {
    let projects = 0;
    let library = 0;
    let notes = 0;
    for (const item of corpus) {
      if (item.kind === "project") projects++;
      else if (item.kind === "wiki") library++;
      else if (item.kind === "note") notes++;
    }
    return { projects, library, notes };
  }, [corpus]);

  const projectRecents = recentTitlesFor("projects/", recents);
  const libraryRecents = recentTitlesFor("wiki/", recents);
  const notesRecents = recentTitlesFor("notes/", recents);

  return (
    <div className="vlanding-shell">
      <div className="vlanding-header">
        <h1 className="vlanding-title">Everything</h1>
        <p className="vlanding-tagline">Your work, notes, and knowledge, all in one place.</p>
      </div>

      <div className="vsearch-container">
        <div className="vsearch" role="search">
          <span className="vsearch-icon" aria-hidden="true">⌕</span>
          <input
            className="vsearch-input"
            type="text"
            placeholder="Search titles, tags, or content…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => { if (query.trim()) setShowResults(true); }}
            onKeyDown={handleKeyDown}
            aria-label="Search your vault"
          />
          <span className="vsearch-kbd">↵</span>
        </div>

        {showResults && query.trim() && (
          <div className="vsearch-results" role="listbox">
            {matched.length === 0 ? (
              <div className="vsearch-no-results">No matches for "{query.trim()}"</div>
            ) : (
              matched.slice(0, 30).map((item, i) => (
                <button
                  key={item.path}
                  type="button"
                  className="vsearch-result"
                  role="option"
                  data-active={i === activeIdx}
                  data-kind={item.kind}
                  onClick={() => handleOpenResult(item)}
                  onMouseEnter={() => setActiveIdx(i)}
                >
                  <span className="vsearch-result-icon" aria-hidden="true">
                    {KIND_ICON[item.kind]}
                  </span>
                  <span className="vsearch-result-main">
                    <span className="vsearch-result-name">{item.title || item.path}</span>
                    <span className="vsearch-result-path">{resultSubtitle(item)}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <div className="vgrid-hero">
        <VaultCard
          variant="hero"
          collection="projects"
          title="Projects"
          subtitle={pluralize(counts.projects, "project")}
          icon="◆"
          recentItems={projectRecents}
          onClick={() => onOpenCollection("projects")}
        />
        <VaultCard
          variant="hero"
          collection="library"
          title="Library"
          subtitle={pluralize(counts.library, "entry", "entries")}
          icon="❑"
          recentItems={libraryRecents}
          onClick={() => onOpenCollection("library")}
        />
        <VaultCard
          variant="hero"
          collection="notes"
          title="Notes"
          subtitle={pluralize(counts.notes, "note")}
          icon="✎"
          recentItems={notesRecents}
          onClick={() => onOpenCollection("notes")}
        />
      </div>
    </div>
  );
}
