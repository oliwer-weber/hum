import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import VaultCard from "./VaultCard";
import VaultFAB from "./VaultFAB";
import VaultFilter from "./VaultFilter";

interface VaultEntry {
  name: string;
  is_dir: boolean;
  extension: string | null;
}

interface LibraryViewProps {
  refreshKey: number;
  subPath: string;
  onSubPathChange: (p: string) => void;
  onOpenPath: (path: string) => void;
  onRequestMove: (path: string, name: string, onDone: () => void) => void;
  onVaultChanged: () => void;
}

const LIB_ROOT = "wiki";

function stripMdExt(name: string): string {
  return name.replace(/\.md$/i, "");
}

function joinPath(...parts: string[]): string {
  return parts.filter(Boolean).join("/");
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
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const [pending, setPending] = useState<
    | null
    | { kind: "rename"; path: string; name: string; isDir: boolean }
    | { kind: "delete"; path: string; name: string; isDir: boolean }
  >(null);
  const [pendingInput, setPendingInput] = useState("");
  const [pendingError, setPendingError] = useState("");

  const currentDir = subPath ? joinPath(LIB_ROOT, subPath) : LIB_ROOT;

  const loadEntries = useCallback(async () => {
    try {
      const items = await invoke<VaultEntry[]>("vault_list", { relativePath: currentDir });
      // Folders first, then files, alphabetical within each.
      items.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setEntries(items);
    } catch {
      setEntries([]);
    }
  }, [currentDir]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries, refreshKey]);

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

  const handleCardClick = useCallback(
    (entry: VaultEntry) => {
      if (entry.is_dir) {
        onSubPathChange(joinPath(subPath, entry.name));
      } else {
        onOpenPath(joinPath(currentDir, entry.name));
      }
    },
    [subPath, currentDir, onSubPathChange, onOpenPath]
  );

  const handleCreate = useCallback(async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const existing = new Set(entries.map((e) => e.name));
    let candidate = `${stamp}.md`;
    let n = 1;
    while (existing.has(candidate)) {
      n += 1;
      candidate = `${stamp}-${n}.md`;
    }
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
        if (!name || name === pending.name) {
          setPending(null);
          return;
        }
        const finalName = !pending.isDir && !name.includes(".") ? `${name}.md` : name;
        await invoke("vault_rename", { relativePath: pending.path, newName: finalName });
      } else if (pending.kind === "delete") {
        await invoke("vault_delete", { relativePath: pending.path });
      }
      setPending(null);
      onVaultChanged();
      await loadEntries();
    } catch (err) {
      setPendingError(err instanceof Error ? err.message : String(err));
    }
  }, [pending, pendingInput, loadEntries, onVaultChanged]);

  const visibleEntries = entries.filter(
    (e) => !filter.trim() || e.name.toLowerCase().includes(filter.trim().toLowerCase())
  );
  const folderCount = visibleEntries.filter((e) => e.is_dir).length;
  const fileCount = visibleEntries.filter((e) => !e.is_dir).length;

  return (
    <div className="vcolview-wrapper">
      <div className="vcolview">
      <div className="vcolview-header">
        <div className="vcolview-header-left">
          <span className="vcolview-count">
            {folderCount > 0 && `${folderCount} ${folderCount === 1 ? "folder" : "folders"}`}
            {folderCount > 0 && fileCount > 0 && " · "}
            {fileCount > 0 && `${fileCount} ${fileCount === 1 ? "entry" : "entries"}`}
            {folderCount === 0 && fileCount === 0 && "empty"}
          </span>
        </div>
        <VaultFilter
          value={filter}
          onChange={setFilter}
          placeholder="Filter library…"
          ariaLabel="Filter library"
        />
      </div>

      {visibleEntries.length === 0 ? (
        <div className="vcolview-empty">
          {filter.trim()
            ? `No matches for "${filter.trim()}"`
            : "Nothing here yet. Tap the + button to add an entry."}
        </div>
      ) : (
        <div className="vgrid-content">
          {visibleEntries.map((entry) => {
            const path = joinPath(currentDir, entry.name);
            const title = entry.is_dir ? entry.name : stripMdExt(entry.name);
            const isOpen = menuFor === path;
            return (
              <VaultCard
                key={path}
                variant="content"
                shape={entry.is_dir ? "folder" : undefined}
                collection="library"
                title={title}
                onClick={() => handleCardClick(entry)}
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
                          setPending({ kind: "rename", path, name: entry.name, isDir: entry.is_dir });
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
                            loadEntries();
                          });
                        }}
                      >Move</button>
                      <button
                        type="button"
                        className="vcard-menu-item vcard-menu-item-danger"
                        role="menuitem"
                        onClick={() => {
                          setMenuFor(null);
                          setPending({ kind: "delete", path, name: entry.name, isDir: entry.is_dir });
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
