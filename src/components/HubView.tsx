import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";

interface HubSearchResult {
  path: string;
  name: string;
  match_kind: "file" | "content";
  line_number: number | null;
  line_content: string | null;
  score: number;
  proximity: "project" | "vault";
}

interface HubRecentNote {
  path: string;
  date: string;
  gist: string;
}

interface HubAmbient {
  recent_notes: HubRecentNote[];
  note_count: number;
  open_todos: number;
}

interface HubViewProps {
  projectName: string;
  projectPrefix: string;
  onOpenFile: (path: string) => void;
}

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return parts.map((part, i) =>
    i % 2 === 1 ? <mark key={i}>{part}</mark> : part
  );
}

export function HubView({ projectName, projectPrefix, onOpenFile }: HubViewProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HubSearchResult[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [ambient, setAmbient] = useState<HubAmbient | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | null>(null);
  const genRef = useRef(0);
  const resultRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Load ambient data on mount
  useEffect(() => {
    invoke<HubAmbient>("hub_ambient", { projectPrefix }).then(setAmbient).catch(console.error);
  }, [projectPrefix]);

  // Auto-focus after mount settle
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 200);
    return () => clearTimeout(timer);
  }, []);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    };
  }, []);

  const doSearch = useCallback((q: string) => {
    if (q.length < 2) {
      setResults([]);
      setActiveIdx(0);
      return;
    }
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);

    debounceRef.current = window.setTimeout(() => {
      const gen = ++genRef.current;
      invoke<HubSearchResult[]>("hub_search", { query: q, projectPrefix })
        .then((res) => {
          if (gen === genRef.current) {
            setResults(res);
            setActiveIdx(0);
          }
        })
        .catch(console.error);
    }, 150);
  }, [projectPrefix]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    doSearch(val);
  }, [doSearch]);

  // Split results by proximity
  const { projectResults, vaultResults, flatResults } = useMemo(() => {
    const proj = results.filter((r) => r.proximity === "project");
    const vault = results.filter((r) => r.proximity === "vault");
    return { projectResults: proj, vaultResults: vault, flatResults: [...proj, ...vault] };
  }, [results]);

  // Scroll active result into view
  useEffect(() => {
    resultRefs.current[activeIdx]?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const count = flatResults.length;
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      if (count > 0) setActiveIdx((prev) => (prev + 1) % count);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (count > 0) setActiveIdx((prev) => (prev - 1 + count) % count);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (count > 0 && flatResults[activeIdx]) {
        onOpenFile(flatResults[activeIdx].path);
      }
    } else if (e.key === "Escape") {
      if (query) {
        setQuery("");
        setResults([]);
        setActiveIdx(0);
      } else {
        inputRef.current?.blur();
      }
    }
  }, [flatResults, activeIdx, query, onOpenFile]);

  const renderResultRow = (r: HubSearchResult, globalIdx: number) => (
    <div
      key={`${r.path}-${r.line_number ?? "f"}-${globalIdx}`}
      ref={(el) => { resultRefs.current[globalIdx] = el; }}
      className={`hub-result-row${globalIdx === activeIdx ? " hub-result-active" : ""}`}
      onClick={() => onOpenFile(r.path)}
      onMouseEnter={() => setActiveIdx(globalIdx)}
    >
      <span className="hub-result-name">
        {highlightMatch(r.name.replace(/\.md$/i, ""), query)}
      </span>
      {r.match_kind === "content" && r.line_content && (
        <span className="hub-result-preview">
          {highlightMatch(r.line_content, query)}
        </span>
      )}
      <span className="hub-result-path">{r.path}</span>
    </div>
  );

  // Track global index offset for vault results
  const projLen = projectResults.length;

  return (
    <div className="hub-landing">
      <h2 className="hub-landing-title">{projectName}</h2>
      <input
        ref={inputRef}
        className="hub-landing-search"
        placeholder={`Search in ${projectName}...`}
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />

      {/* Ambient state — shown when no active query */}
      {query.length < 2 && ambient && (
        <div className="hub-ambient">
          <div className="hub-ambient-stats">
            {ambient.note_count} note{ambient.note_count !== 1 ? "s" : ""} &middot; {ambient.open_todos} open todo{ambient.open_todos !== 1 ? "s" : ""}
          </div>
          {ambient.recent_notes.length > 0 && (
            <div className="hub-ambient-recent">
              {ambient.recent_notes.map((note) => (
                <div
                  key={note.path}
                  className="hub-ambient-row"
                  onClick={() => onOpenFile(note.path)}
                >
                  <span className="hub-ambient-date">{note.date.slice(5)}</span>
                  <span className="hub-ambient-gist">{note.gist}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Search results */}
      {query.length >= 2 && (
        <div className="hub-results">
          {flatResults.length === 0 && (
            <div className="hub-results-empty">No results</div>
          )}

          {projectResults.length > 0 && (
            <div className="hub-results-section">
              {vaultResults.length > 0 && (
                <div className="hub-results-label">In this project</div>
              )}
              {projectResults.map((r, i) => renderResultRow(r, i))}
            </div>
          )}

          {vaultResults.length > 0 && (
            <div className="hub-results-section">
              {projectResults.length > 0 && (
                <div className="hub-results-label">Elsewhere in vault</div>
              )}
              {vaultResults.map((r, i) => renderResultRow(r, projLen + i))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
