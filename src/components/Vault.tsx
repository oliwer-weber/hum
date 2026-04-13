import { useState, useEffect, useCallback, useRef, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useEditor, EditorContent } from "@tiptap/react";
import { DndContext, DragOverlay, useDraggable, useDroppable, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { WikiLink, WikiEmbed, convertTextToWikiLinks } from "./wikilink";
import type { VaultFileInfo } from "./wikilink";
import { HashTag } from "./hashtag";

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
  openPath?: string | null;
  onOpenPathHandled?: () => void;
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

/* ── Search highlight helper ──────────────────────── */

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return parts.map((part, i) =>
    i % 2 === 1 ? <mark key={i} className="search-highlight">{part}</mark> : part
  );
}

/* ── Draggable/Droppable entry wrappers ──────────── */

const DraggableEntry = memo(function DraggableEntry({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} style={{ opacity: isDragging ? 0.4 : 1 }}>
      {children}
    </div>
  );
});

const DroppableDir = memo(function DroppableDir({ id, children }: { id: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={isOver ? "vault-entry-drop-target" : ""}>
      {children}
    </div>
  );
});

const DroppableColumn = memo(function DroppableColumn({ id, children, className }: { id: string; children: React.ReactNode; className?: string }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={`${className || ""} ${isOver ? "vault-column-drop-target" : ""}`}>
      {children}
    </div>
  );
});

/* ── Modal types ──────────────────────────────────── */

type ModalState =
  | null
  | { kind: "create-file"; dir: string; colIndex: number }
  | { kind: "create-dir"; dir: string; colIndex: number }
  | { kind: "rename"; path: string; name: string; is_dir: boolean; colIndex: number }
  | { kind: "delete"; path: string; name: string; is_dir: boolean; colIndex: number };

/* ── Vault Component ──────────────────────────────── */

export default function Vault({ refreshKey, openPath, onOpenPathHandled }: VaultProps) {
  const [columns, setColumns] = useState<ColumnState[]>([]);
  const [openFile, setOpenFile] = useState<{ path: string; entry: VaultEntry } | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [frontmatter, setFrontmatter] = useState("");
  const [saveStatus, setSaveStatus] = useState<"" | "saved" | "error">("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const skipAutoSaveRef = useRef(false);

  // Modal state
  const [modal, setModal] = useState<ModalState>(null);
  const [modalInput, setModalInput] = useState("");
  const [modalError, setModalError] = useState("");
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const createBtnRef = useRef<HTMLButtonElement>(null);

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; path: string; entry: VaultEntry; colIndex: number } | null>(null);

  // Move modal state
  const [moveSource, setMoveSource] = useState<{ path: string; name: string } | null>(null);
  const [moveBrowsePath, setMoveBrowsePath] = useState("");
  const [moveBrowseEntries, setMoveBrowseEntries] = useState<VaultEntry[]>([]);
  const [moveError, setMoveError] = useState("");

  // Search state
  const [searchMode, setSearchMode] = useState<null | "files" | "content">(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ path: string; name: string; line_number?: number; line_content?: string }>>([]);
  const [searchActiveIdx, setSearchActiveIdx] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchDebounceRef = useRef<number | null>(null);
  const searchGenRef = useRef(0);

  // Find/replace in editor
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [findMatches, setFindMatches] = useState<{ from: number; to: number }[]>([]);
  const [findActiveIdx, setFindActiveIdx] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);

  // Drag and drop state
  const [draggedEntry, setDraggedEntry] = useState<{ path: string; entry: VaultEntry } | null>(null);
  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  // Backlinks state
  const [backlinks, setBacklinks] = useState<Array<{ path: string; name: string; line_number: number; line_content: string }>>([]);
  const [showBacklinks, setShowBacklinks] = useState(true);

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
      HashTag,
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
              (editorRef.current.state.selection.constructor as unknown as { near: (pos: unknown) => unknown }).near(
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
              (editorRef.current.state.selection.constructor as unknown as { near: (pos: unknown) => unknown }).near(
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

  // Navigate to a file path — builds miller columns to match, then opens the file
  const navigateToPath = useCallback(async (filePath: string) => {
    const segments = filePath.split("/");
    const fileName = segments.pop() || "";

    const newColumns: ColumnState[] = [];
    let currentPath = "";

    try {
      const rootEntries = await invoke<VaultEntry[]>("vault_list", { relativePath: "" });
      newColumns.push({ path: "", entries: rootEntries, selected: segments[0] || null });
    } catch { return; }

    for (let i = 0; i < segments.length; i++) {
      currentPath = currentPath ? `${currentPath}/${segments[i]}` : segments[i];
      try {
        const entries = await invoke<VaultEntry[]>("vault_list", { relativePath: currentPath });
        const nextSelected = i < segments.length - 1 ? segments[i + 1] : fileName;
        newColumns.push({ path: currentPath, entries, selected: nextSelected });
      } catch { break; }
    }

    setColumns(newColumns);

    const entry: VaultEntry = {
      name: fileName,
      is_dir: false,
      extension: fileName.includes(".") ? fileName.split(".").pop()! : null,
    };
    await openFileInEditor(filePath, entry, true);
  }, [openFileInEditor]);

  // Navigate to an externally requested file path
  useEffect(() => {
    if (!openPath) return;
    navigateToPath(openPath).then(() => onOpenPathHandled?.());
  }, [openPath, navigateToPath, onOpenPathHandled]);

  // Fetch backlinks when a markdown file is opened
  useEffect(() => {
    if (!openFile || openFile.entry.extension !== "md") {
      setBacklinks([]);
      return;
    }
    const stem = openFile.entry.name.replace(/\.md$/, "");
    invoke<Array<{ path: string; name: string; line_number: number; line_content: string }>>(
      "vault_get_backlinks", { targetStem: stem }
    ).then(setBacklinks).catch(() => setBacklinks([]));
  }, [openFile]);

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

  // Stamp completion dates on checked todos that don't have one yet
  const stampCompletionDates = useCallback((markdown: string): string => {
    const today = new Date().toISOString().slice(0, 10);
    return markdown.replace(/^(- \[x\].*?)$/gm, (line) => {
      if (line.includes("✅")) return line; // already stamped
      // Strip trailing whitespace, append date
      return `${line.trimEnd()} ✅ ${today}`;
    });
  }, []);

  // Save file
  const saveFile = useCallback(
    async (markdown: string) => {
      if (!openFile) return;
      try {
        const stamped = stampCompletionDates(markdown);
        const content = frontmatter ? frontmatter + stamped : stamped;
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
    [openFile, frontmatter, stampCompletionDates]
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

  // Close context menu on click-away or Escape
  useEffect(() => {
    if (!ctxMenu) return;
    const handleClick = () => setCtxMenu(null);
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") setCtxMenu(null); };
    document.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("click", handleClick); document.removeEventListener("keydown", handleKey); };
  }, [ctxMenu]);

  // Close create menu on click-away
  useEffect(() => {
    if (!showCreateMenu) return;
    const handleClick = () => setShowCreateMenu(false);
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [showCreateMenu]);

  // Context menu right-click handler
  const handleContextMenu = useCallback((e: React.MouseEvent, path: string, entry: VaultEntry, colIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, path, entry, colIndex });
  }, []);

  // Copy a file/folder in place
  const handleCopy = useCallback(async (path: string, colIndex: number) => {
    try {
      const parentPath = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : "";
      await invoke<string>("vault_copy", { source: path, destDir: parentPath || "." });
      const col = columns[colIndex];
      if (col) await loadDirectory(col.path, colIndex);
    } catch (err) {
      console.error("Copy failed:", err);
    }
  }, [columns, loadDirectory]);

  // Open the move modal
  const openMoveModal = useCallback(async (path: string, name: string) => {
    setMoveSource({ path, name });
    setMoveBrowsePath("");
    setMoveError("");
    try {
      const entries = await invoke<VaultEntry[]>("vault_list", { relativePath: "" });
      setMoveBrowseEntries(entries.filter((e) => e.is_dir));
    } catch { setMoveBrowseEntries([]); }
  }, []);

  // Navigate within the move modal
  const moveBrowseNavigate = useCallback(async (dirPath: string) => {
    setMoveBrowsePath(dirPath);
    setMoveError("");
    try {
      const entries = await invoke<VaultEntry[]>("vault_list", { relativePath: dirPath });
      setMoveBrowseEntries(entries.filter((e) => e.is_dir));
    } catch { setMoveBrowseEntries([]); }
  }, []);

  // Execute the move
  const handleMoveSubmit = useCallback(async () => {
    if (!moveSource) return;
    setMoveError("");
    try {
      const destDir = moveBrowsePath || ".";
      await invoke<string>("vault_move", { source: moveSource.path, destDir });
      setMoveSource(null);
      // Refresh all visible columns
      for (let i = 0; i < columns.length; i++) {
        await loadDirectory(columns[i].path, i);
      }
      // Update file index
      const files = await invoke<VaultFileInfo[]>("vault_all_files");
      vaultFilesRef.current = files;
      vaultStemsRef.current = new Set(files.map((f) => f.stem));
      // Clear editor if moved file was open
      if (openFile && openFile.path === moveSource.path) {
        setOpenFile(null);
        setImageUrl(null);
      }
    } catch (err) {
      setMoveError(err instanceof Error ? err.message : String(err));
    }
  }, [moveSource, moveBrowsePath, columns, loadDirectory, openFile]);

  // ── Global keyboard shortcuts (search, find) ──
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+P — file search
      if ((e.ctrlKey || e.metaKey) && e.key === "p" && !e.shiftKey) {
        e.preventDefault();
        setSearchMode("files");
        setSearchQuery("");
        setSearchResults([]);
        setSearchActiveIdx(0);
        setTimeout(() => searchInputRef.current?.focus(), 50);
        return;
      }
      // Ctrl+Shift+F — content search
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "F") {
        e.preventDefault();
        setSearchMode("content");
        setSearchQuery("");
        setSearchResults([]);
        setSearchActiveIdx(0);
        setTimeout(() => searchInputRef.current?.focus(), 50);
        return;
      }
      // Ctrl+F — find in editor (only when md file is open)
      if ((e.ctrlKey || e.metaKey) && e.key === "f" && !e.shiftKey && openFile?.entry.extension === "md") {
        e.preventDefault();
        setFindOpen(true);
        setShowReplace(false);
        setTimeout(() => findInputRef.current?.focus(), 50);
        return;
      }
      // Ctrl+H — find+replace in editor
      if ((e.ctrlKey || e.metaKey) && e.key === "h" && openFile?.entry.extension === "md") {
        e.preventDefault();
        setFindOpen(true);
        setShowReplace(true);
        setTimeout(() => findInputRef.current?.focus(), 50);
        return;
      }
      // Escape — close search/find
      if (e.key === "Escape") {
        if (searchMode) { setSearchMode(null); return; }
        if (findOpen) { setFindOpen(false); return; }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [searchMode, findOpen, openFile]);

  // Debounced search execution with stale-result guard
  useEffect(() => {
    if (!searchMode || !searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    const gen = ++searchGenRef.current;
    searchDebounceRef.current = window.setTimeout(async () => {
      try {
        if (searchMode === "files") {
          const results = await invoke<VaultFileInfo[]>("vault_search_files", { query: searchQuery });
          if (gen !== searchGenRef.current) return; // stale
          setSearchResults(results.map((f) => ({ path: f.path, name: f.name })));
        } else {
          const results = await invoke<Array<{ path: string; name: string; line_number: number; line_content: string }>>(
            "vault_search_content", { query: searchQuery, maxResults: 30 }
          );
          if (gen !== searchGenRef.current) return; // stale
          setSearchResults(results);
        }
        setSearchActiveIdx(0);
      } catch (err) {
        if (gen === searchGenRef.current) console.error("Search failed:", err);
      }
    }, 400);
    return () => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current); };
  }, [searchQuery, searchMode]);

  // Open a search result
  const openSearchResult = useCallback(async (result: { path: string; name: string }) => {
    await navigateToPath(result.path);
    setSearchMode(null);
  }, [navigateToPath]);

  // Search keyboard navigation
  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSearchActiveIdx((prev) => Math.min(prev + 1, searchResults.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSearchActiveIdx((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && searchResults[searchActiveIdx]) {
      openSearchResult(searchResults[searchActiveIdx]);
    } else if (e.key === "Escape") {
      setSearchMode(null);
    }
  }, [searchResults, searchActiveIdx, openSearchResult]);

  // ── Find in editor logic ──
  useEffect(() => {
    if (!findOpen || !findQuery || !editor) {
      setFindMatches([]);
      return;
    }
    const doc = editor.state.doc;
    const text = doc.textBetween(0, doc.content.size, "\n");
    const q = findQuery.toLowerCase();
    const matches: { from: number; to: number }[] = [];
    let idx = 0;
    const textLower = text.toLowerCase();
    while (idx < textLower.length) {
      const found = textLower.indexOf(q, idx);
      if (found === -1) break;
      matches.push({ from: found + 1, to: found + 1 + q.length }); // +1 for ProseMirror offset
      idx = found + 1;
    }
    setFindMatches(matches);
    setFindActiveIdx(0);
  }, [findQuery, findOpen, editor]);

  // Scroll to active find match
  useEffect(() => {
    if (!editor || findMatches.length === 0) return;
    const match = findMatches[findActiveIdx];
    if (!match) return;
    editor.commands.setTextSelection({ from: match.from, to: match.to });
    editor.commands.scrollIntoView();
  }, [findActiveIdx, findMatches, editor]);

  const findNext = useCallback(() => {
    setFindActiveIdx((prev) => (prev + 1) % Math.max(findMatches.length, 1));
  }, [findMatches]);

  const findPrev = useCallback(() => {
    setFindActiveIdx((prev) => (prev - 1 + findMatches.length) % Math.max(findMatches.length, 1));
  }, [findMatches]);

  const handleReplace = useCallback(() => {
    if (!editor || findMatches.length === 0) return;
    const match = findMatches[findActiveIdx];
    if (!match) return;
    editor.chain().focus().setTextSelection({ from: match.from, to: match.to }).insertContent(replaceQuery).run();
    // Re-trigger find
    setFindQuery((q) => q + ""); // force re-render
  }, [editor, findMatches, findActiveIdx, replaceQuery]);

  const handleReplaceAll = useCallback(() => {
    if (!editor || findMatches.length === 0) return;
    // Replace from end to start to preserve positions
    const sorted = [...findMatches].sort((a, b) => b.from - a.from);
    const chain = editor.chain().focus();
    for (const match of sorted) {
      chain.setTextSelection({ from: match.from, to: match.to }).insertContent(replaceQuery);
    }
    chain.run();
    setFindMatches([]);
  }, [editor, findMatches, replaceQuery]);

  // ── Drag and drop handlers ──
  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = String(event.active.id);
    // id format: "drag:<path>"
    const path = id.replace("drag:", "");
    const name = path.split("/").pop() || "";
    const entry: VaultEntry = {
      name,
      is_dir: false, // We'll determine from context
      extension: name.includes(".") ? name.split(".").pop()! : null,
    };
    // Check if it's a directory by looking in columns
    for (const col of columns) {
      const found = col.entries.find((e) => {
        const ePath = col.path ? `${col.path}/${e.name}` : e.name;
        return ePath === path;
      });
      if (found) {
        entry.is_dir = found.is_dir;
        entry.extension = found.extension;
        break;
      }
    }
    setDraggedEntry({ path, entry });
  }, [columns]);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    setDraggedEntry(null);
    const { active, over } = event;
    if (!over) return;

    const sourcePath = String(active.id).replace("drag:", "");
    const destDir = String(over.id).replace("drop:", "");

    // Don't drop onto self or same parent
    const sourceParent = sourcePath.includes("/") ? sourcePath.substring(0, sourcePath.lastIndexOf("/")) : "";
    if (destDir === sourceParent || destDir === sourcePath) return;

    try {
      await invoke<string>("vault_move", { source: sourcePath, destDir: destDir || "." });
      // Refresh all visible columns
      for (let i = 0; i < columns.length; i++) {
        await loadDirectory(columns[i].path, i);
      }
      const files = await invoke<VaultFileInfo[]>("vault_all_files");
      vaultFilesRef.current = files;
      vaultStemsRef.current = new Set(files.map((f) => f.stem));
    } catch (err) {
      console.error("Drag-move failed:", err);
    }
  }, [columns, loadDirectory]);

  // Refresh a column + vault file index after mutations
  const refreshAfterMutation = useCallback(async (colIndex: number) => {
    const col = columns[colIndex];
    if (col) await loadDirectory(col.path, colIndex);
    const files = await invoke<VaultFileInfo[]>("vault_all_files");
    vaultFilesRef.current = files;
    vaultStemsRef.current = new Set(files.map((f) => f.stem));
  }, [columns, loadDirectory]);

  // Get the directory path for the rightmost column
  const currentDir = columns.length > 0 ? columns[columns.length - 1].path : "";
  const currentColIndex = columns.length - 1;

  // Open a modal
  const openModal = useCallback((state: ModalState) => {
    setModal(state);
    setModalInput(state?.kind === "rename" ? state.name : "");
    setModalError("");
  }, []);

  // Modal submit handler
  const handleModalSubmit = useCallback(async () => {
    if (!modal) return;
    setModalError("");

    try {
      if (modal.kind === "create-file") {
        const name = modalInput.trim();
        if (!name) return;
        const fullName = name.includes(".") ? name : `${name}.md`;
        const path = modal.dir ? `${modal.dir}/${fullName}` : fullName;
        await invoke("vault_create_file", { relativePath: path, content: "" });
        await refreshAfterMutation(modal.colIndex);
      } else if (modal.kind === "create-dir") {
        const name = modalInput.trim();
        if (!name) return;
        const path = modal.dir ? `${modal.dir}/${name}` : name;
        await invoke("vault_create_dir", { relativePath: path });
        await refreshAfterMutation(modal.colIndex);
      } else if (modal.kind === "rename") {
        const name = modalInput.trim();
        if (!name || name === modal.name) return;
        const newPath = await invoke<string>("vault_rename", { relativePath: modal.path, newName: name });
        await refreshAfterMutation(modal.colIndex);
        // Update openFile if the renamed file was open
        if (openFile && openFile.path === modal.path) {
          setOpenFile({ path: newPath, entry: { ...openFile.entry, name } });
        }
      } else if (modal.kind === "delete") {
        await invoke("vault_delete", { relativePath: modal.path });
        await refreshAfterMutation(modal.colIndex);
        // Clear editor if deleted file was open
        if (openFile && openFile.path === modal.path) {
          setOpenFile(null);
          setImageUrl(null);
        }
      }
      setModal(null);
    } catch (err) {
      setModalError(err instanceof Error ? err.message : String(err));
    }
  }, [modal, modalInput, openFile, refreshAfterMutation]);

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
          <div className="vault-breadcrumb-actions">
            <button
              ref={createBtnRef}
              className="vault-create-btn"
              onClick={(e) => { e.stopPropagation(); setShowCreateMenu((v) => !v); }}
              title="New file or folder"
            >+</button>
          </div>
        </div>

        <DndContext sensors={dndSensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <div className="vault-columns">
            {visibleColumns.map((col, vi) => {
              const realIndex = vi + columnOffset;
              return (
                <DroppableColumn key={`${col.path}-${realIndex}`} id={`drop:${col.path || "."}`} className="vault-column">
                  {col.entries.map((entry) => {
                    const entryPath = col.path ? `${col.path}/${entry.name}` : entry.name;
                    const entryContent = (
                      <div
                        className={`vault-entry ${col.selected === entry.name ? "vault-entry-selected" : ""} ${entry.is_dir ? "vault-entry-dir" : ""}`}
                        onClick={() => handleEntryClick(realIndex, entry)}
                        onContextMenu={(e) => handleContextMenu(e, entryPath, entry, realIndex)}
                      >
                        <span className={`vault-entry-icon ${iconClass(entry)}`}>
                          {fileIcon(entry)}
                        </span>
                        <span className="vault-entry-name">{entry.name}</span>
                        {entry.is_dir && <span className="vault-entry-chevron">&#x276F;</span>}
                      </div>
                    );

                    if (entry.is_dir) {
                      return (
                        <DraggableEntry key={entry.name} id={`drag:${entryPath}`}>
                          <DroppableDir id={`drop:${entryPath}`}>
                            {entryContent}
                          </DroppableDir>
                        </DraggableEntry>
                      );
                    }
                    return (
                      <DraggableEntry key={entry.name} id={`drag:${entryPath}`}>
                        {entryContent}
                      </DraggableEntry>
                    );
                  })}
                  {col.entries.length === 0 && (
                    <div className="vault-empty">Empty folder</div>
                  )}
                </DroppableColumn>
              );
            })}
          </div>
          <DragOverlay>
            {draggedEntry && (
              <div className="vault-drag-overlay">
                <span className={`vault-entry-icon ${iconClass(draggedEntry.entry)}`}>
                  {fileIcon(draggedEntry.entry)}
                </span>
                <span>{draggedEntry.entry.name}</span>
              </div>
            )}
          </DragOverlay>
        </DndContext>
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
            {openFile.entry.extension === "md" && backlinks.length > 0 && (
              <button
                className={`vault-backlinks-toggle ${showBacklinks ? "vault-backlinks-toggle-active" : ""}`}
                onClick={() => setShowBacklinks((v) => !v)}
                title={`${backlinks.length} backlink${backlinks.length !== 1 ? "s" : ""}`}
              >
                {backlinks.length} {"\u2190"}
              </button>
            )}
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
            {findOpen && (
              <div className="vault-find-bar">
                <div className="vault-find-row">
                  <input
                    ref={findInputRef}
                    className="vault-find-input"
                    placeholder="Find..."
                    value={findQuery}
                    onChange={(e) => setFindQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.shiftKey ? findPrev() : findNext(); }
                      if (e.key === "Escape") setFindOpen(false);
                    }}
                  />
                  <span className="vault-find-count">
                    {findMatches.length > 0 ? `${findActiveIdx + 1}/${findMatches.length}` : "0 results"}
                  </span>
                  <button className="vault-find-btn" onClick={findPrev} title="Previous">{"\u2191"}</button>
                  <button className="vault-find-btn" onClick={findNext} title="Next">{"\u2193"}</button>
                  <button className="vault-find-btn" onClick={() => setShowReplace((v) => !v)} title="Toggle replace">
                    {showReplace ? "\u2212" : "\u2026"}
                  </button>
                  <button className="vault-find-btn" onClick={() => setFindOpen(false)} title="Close">{"\u2715"}</button>
                </div>
                {showReplace && (
                  <div className="vault-find-row">
                    <input
                      className="vault-find-input"
                      placeholder="Replace..."
                      value={replaceQuery}
                      onChange={(e) => setReplaceQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleReplace();
                        if (e.key === "Escape") setFindOpen(false);
                      }}
                    />
                    <button className="vault-find-btn" onClick={handleReplace} title="Replace">Replace</button>
                    <button className="vault-find-btn" onClick={handleReplaceAll} title="Replace all">All</button>
                  </div>
                )}
              </div>
            )}
            <div className="vault-editor-content">
              <EditorContent editor={editor} />
            </div>
            {showBacklinks && backlinks.length > 0 && (
              <div className="vault-backlinks-panel">
                <div className="vault-backlinks-header">
                  <span>Backlinks ({backlinks.length})</span>
                </div>
                {backlinks.map((bl, i) => (
                  <div
                    key={`${bl.path}-${bl.line_number}-${i}`}
                    className="vault-backlink-item"
                    onClick={() => navigateToPath(bl.path)}
                  >
                    <span className="vault-backlink-name">{bl.name}</span>
                    <span className="vault-backlink-context">{bl.line_content}</span>
                  </div>
                ))}
              </div>
            )}
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

      {/* ── Create dropdown (fixed, escapes overflow) ── */}
      {showCreateMenu && createBtnRef.current && (() => {
        const rect = createBtnRef.current!.getBoundingClientRect();
        return (
          <div
            className="vault-create-menu"
            style={{ top: rect.bottom + 4, right: window.innerWidth - rect.right }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="vault-create-menu-item"
              onClick={() => {
                setShowCreateMenu(false);
                openModal({ kind: "create-file", dir: currentDir, colIndex: currentColIndex });
              }}
            >New file</div>
            <div
              className="vault-create-menu-item"
              onClick={() => {
                setShowCreateMenu(false);
                openModal({ kind: "create-dir", dir: currentDir, colIndex: currentColIndex });
              }}
            >New folder</div>
          </div>
        );
      })()}

      {/* ── Search overlay ── */}
      {searchMode && (
        <div className="vault-search-overlay" onClick={() => setSearchMode(null)}>
          <div className="vault-search-panel" onClick={(e) => e.stopPropagation()}>
            <div className="vault-search-header">
              <span className="vault-search-mode-label">{searchMode === "files" ? "Files" : "Content"}</span>
              <input
                ref={searchInputRef}
                className="vault-search-input"
                placeholder={searchMode === "files" ? "Search files..." : "Search in files..."}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
              />
            </div>
            <div className="vault-search-results">
              {searchResults.map((result, i) => (
                <div
                  key={`${result.path}-${result.line_number ?? 0}-${i}`}
                  className={`vault-search-result ${i === searchActiveIdx ? "vault-search-result-active" : ""}`}
                  onClick={() => openSearchResult(result)}
                >
                  {searchMode === "content" && result.line_content ? (
                    <>
                      <span className="vault-search-result-content">
                        {highlightMatch(result.line_content, searchQuery)}
                      </span>
                      <span className="vault-search-result-meta">
                        <span className="vault-search-result-file">{result.name}</span>
                        <span className="vault-search-result-sep">&middot;</span>
                        <span className="vault-search-result-linenum">L{result.line_number}</span>
                        <span className="vault-search-result-sep">&middot;</span>
                        <span className="vault-search-result-path-dim">{result.path}</span>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="vault-search-result-name">
                        {highlightMatch(result.name, searchQuery)}
                      </span>
                      <span className="vault-search-result-path">{result.path}</span>
                    </>
                  )}
                </div>
              ))}
              {searchQuery && searchResults.length === 0 && (
                <div className="vault-search-empty">No results</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Context menu ── */}
      {ctxMenu && (
        <div className="vault-context-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={(e) => e.stopPropagation()}>
          <div className="vault-context-item" onClick={() => {
            const dir = ctxMenu.entry.is_dir ? ctxMenu.path : (ctxMenu.path.includes("/") ? ctxMenu.path.substring(0, ctxMenu.path.lastIndexOf("/")) : "");
            const colIdx = ctxMenu.entry.is_dir ? ctxMenu.colIndex + 1 : ctxMenu.colIndex;
            openModal({ kind: "create-file", dir, colIndex: Math.min(colIdx, columns.length - 1) });
            setCtxMenu(null);
          }}>New file here</div>
          <div className="vault-context-item" onClick={() => {
            const dir = ctxMenu.entry.is_dir ? ctxMenu.path : (ctxMenu.path.includes("/") ? ctxMenu.path.substring(0, ctxMenu.path.lastIndexOf("/")) : "");
            const colIdx = ctxMenu.entry.is_dir ? ctxMenu.colIndex + 1 : ctxMenu.colIndex;
            openModal({ kind: "create-dir", dir, colIndex: Math.min(colIdx, columns.length - 1) });
            setCtxMenu(null);
          }}>New folder here</div>
          <div className="vault-context-separator" />
          <div className="vault-context-item" onClick={() => {
            openModal({ kind: "rename", path: ctxMenu.path, name: ctxMenu.entry.name, is_dir: ctxMenu.entry.is_dir, colIndex: ctxMenu.colIndex });
            setCtxMenu(null);
          }}>Rename</div>
          <div className="vault-context-item" onClick={() => {
            handleCopy(ctxMenu.path, ctxMenu.colIndex);
            setCtxMenu(null);
          }}>Duplicate</div>
          <div className="vault-context-item" onClick={() => {
            openMoveModal(ctxMenu.path, ctxMenu.entry.name);
            setCtxMenu(null);
          }}>Move to...</div>
          <div className="vault-context-separator" />
          <div className="vault-context-item vault-context-item-danger" onClick={() => {
            openModal({ kind: "delete", path: ctxMenu.path, name: ctxMenu.entry.name, is_dir: ctxMenu.entry.is_dir, colIndex: ctxMenu.colIndex });
            setCtxMenu(null);
          }}>Delete</div>
        </div>
      )}

      {/* ── Move modal ── */}
      {moveSource && (
        <div className="vault-modal-overlay" onClick={() => setMoveSource(null)}>
          <div className="vault-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="vault-modal-title">Move "{moveSource.name}"</h3>
            <div className="vault-move-browser">
              <div className="vault-move-path">
                {moveBrowsePath || "vault (root)"}
              </div>
              <div className="vault-move-list">
                {moveBrowsePath && (
                  <div
                    className="vault-move-item vault-move-item-up"
                    onClick={() => {
                      const parent = moveBrowsePath.includes("/")
                        ? moveBrowsePath.substring(0, moveBrowsePath.lastIndexOf("/"))
                        : "";
                      moveBrowseNavigate(parent);
                    }}
                  >..</div>
                )}
                {moveBrowseEntries.map((entry) => (
                  <div
                    key={entry.name}
                    className="vault-move-item"
                    onClick={() => moveBrowseNavigate(moveBrowsePath ? `${moveBrowsePath}/${entry.name}` : entry.name)}
                  >
                    <span className="vault-icon-dir">{"\u25B8"}</span> {entry.name}
                  </div>
                ))}
                {moveBrowseEntries.length === 0 && !moveBrowsePath && (
                  <div className="vault-move-empty">No folders</div>
                )}
              </div>
            </div>
            {moveError && <p className="vault-modal-error">{moveError}</p>}
            <div className="vault-modal-actions">
              <button className="vault-modal-btn vault-modal-btn-secondary" onClick={() => setMoveSource(null)}>Cancel</button>
              <button className="vault-modal-btn vault-modal-btn-primary" onClick={handleMoveSubmit}>Move here</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal overlay ── */}
      {modal && (
        <div className="vault-modal-overlay" onClick={() => setModal(null)}>
          <div className="vault-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="vault-modal-title">
              {modal.kind === "create-file" && "New file"}
              {modal.kind === "create-dir" && "New folder"}
              {modal.kind === "rename" && `Rename ${modal.is_dir ? "folder" : "file"}`}
              {modal.kind === "delete" && `Delete ${modal.is_dir ? "folder" : "file"}`}
            </h3>

            {modal.kind !== "delete" ? (
              <input
                className="vault-modal-input"
                autoFocus
                value={modalInput}
                onChange={(e) => setModalInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleModalSubmit(); if (e.key === "Escape") setModal(null); }}
                placeholder={modal.kind === "create-dir" ? "Folder name" : "File name (.md default)"}
              />
            ) : (
              <p className="vault-modal-text">
                Permanently delete <strong>{modal.name}</strong>{modal.is_dir ? " and all its contents" : ""}?
              </p>
            )}

            {modalError && <p className="vault-modal-error">{modalError}</p>}

            <div className="vault-modal-actions">
              <button className="vault-modal-btn vault-modal-btn-secondary" onClick={() => setModal(null)}>
                Cancel
              </button>
              <button
                className={`vault-modal-btn ${modal.kind === "delete" ? "vault-modal-btn-danger" : "vault-modal-btn-primary"}`}
                onClick={handleModalSubmit}
              >
                {modal.kind === "create-file" && "Create"}
                {modal.kind === "create-dir" && "Create"}
                {modal.kind === "rename" && "Rename"}
                {modal.kind === "delete" && "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
