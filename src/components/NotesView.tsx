import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import VaultCard from "./VaultCard";
import VaultChips from "./VaultChips";
import VaultFAB from "./VaultFAB";
import VaultFilter from "./VaultFilter";

interface VaultEntry {
  name: string;
  is_dir: boolean;
  extension: string | null;
}

interface NotesViewProps {
  refreshKey: number;
  onOpenPath: (path: string) => void;
  onRequestMove: (path: string, name: string, onDone: () => void) => void;
  onVaultChanged: () => void;
}

type ChipKey = "recent" | "archive";

const NOTES_ROOT = "notes";
const NOTES_ARCHIVE = "notes/archive";

function stripMdExt(name: string): string {
  return name.replace(/\.md$/i, "");
}

export default function NotesView({ refreshKey, onOpenPath, onRequestMove, onVaultChanged }: NotesViewProps) {
  const [scope, setScope] = useState<ChipKey>("recent");
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  // Inline modal for rename + delete (move delegates to parent)
  const [pending, setPending] = useState<
    | null
    | { kind: "rename"; path: string; name: string; isDir: boolean }
    | { kind: "delete"; path: string; name: string; isDir: boolean }
  >(null);
  const [pendingInput, setPendingInput] = useState("");
  const [pendingError, setPendingError] = useState("");

  const loadEntries = useCallback(async () => {
    const dir = scope === "archive" ? NOTES_ARCHIVE : NOTES_ROOT;
    try {
      const items = await invoke<VaultEntry[]>("vault_list", { relativePath: dir });
      // In Recent scope, exclude the archive directory itself.
      // In Archive scope, exclude any nested dirs (we flat-list files only).
      const filtered = items.filter((e) => {
        if (scope === "recent") return e.name !== "archive";
        return !e.is_dir;
      });
      filtered.sort((a, b) => a.name.localeCompare(b.name));
      setEntries(filtered);
    } catch {
      setEntries([]);
    }
  }, [scope]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries, refreshKey]);

  // Click-away + Escape dismisses the per-card menu popover
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

  const handleCreate = useCallback(async () => {
    const dir = scope === "archive" ? NOTES_ARCHIVE : NOTES_ROOT;
    // Simple generated name — user renames immediately via the editor title.
    const stamp = new Date().toISOString().slice(0, 10);
    let candidate = `${stamp}.md`;
    const existing = new Set(entries.map((e) => e.name));
    let n = 1;
    while (existing.has(candidate)) {
      n += 1;
      candidate = `${stamp}-${n}.md`;
    }
    const path = `${dir}/${candidate}`;
    try {
      await invoke("vault_create_file", { relativePath: path, content: "" });
      onVaultChanged();
      onOpenPath(path);
    } catch (err) {
      console.error("create note failed:", err);
    }
  }, [scope, entries, onOpenPath, onVaultChanged]);

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
      await loadEntries();
    } catch (err) {
      setPendingError(err instanceof Error ? err.message : String(err));
    }
  }, [pending, pendingInput, loadEntries, onVaultChanged]);

  const files = entries
    .filter((e) => !e.is_dir)
    .filter((e) => !filter.trim() || e.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const chipOptions = [
    { key: "recent" as const, label: "Recent" },
    { key: "archive" as const, label: "Archive" },
  ];

  return (
    <div className="vcolview-wrapper">
      <div className="vcolview">
      <div className="vcolview-header">
        <div className="vcolview-header-left">
          <VaultChips
            options={chipOptions}
            value={scope}
            onChange={setScope}
            ariaLabel="Notes scope"
          />
          <span className="vcolview-count">
            {files.length} {files.length === 1 ? "note" : "notes"}
          </span>
        </div>
        <VaultFilter
          value={filter}
          onChange={setFilter}
          placeholder="Filter notes…"
          ariaLabel="Filter notes"
        />
      </div>

      {files.length === 0 ? (
        <div className="vcolview-empty">
          {filter.trim()
            ? `No matches for "${filter.trim()}"`
            : scope === "archive"
              ? "No archived notes."
              : "No notes yet. Tap the + button to jot one down."}
        </div>
      ) : (
        <div className="vgrid-content">
          {files.map((entry) => {
            const path = `${scope === "archive" ? NOTES_ARCHIVE : NOTES_ROOT}/${entry.name}`;
            const title = stripMdExt(entry.name);
            const isOpen = menuFor === path;
            return (
              <VaultCard
                key={path}
                variant="content"
                collection="notes"
                title={title}
                onClick={() => onOpenPath(path)}
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
                          setPending({ kind: "rename", path, name: entry.name, isDir: false });
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
                          setPending({ kind: "delete", path, name: entry.name, isDir: false });
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
        label={scope === "archive" ? "New in archive" : "New note"}
        onClick={handleCreate}
      />

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
                {pending.kind === "delete" ? "Delete" : "Rename"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
