import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { WikiLink, WikiEmbed, convertTextToWikiLinks } from "./wikilink";
import type { VaultFileInfo } from "./wikilink";

/* ── Types ────────────────────────────────────────── */

interface VaultEntry {
  name: string;
  is_dir: boolean;
  extension: string | null;
}

interface ColumnState {
  path: string;
  entries: VaultEntry[];
  selected: string | null;
}

interface VaultProps {
  refreshKey: number;
}

/* ── File icons ───────────────────────────────────── */

function fileIcon(entry: VaultEntry): string {
  if (entry.is_dir) return "\u25B8";
  switch (entry.extension) {
    case "md": return "\u2630";
    case "png": case "jpg": case "jpeg": case "gif": case "svg": case "webp": return "\u25A3";
    case "pdf": return "\u25A0";
    case "json": case "js": case "ts": case "py": return "\u2662";
    default: return "\u25CB";
  }
}

function iconClass(entry: VaultEntry): string {
  if (entry.is_dir) return "vault-icon-dir";
  switch (entry.extension) {
    case "md": return "vault-icon-md";
    case "png": case "jpg": case "jpeg": case "gif": case "svg": case "webp": return "vault-icon-img";
    default: return "vault-icon-other";
  }
}

/* ── Image check ──────────────────────────────────── */

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"]);

function isImageFile(entry: VaultEntry): boolean {
  return !entry.is_dir && !!entry.extension && IMAGE_EXTENSIONS.has(entry.extension.toLowerCase());
}

function isEditableFile(entry: VaultEntry): boolean {
  if (entry.is_dir) return false;
  if (isImageFile(entry)) return false;
  const textExts = new Set(["md", "txt", "json", "js", "ts", "py", "css", "html", "yaml", "yml", "toml", "cfg", "ini", "sh", "bat", "ps1"]);
  if (entry.extension && textExts.has(entry.extension.toLowerCase())) return true;
  if (!entry.extension) return true;
  return false;
}

/* ── Frontmatter handling ─────────────────────────── */

function stripFrontmatter(content: string): string {
  if (content.startsWith("---")) {
    const end = content.indexOf("---", 3);
    if (end !== -1) return content.slice(end + 3).trimStart();
  }
  return content;
}

function extractFrontmatter(content: string): string {
  if (content.startsWith("---")) {
    const end = content.indexOf("---", 3);
    if (end !== -1) return content.slice(0, end + 3) + "\n";
  }
  return "";
}

/* ── Auto-pair brackets ──────────────────────────── */

const PAIRS: Record<string, string> = {
  "(": ")",
  "{": "}",
  '"': '"',
  "'": "'",
  "`": "`",
};

const CLOSE_CHARS = new Set(Object.values(PAIRS));

/* ── Vault Component ──────────────────────────────── */

export default function Vault({ refreshKey }: VaultProps) {
  const [columns, setColumns] = useState<ColumnState[]>([]);
  const [openFile, setOpenFile] = useState<{ path: string; entry: VaultEntry } | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [frontmatter, setFrontmatter] = useState("");
  const [saveStatus, setSaveStatus] = useState<"" | "saved" | "error">("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const skipAutoSaveRef = useRef(false);

  // Vault file index
  const vaultFilesRef = useRef<VaultFileInfo[]>([]);
  const vaultStemsRef = useRef<Set<string>>(new Set());

  // Navigation history (back/forward)
  const [history, setHistory] = useState<{ path: string; entry: VaultEntry }[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const skipHistoryPush = useRef(false);

  // Editor ref for wikilink navigation
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);

  // Helper: load content into editor + convert wikilinks
  const loadIntoEditor = useCallback(
    (ed: NonNullable<ReturnType<typeof useEditor>>, body: string) => {
      skipAutoSaveRef.current = true;
      ed.commands.setContent(body);
      convertTextToWikiLinks(ed);
      skipAutoSaveRef.current = false;
    },
    []
  );

  // Open a file in the editor, optionally pushing to history
  const openFileInEditor = useCallback(
    async (path: string, entry: VaultEntry, pushHistory: boolean) => {
      try {
        const content = await invoke<string>("vault_read_file", { relativePath: path });
        setOpenFile({ path, entry });
        setImageUrl(null);
        const fm = extractFrontmatter(content);
        const body = fm ? stripFrontmatter(content) : content;
        setFrontmatter(fm);
        setFileContent(body);
        setSaveStatus("");
        if (editorRef.current && entry.extension === "md") {
          loadIntoEditor(editorRef.current, body);
        }
        if (pushHistory && !skipHistoryPush.current) {
          setHistory((prev) => {
            const trimmed = prev.slice(0, historyIndex + 1);
            return [...trimmed, { path, entry }];
          });
          setHistoryIndex((prev) => prev + 1);
        }
      } catch (err) {
        console.error("Failed to open file:", err);
      }
    },
    [loadIntoEditor, historyIndex]
  );

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < history.length - 1;

  const goBack = useCallback(() => {
    if (!canGoBack) return;
    const prev = history[historyIndex - 1];
    setHistoryIndex((i) => i - 1);
    skipHistoryPush.current = true;
    openFileInEditor(prev.path, prev.entry, false);
    skipHistoryPush.current = false;
  }, [canGoBack, history, historyIndex, openFileInEditor]);

  const goForward = useCallback(() => {
    if (!canGoForward) return;
    const next = history[historyIndex + 1];
    setHistoryIndex((i) => i + 1);
    skipHistoryPush.current = true;
    openFileInEditor(next.path, next.entry, false);
    skipHistoryPush.current = false;
  }, [canGoForward, history, historyIndex, openFileInEditor]);

  // Navigate to a wikilink target — resolve via backend recursive search
  const navigateToWikiLink = useCallback(
    async (target: string) => {
      try {
        const resolvedPath = await invoke<string>("vault_resolve_link", { target });
        const fileName = resolvedPath.split("/").pop()!;
        const entry: VaultEntry = {
          name: fileName,
          is_dir: false,
          extension: fileName.includes(".") ? fileName.split(".").pop()! : null,
        };
        await openFileInEditor(resolvedPath, entry, true);
      } catch (err) {
        console.error("WikiLink navigation failed:", err);
      }
    },
    [openFileInEditor]
  );

  // TipTap editor
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Link.configure({ openOnClick: false }),
      Image,
      Placeholder.configure({ placeholder: "Start writing..." }),
      Markdown.configure({
        html: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
      WikiLink.configure({
        onNavigate: (target) => navigateToWikiLink(target),
        checkExists: (stem: string) => vaultStemsRef.current.has(stem),
        getVaultFiles: () => vaultFilesRef.current,
      }),
      WikiEmbed,
    ],
    editorProps: {
      attributes: { class: "vault-editor-tiptap" },
      handleKeyDown: (_view, event) => {
        // Auto-pair: skip over closing char if it's already next
        if (CLOSE_CHARS.has(event.key) && editorRef.current) {
          const { from } = editorRef.current.state.selection;
          const after = editorRef.current.state.doc.textBetween(
            from,
            Math.min(editorRef.current.state.doc.content.size, from + 1)
          );
          if (after === event.key) {
            event.preventDefault();
            const tr = editorRef.current.state.tr;
            // Just move cursor forward
            tr.setSelection(
              editorRef.current.state.selection.constructor.near(
                tr.doc.resolve(from + 1)
              ) as typeof editorRef.current.state.selection
            );
            editorRef.current.view.dispatch(tr);
            return true;
          }
        }

        // Auto-pair: insert pair
        const closing = PAIRS[event.key];
        if (closing && editorRef.current) {
          event.preventDefault();
          const { from, to } = editorRef.current.state.selection;
          const tr = editorRef.current.state.tr;
          if (from === to) {
            // No selection: insert pair, cursor between
            tr.insertText(event.key + closing, from);
            tr.setSelection(
              editorRef.current.state.selection.constructor.near(
                tr.doc.resolve(from + 1)
              ) as typeof editorRef.current.state.selection
            );
          } else {
            // Wrap selection
            tr.insertText(closing, to);
            tr.insertText(event.key, from);
          }
          editorRef.current.view.dispatch(tr);
          return true;
        }

        // Backspace: delete empty pair
        if (event.key === "Backspace" && editorRef.current) {
          const { from } = editorRef.current.state.selection;
          if (from < 2) return false;
          const before = editorRef.current.state.doc.textBetween(from - 1, from);
          const after = editorRef.current.state.doc.textBetween(
            from,
            Math.min(editorRef.current.state.doc.content.size, from + 1)
          );
          const pair = PAIRS[before];
          if (pair && after === pair) {
            event.preventDefault();
            const tr = editorRef.current.state.tr;
            tr.delete(from - 1, from + 1);
            editorRef.current.view.dispatch(tr);
            return true;
          }
        }

        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (skipAutoSaveRef.current) return;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const md = (ed.storage as any).markdown?.getMarkdown?.() ?? ed.getHTML();
        saveFile(md);
      }, 800);
    },
  });

  // Keep editor ref in sync
  useEffect(() => {
    (editorRef as React.MutableRefObject<typeof editor>).current = editor;
  }, [editor]);

  // Load vault file index
  useEffect(() => {
    invoke<VaultFileInfo[]>("vault_all_files").then((files) => {
      vaultFilesRef.current = files;
      vaultStemsRef.current = new Set(files.map((f) => f.stem));
    });
  }, [refreshKey]);

  // Load root directory on mount
  useEffect(() => {
    loadDirectory("", 0);
  }, [refreshKey]);

  // Load a directory into a specific column index
  const loadDirectory = useCallback(async (path: string, colIndex: number) => {
    try {
      const entries = await invoke<VaultEntry[]>("vault_list", { relativePath: path });
      setColumns((prev) => {
        const updated = prev.slice(0, colIndex);
        updated.push({ path, entries, selected: null });
        return updated;
      });
    } catch (err) {
      console.error("Failed to load directory:", err);
    }
  }, []);

  // Handle clicking an entry
  const handleEntryClick = useCallback(
    async (colIndex: number, entry: VaultEntry) => {
      const col = columns[colIndex];
      if (!col) return;

      const entryPath = col.path ? `${col.path}/${entry.name}` : entry.name;

      setColumns((prev) => {
        const updated = [...prev];
        updated[colIndex] = { ...updated[colIndex], selected: entry.name };
        return updated.slice(0, colIndex + 1);
      });

      if (entry.is_dir) {
        await loadDirectory(entryPath, colIndex + 1);
        setOpenFile(null);
        setImageUrl(null);
      } else if (isImageFile(entry)) {
        setOpenFile({ path: entryPath, entry });
        setImageUrl(null);
        setFileContent("");
        try {
          const vaultPath = await invoke<string>("get_vault_path");
          const fullPath = `${vaultPath}/${entryPath}`.replace(/\\/g, "/");
          setImageUrl(`https://asset.localhost/${fullPath}`);
        } catch {
          setImageUrl(null);
        }
      } else if (isEditableFile(entry)) {
        await openFileInEditor(entryPath, entry, true);
      }
    },
    [columns, loadDirectory, openFileInEditor]
  );

  // Save file
  const saveFile = useCallback(
    async (markdown: string) => {
      if (!openFile) return;
      try {
        const content = frontmatter ? frontmatter + markdown : markdown;
        await invoke("vault_write_file", {
          relativePath: openFile.path,
          content,
        });
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus(""), 2000);
      } catch (err) {
        console.error("Failed to save:", err);
        setSaveStatus("error");
      }
    },
    [openFile, frontmatter]
  );

  // Keyboard shortcut for saving non-md files
  const handleRawKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const target = e.target as HTMLTextAreaElement;
        saveFile(target.value);
      }
    },
    [saveFile]
  );

  // Determine visible columns (max 3, shift left if deeper)
  const visibleColumns = columns.length <= 3 ? columns : columns.slice(columns.length - 3);
  const columnOffset = columns.length <= 3 ? 0 : columns.length - 3;

  const breadcrumb = columns.map((col, i) => {
    if (i === 0) return "vault";
    const parts = col.path.split("/");
    return parts[parts.length - 1];
  });

  return (
    <div className="vault-container">
      {/* Browser pane */}
      <div className="vault-browser">
        <div className="vault-breadcrumb">
          {breadcrumb.map((part, i) => (
            <span key={i}>
              {i > 0 && <span className="vault-breadcrumb-sep">/</span>}
              <span
                className={`vault-breadcrumb-part ${i === breadcrumb.length - 1 ? "vault-breadcrumb-active" : ""}`}
                onClick={() => {
                  if (i === 0) {
                    loadDirectory("", 0);
                    setOpenFile(null);
                  } else {
                    const targetPath = columns[i].path;
                    loadDirectory(targetPath, i);
                    setOpenFile(null);
                  }
                }}
              >
                {part}
              </span>
            </span>
          ))}
        </div>

        <div className="vault-columns">
          {visibleColumns.map((col, vi) => {
            const realIndex = vi + columnOffset;
            return (
              <div key={`${col.path}-${realIndex}`} className="vault-column">
                {col.entries.map((entry) => (
                  <div
                    key={entry.name}
                    className={`vault-entry ${col.selected === entry.name ? "vault-entry-selected" : ""} ${entry.is_dir ? "vault-entry-dir" : ""}`}
                    onClick={() => handleEntryClick(realIndex, entry)}
                  >
                    <span className={`vault-entry-icon ${iconClass(entry)}`}>
                      {fileIcon(entry)}
                    </span>
                    <span className="vault-entry-name">{entry.name}</span>
                    {entry.is_dir && <span className="vault-entry-chevron">&#x276F;</span>}
                  </div>
                ))}
                {col.entries.length === 0 && (
                  <div className="vault-empty">Empty folder</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Editor pane */}
      <div className="vault-editor">
        {/* Nav bar — always visible when a file is open */}
        {openFile && (
          <div className="vault-nav">
            <button
              className="vault-nav-btn"
              disabled={!canGoBack}
              onClick={goBack}
              title="Back"
            >&#x2190;</button>
            <button
              className="vault-nav-btn"
              disabled={!canGoForward}
              onClick={goForward}
              title="Forward"
            >&#x2192;</button>
            <span className="vault-nav-path">{openFile.path}</span>
            {saveStatus === "saved" && <span className="vault-editor-saved">saved</span>}
            {saveStatus === "error" && <span className="vault-editor-error">save failed</span>}
          </div>
        )}

        {!openFile && (
          <div className="vault-editor-empty">
            <p>Select a file to view or edit</p>
          </div>
        )}

        {openFile && imageUrl && (
          <div className="vault-editor-image">
            <div className="vault-editor-image-wrap">
              <img src={imageUrl} alt={openFile.entry.name} />
            </div>
          </div>
        )}

        {openFile && !imageUrl && openFile.entry.extension === "md" && editor && (
          <div className="vault-editor-md">
            <div className="vault-editor-content">
              <EditorContent editor={editor} />
            </div>
          </div>
        )}

        {openFile && !imageUrl && openFile.entry.extension !== "md" && (
          <div className="vault-editor-raw">
            <textarea
              className="vault-editor-textarea"
              value={fileContent}
              onChange={(e) => {
                setFileContent(e.target.value);
                if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
                saveTimerRef.current = window.setTimeout(() => {
                  saveFile(e.target.value);
                }, 800);
              }}
              onKeyDown={handleRawKeyDown}
              spellCheck={false}
            />
          </div>
        )}
      </div>
    </div>
  );
}
