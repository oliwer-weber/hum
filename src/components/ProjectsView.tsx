import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import VaultCard from "./VaultCard";
import VaultChips from "./VaultChips";
import VaultFAB from "./VaultFAB";
import VaultFilter from "./VaultFilter";
import type { VaultFileInfo } from "./wikilink";

interface VaultEntry {
  name: string;
  is_dir: boolean;
  extension: string | null;
}

type Scope = "work" | "personal" | "archive";

interface ProjectsViewProps {
  refreshKey: number;
  onOpenProject: (projectPath: string) => void;
  onRequestMove: (path: string, name: string, onDone: () => void) => void;
  onVaultChanged: () => void;
}

const PROJECTS_ROOT = "projects";

function scopePath(scope: Scope): string {
  return `${PROJECTS_ROOT}/${scope}`;
}

export default function ProjectsView({
  refreshKey,
  onOpenProject,
  onRequestMove,
  onVaultChanged,
}: ProjectsViewProps) {
  const [scope, setScope] = useState<Scope>("work");
  const [dirs, setDirs] = useState<VaultEntry[]>([]);
  const [files, setFiles] = useState<VaultFileInfo[]>([]);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const [pending, setPending] = useState<
    | null
    | { kind: "rename"; path: string; name: string; isDir: boolean }
    | { kind: "delete"; path: string; name: string; isDir: boolean }
  >(null);
  const [pendingInput, setPendingInput] = useState("");
  const [pendingError, setPendingError] = useState("");

  const loadDirs = useCallback(async () => {
    try {
      const items = await invoke<VaultEntry[]>("vault_list", { relativePath: scopePath(scope) });
      const onlyDirs = items.filter((e) => e.is_dir);
      onlyDirs.sort((a, b) => a.name.localeCompare(b.name));
      setDirs(onlyDirs);
    } catch {
      setDirs([]);
    }
  }, [scope]);

  useEffect(() => {
    loadDirs();
    invoke<VaultFileInfo[]>("vault_all_files").then(setFiles).catch(() => setFiles([]));
  }, [loadDirs, refreshKey]);

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

  // Metric per project: count of notes (.md in /notes/) and presence of todos.md
  const metricFor = useCallback(
    (projectPath: string) => {
      let notes = 0;
      let todos = false;
      for (const f of files) {
        if (!f.path.startsWith(projectPath + "/")) continue;
        if (f.path === `${projectPath}/todos.md`) todos = true;
        else if (f.path.startsWith(`${projectPath}/notes/`) && f.path.endsWith(".md")) notes += 1;
      }
      return { notes, todos };
    },
    [files]
  );

  const handleCreate = useCallback(async () => {
    const existing = new Set(dirs.map((d) => d.name));
    let candidate = "new-project";
    let n = 1;
    while (existing.has(candidate)) {
      n += 1;
      candidate = `new-project-${n}`;
    }
    const base = `${scopePath(scope)}/${candidate}`;
    try {
      await invoke("vault_create_dir", { relativePath: base });
      await invoke("vault_create_dir", { relativePath: `${base}/notes` });
      await invoke("vault_create_file", { relativePath: `${base}/todos.md`, content: "" });
      onVaultChanged();
      onOpenProject(base);
    } catch (err) {
      console.error("create project failed:", err);
    }
  }, [scope, dirs, onVaultChanged, onOpenProject]);

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
        await invoke("vault_rename", { relativePath: pending.path, newName: name });
      } else if (pending.kind === "delete") {
        await invoke("vault_delete", { relativePath: pending.path });
      }
      setPending(null);
      onVaultChanged();
      await loadDirs();
    } catch (err) {
      setPendingError(err instanceof Error ? err.message : String(err));
    }
  }, [pending, pendingInput, loadDirs, onVaultChanged]);

  const chipOptions = [
    { key: "work" as const, label: "Work" },
    { key: "personal" as const, label: "Personal" },
    { key: "archive" as const, label: "Archive" },
  ];

  const scopeLabel = chipOptions.find((o) => o.key === scope)!.label.toLowerCase();

  const visibleDirs = dirs.filter(
    (d) => !filter.trim() || d.name.toLowerCase().includes(filter.trim().toLowerCase())
  );

  return (
    <div className="vcolview-wrapper">
      <div className="vcolview">
        <div className="vcolview-header">
          <div className="vcolview-header-left">
            <VaultChips
              options={chipOptions}
              value={scope}
              onChange={setScope}
              ariaLabel="Projects scope"
            />
            <span className="vcolview-count">
              {visibleDirs.length} {visibleDirs.length === 1 ? "project" : "projects"}
            </span>
          </div>
          <VaultFilter
            value={filter}
            onChange={setFilter}
            placeholder="Filter projects…"
            ariaLabel="Filter projects"
          />
        </div>

        {visibleDirs.length === 0 ? (
          <div className="vcolview-empty">
            {filter.trim()
              ? `No matches for "${filter.trim()}"`
              : scope === "archive"
                ? "No archived projects."
                : `No ${scopeLabel} projects yet. Tap the + button to create one.`}
          </div>
        ) : (
          <div className="vgrid-content">
            {visibleDirs.map((entry) => {
              const path = `${scopePath(scope)}/${entry.name}`;
              const isOpen = menuFor === path;
              const { notes, todos } = metricFor(path);
              const metricPieces: string[] = [];
              if (notes > 0) metricPieces.push(`${notes} ${notes === 1 ? "note" : "notes"}`);
              if (todos) metricPieces.push("todos");
              const metric = metricPieces.length ? metricPieces.join(" · ") : "empty";
              return (
                <VaultCard
                  key={path}
                  variant="project"
                  collection="projects"
                  title={entry.name}
                  meta={<span>{metric}</span>}
                  onClick={() => onOpenProject(path)}
                  onMenu={() => setMenuFor(isOpen ? null : path)}
                  menu={
                    isOpen && (
                      <div
                        className="vcard-menu-popover"
                        role="menu"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          className="vcard-menu-item"
                          role="menuitem"
                          onClick={() => {
                            setMenuFor(null);
                            setPending({ kind: "rename", path, name: entry.name, isDir: true });
                            setPendingInput(entry.name);
                            setPendingError("");
                          }}
                        >Rename</button>
                        <button
                          type="button"
                          className="vcard-menu-item"
                          role="menuitem"
                          onClick={() => {
                            setMenuFor(null);
                            onRequestMove(path, entry.name, () => {
                              onVaultChanged();
                              loadDirs();
                            });
                          }}
                        >Move</button>
                        <button
                          type="button"
                          className="vcard-menu-item vcard-menu-item-danger"
                          role="menuitem"
                          onClick={() => {
                            setMenuFor(null);
                            setPending({ kind: "delete", path, name: entry.name, isDir: true });
                            setPendingError("");
                          }}
                        >Delete</button>
                      </div>
                    )
                  }
                />
              );
            })}
          </div>
        )}
      </div>
      <VaultFAB
        label={scope === "archive" ? "New in archive" : "New project"}
        onClick={handleCreate}
      />

      {pending && (
        <div className="vault-modal-overlay" onClick={() => setPending(null)}>
          <div className="vault-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="vault-modal-title">
              {pending.kind === "rename" ? "Rename project" : "Delete project"}
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
                placeholder="Project name"
              />
            ) : (
              <p className="vault-modal-text">
                Permanently delete <strong>{pending.name}</strong> and all its contents?
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
