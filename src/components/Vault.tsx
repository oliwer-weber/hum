import React, { useState, useEffect, useCallback, useRef, memo } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { useEditor, EditorContent } from "@tiptap/react";
import { DndContext, DragOverlay, useDraggable, useDroppable, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { createSharedExtensions } from "./editor-config";
import { WikiLink, WikiEmbed, convertTextToWikiLinks } from "./wikilink";
import type { VaultFileInfo } from "./wikilink";
import { HashTag } from "./hashtag";
import VaultLanding, { type CollectionKey } from "./VaultLanding";
import NotesView from "./NotesView";
import LibraryView from "./LibraryView";
import ProjectsView from "./ProjectsView";
import ProjectHub from "./ProjectHub";
import ProjectNotesView from "./ProjectNotesView";
import ProjectTodos from "./ProjectTodos";

type VaultView =
  | "landing"
  | CollectionKey
  | "project-hub"
  | "project-notes"
  | "project-todos"
  | "editor";

const COLLECTION_PATHS: Record<CollectionKey, string> = {
  projects: "projects",
  library: "wiki",
  notes: "notes",
};

const COLLECTION_LABELS: Record<CollectionKey, string> = {
  projects: "Projects",
  library: "Library",
  notes: "Notes",
};

// Folder name on disk → display label in the breadcrumb.
// The vault still stores under "wiki/" but the UI reads "Library".
const DIR_DISPLAY_LABELS: Record<string, string> = {
  wiki: "Library",
  notes: "Notes",
  projects: "Projects",
};

function collectionForPath(firstSegment: string | undefined): CollectionKey | null {
  if (firstSegment === "wiki") return "library";
  if (firstSegment === "notes") return "notes";
  if (firstSegment === "projects") return "projects";
  return null;
}

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
  openProjectHub?: string | null;
  onOpenProjectHubHandled?: () => void;
  onActiveCollectionChange?: (collection: CollectionKey | null) => void;
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

export default function Vault({ refreshKey, openPath, onOpenPathHandled, openProjectHub, onOpenProjectHubHandled, onActiveCollectionChange }: VaultProps) {
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

  // Move modal state — optional onDone fires after a successful move so card
  // views can refresh their local entries without coupling to columns.
  const [moveSource, setMoveSource] = useState<{ path: string; name: string; onDone?: () => void } | null>(null);
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

  // Breadcrumb sliding pill
  const breadcrumbRef = useRef<HTMLDivElement>(null);
  const [pillStyle, setPillStyle] = useState<React.CSSProperties>({ opacity: 0 });

  // Explorer overlay (summoned miller grid)
  const [explorerOpen, setExplorerOpen] = useState(false);

  // View state — drives the new card-based navigation.
  // 'landing' = L0 cards, 'editor' = file open, collection keys = L1 views.
  const [vaultView, setVaultView] = useState<VaultView>("landing");

  // Library sub-path for drilling into wiki subfolders (e.g. "Linux").
  // Kept here so the main breadcrumb can reflect the drill depth.
  const [libSubPath, setLibSubPath] = useState<string>("");

  // Active project path when in project-hub or project-notes view
  // (e.g. "projects/work/billsta"). Cleared on return to landing.
  const [activeProjectPath, setActiveProjectPath] = useState<string>("");

  // Level-transition state. `navDir` flips to "backward" on breadcrumb
  // clicks so the entering view animates from above instead of below.
  // `editorExiting` keeps the editor mounted while its outbound animation
  // runs; the navigation action only fires after the slide-down completes.
  const [navDir, setNavDir] = useState<"forward" | "backward">("forward");
  const [editorExiting, setEditorExiting] = useState(false);

  // Unified navigation wrapper: sets the nav direction synchronously so the
  // target view mounts with data-nav-dir already on the container, then runs
  // the action. Backward navigations leaving the editor defer the action
  // until the editor's slide-down animation finishes.
  const navigate = useCallback((dir: "forward" | "backward", action: () => void) => {
    if (editorExiting) return;
    setNavDir(dir);
    if (dir === "backward" && vaultView === "editor") {
      setEditorExiting(true);
      window.setTimeout(() => {
        setEditorExiting(false);
        action();
      }, 240);
    } else {
      action();
    }
  }, [vaultView, editorExiting]);

  // Reset any transient overlays/modes on view change so navigation doesn't
  // leave a search panel / find bar / explorer stuck from a previous view.
  useEffect(() => {
    setSearchMode(null);
    setSearchQuery("");
    setFindOpen(false);
    setShowReplace(false);
    setExplorerOpen(false);
    setShowCreateMenu(false);
    setCtxMenu(null);
  }, [vaultView]);

  // Vault file index
  const vaultFilesRef = useRef<VaultFileInfo[]>([]);
  const vaultStemsRef = useRef<Set<string>>(new Set());

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

  // Append to the recents list in localStorage — powers the landing's recent
  // items strip. Kept as a fire-and-forget write; no React state needed.
  const pushRecent = useCallback((path: string, name: string) => {
    try {
      const raw = localStorage.getItem("vault-recents");
      const prev: Array<{ path: string; name: string; openedAt: number }> =
        raw ? (JSON.parse(raw) ?? []) : [];
      const filtered = Array.isArray(prev) ? prev.filter((r) => r.path !== path) : [];
      const next = [{ path, name, openedAt: Date.now() }, ...filtered].slice(0, 30);
      localStorage.setItem("vault-recents", JSON.stringify(next));
    } catch {
      /* quota or bad JSON — safe to ignore */
    }
  }, []);

  const openFileInEditor = useCallback(
    async (path: string, entry: VaultEntry) => {
      try {
        const content = await invoke<string>("vault_read_file", { relativePath: path });
        setOpenFile({ path, entry });
        setImageUrl(null);
        const fm = extractFrontmatter(content);
        const body = fm ? stripFrontmatter(content) : content;
        setFrontmatter(fm);
        setFileContent(body);
        setSaveStatus("");
        if (editorRef.current) {
          (editorRef.current.storage as any).currentFilePath = path;
        }
        if (editorRef.current && entry.extension === "md") {
          loadIntoEditor(editorRef.current, body);
        }
        pushRecent(path, entry.name);
        setVaultView("editor");
      } catch (err) {
        console.error("Failed to open file:", err);
      }
    },
    [loadIntoEditor, pushRecent]
  );

  // Navigate to a wikilink target — resolve via backend recursive search
  const navigateToWikiLink = useCallback(
    async (target: string) => {
      try {
        const contextPath = openFile?.path;
        const resolvedPath = await invoke<string>("vault_resolve_link", { target, contextPath });
        const fileName = resolvedPath.split("/").pop()!;
        const entry: VaultEntry = {
          name: fileName,
          is_dir: false,
          extension: fileName.includes(".") ? fileName.split(".").pop()! : null,
        };
        await openFileInEditor(resolvedPath, entry);
      } catch (err) {
        console.error("WikiLink navigation failed:", err);
      }
    },
    [openFileInEditor]
  );

  // TipTap editor
  const editor = useEditor({
    extensions: createSharedExtensions({
      extraExtensions: [
        WikiLink.configure({
          onNavigate: (target) => navigateToWikiLink(target),
          checkExists: (stem: string) => vaultStemsRef.current.has(stem),
          getVaultFiles: () => vaultFilesRef.current,
        }),
        WikiEmbed,
        HashTag,
      ],
    }),
    editorProps: {
      attributes: { class: "vault-editor-tiptap" },
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
    await openFileInEditor(filePath, entry);
  }, [openFileInEditor]);

  // Navigate to an externally requested file path
  useEffect(() => {
    if (!openPath) return;
    navigateToPath(openPath).then(() => onOpenPathHandled?.());
  }, [openPath, navigateToPath, onOpenPathHandled]);

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

  // Navigate to an externally requested project hub (e.g. the folder icon
  // on the Focus tab). Mirrors goToProjectHub — inlined so the effect only
  // depends on stable identities. Must live below loadDirectory's
  // declaration to avoid a TDZ ReferenceError on the const binding.
  useEffect(() => {
    if (!openProjectHub) return;
    setVaultView("project-hub");
    setActiveProjectPath(openProjectHub);
    setOpenFile(null);
    setImageUrl(null);
    loadDirectory(openProjectHub, 0);
    onOpenProjectHubHandled?.();
  }, [openProjectHub, loadDirectory, onOpenProjectHubHandled]);

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
          setImageUrl(convertFileSrc(fullPath));
        } catch {
          setImageUrl(null);
        }
        pushRecent(entryPath, entry.name);
        setExplorerOpen(false);
        setVaultView("editor");
      } else if (isEditableFile(entry)) {
        await openFileInEditor(entryPath, entry);
        setExplorerOpen(false);
      }
    },
    [columns, loadDirectory, openFileInEditor, pushRecent]
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

  // Open the move modal. Optional onDone fires after a successful move so
  // callers (e.g. card views) can refresh their local entries.
  const openMoveModal = useCallback(async (path: string, name: string, onDone?: () => void) => {
    setMoveSource({ path, name, onDone });
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
      moveSource.onDone?.();
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
      // Escape — close search/find/explorer (lowest-priority overlays first)
      if (e.key === "Escape") {
        if (searchMode) { setSearchMode(null); return; }
        if (findOpen) { setFindOpen(false); return; }
        if (explorerOpen && !modal && !ctxMenu && !moveSource) {
          setExplorerOpen(false);
          return;
        }
      }
      // Ctrl+E — toggle the explorer overlay
      if ((e.ctrlKey || e.metaKey) && e.key === "e" && !e.shiftKey && !e.altKey) {
        const target = e.target as HTMLElement | null;
        const inField = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
        if (!inField) {
          e.preventDefault();
          setExplorerOpen((v) => !v);
          return;
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [searchMode, findOpen, openFile, explorerOpen, modal, ctxMenu, moveSource]);

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

  // Vault-index refresh for card views (which don't have a column to reload).
  const refreshVaultIndex = useCallback(async () => {
    try {
      const files = await invoke<VaultFileInfo[]>("vault_all_files");
      vaultFilesRef.current = files;
      vaultStemsRef.current = new Set(files.map((f) => f.stem));
    } catch {
      /* best-effort */
    }
  }, []);

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

  // Position the breadcrumb sliding pill over the active segment
  useEffect(() => {
    const container = breadcrumbRef.current;
    if (!container) return;
    const active = container.querySelector<HTMLElement>(".vault-breadcrumb-active");
    if (!active) { setPillStyle({ opacity: 0 }); return; }
    const containerRect = container.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    setPillStyle({
      opacity: 1,
      top: activeRect.top - containerRect.top,
      left: activeRect.left - containerRect.left + container.scrollLeft,
      width: activeRect.width,
      height: activeRect.height,
    });
  }, [columns.length, columns[columns.length - 1]?.path, vaultView]);

  const isCollectionView =
    vaultView === "notes" ||
    vaultView === "library" ||
    vaultView === "projects" ||
    vaultView === "project-hub" ||
    vaultView === "project-notes" ||
    vaultView === "project-todos";

  // Which collection is currently "active" — drives data-collection on the
  // container so breadcrumb pill, chips, and FAB pick up the right accent.
  const activeCollection: CollectionKey | null = (() => {
    if (vaultView === "notes") return "notes";
    if (vaultView === "library") return "library";
    if (
      vaultView === "projects" ||
      vaultView === "project-hub" ||
      vaultView === "project-notes" ||
      vaultView === "project-todos"
    ) {
      return "projects";
    }
    if (vaultView === "editor" && columns.length > 1) {
      return collectionForPath(columns[1]?.path.split("/")[0]);
    }
    return null;
  })();

  // Hoist the active collection up so App.tsx can color the tab pill to
  // match the user's current location inside the vault.
  useEffect(() => {
    onActiveCollectionChange?.(activeCollection);
  }, [activeCollection, onActiveCollectionChange]);

  const goToLanding = () => {
    loadDirectory("", 0);
    setVaultView("landing");
    setLibSubPath("");
    setActiveProjectPath("");
    setOpenFile(null);
    setImageUrl(null);
  };

  const goToCollection = (key: CollectionKey, subPath: string = "") => {
    setVaultView(key);
    setLibSubPath(key === "library" ? subPath : "");
    const p = subPath ? `${COLLECTION_PATHS[key]}/${subPath}` : COLLECTION_PATHS[key];
    loadDirectory(p, 0);
    setOpenFile(null);
    setImageUrl(null);
  };

  const goToProjectHub = (projectPath: string) => {
    setVaultView("project-hub");
    setActiveProjectPath(projectPath);
    setOpenFile(null);
    setImageUrl(null);
    loadDirectory(projectPath, 0);
  };

  const goToProjectNotes = (projectPath: string) => {
    setVaultView("project-notes");
    setActiveProjectPath(projectPath);
    setOpenFile(null);
    setImageUrl(null);
    loadDirectory(`${projectPath}/notes`, 0);
  };

  // Route the "Todos" card to the polished ProjectTodos view. Creates the
  // file on first visit so the view has somewhere to write back. The raw-
  // markdown escape hatch lives on the view's overflow menu and calls
  // openProjectTodosRaw below.
  const openProjectTodos = async (projectPath: string) => {
    const todosPath = `${projectPath}/todos.md`;
    try {
      try {
        await invoke<string>("vault_read_file", { relativePath: todosPath });
      } catch {
        await invoke("vault_create_file", { relativePath: todosPath, content: "" });
        refreshVaultIndex();
      }
      setActiveProjectPath(projectPath);
      setOpenFile(null);
      setImageUrl(null);
      setVaultView("project-todos");
    } catch (err) {
      console.error("open todos failed:", err);
    }
  };

  // Raw-markdown fallback for the polished view's overflow menu — opens
  // todos.md directly in the TipTap editor for free-form editing.
  const openProjectTodosRaw = async (projectPath: string) => {
    const todosPath = `${projectPath}/todos.md`;
    try {
      await navigateToPath(todosPath);
    } catch (err) {
      console.error("open raw todos failed:", err);
    }
  };

  // Build breadcrumb segments based on the current view.
  type BreadcrumbSegment = { label: string; active?: boolean; onClick?: () => void };
  const segments: BreadcrumbSegment[] = [];

  if (vaultView === "editor" && columns.length > 0) {
    // Columns-derived breadcrumb for editor view, with display-label swap for
    // top-level collection dirs (wiki → Library, etc.).
    columns.forEach((col, i) => {
      if (i === 0) {
        segments.push({ label: "Find", onClick: goToLanding });
        return;
      }
      const parts = col.path.split("/");
      const topSeg = parts[0];
      const rawName = parts[parts.length - 1];
      const collection = collectionForPath(topSeg);
      const label = i === 1 && DIR_DISPLAY_LABELS[topSeg] ? DIR_DISPLAY_LABELS[topSeg] : rawName;

      let onClick: (() => void) | undefined;
      if (collection === "library") {
        const sub = parts.slice(1).join("/");
        onClick = () => goToCollection("library", sub);
      } else if (collection === "projects") {
        // projects hierarchy: [0]=projects, [1]=scope, [2]=project-name, [3]=notes
        if (i === 1 || i === 2) {
          onClick = () => goToCollection("projects");
        } else if (i === 3) {
          onClick = () => goToProjectHub(col.path);
        } else if (i === 4 && parts[3] === "notes") {
          const projPath = parts.slice(0, 3).join("/");
          onClick = () => goToProjectNotes(projPath);
        } else {
          onClick = () => {
            loadDirectory(col.path, i);
            setOpenFile(null);
          };
        }
      } else if (collection && i === 1) {
        onClick = () => goToCollection(collection);
      } else {
        onClick = () => {
          loadDirectory(col.path, i);
          setOpenFile(null);
        };
      }

      segments.push({
        label,
        active: i === columns.length - 1 && !openFile,
        onClick,
      });
    });
    if (openFile) {
      segments.push({
        label: openFile.entry.name.replace(/\.md$/i, ""),
        active: true,
      });
    }
  } else if (isCollectionView) {
    segments.push({ label: "Find", onClick: goToLanding });
    if (
      vaultView === "project-hub" ||
      vaultView === "project-notes" ||
      vaultView === "project-todos"
    ) {
      segments.push({ label: "Projects", onClick: () => goToCollection("projects") });
      const projectName = activeProjectPath.split("/").pop() || "Project";
      if (vaultView === "project-hub") {
        segments.push({ label: projectName, active: true });
      } else {
        segments.push({
          label: projectName,
          onClick: () => goToProjectHub(activeProjectPath),
        });
        segments.push({
          label: vaultView === "project-notes" ? "Notes" : "Todos",
          active: true,
        });
      }
    } else {
      const key = vaultView as CollectionKey;
      const drilled = key === "library" && !!libSubPath;
      segments.push({
        label: COLLECTION_LABELS[key],
        active: !drilled,
        onClick: drilled ? () => goToCollection(key, "") : undefined,
      });
      if (drilled) {
        const parts = libSubPath.split("/");
        parts.forEach((part, i) => {
          const isLast = i === parts.length - 1;
          const target = parts.slice(0, i + 1).join("/");
          segments.push({
            label: part,
            active: isLast,
            onClick: isLast ? undefined : () => setLibSubPath(target),
          });
        });
      }
    }
  }

  return (
    <div
      className="vault-container"
      data-collection={activeCollection ?? undefined}
      data-nav-dir={navDir}
    >
      {vaultView === "landing" ? (
        <VaultLanding
          refreshKey={refreshKey}
          onOpenCollection={(key) => navigate("forward", () => {
            setVaultView(key);
            loadDirectory(COLLECTION_PATHS[key], 0);
          })}
          onOpenPath={(p) => navigate("forward", () => navigateToPath(p))}
        />
      ) : (
        <>
      {/* Unified nav bar — spans full width */}
      <div className="vault-breadcrumb" ref={breadcrumbRef}>
        <div className="vault-breadcrumb-pill" style={pillStyle} />
        {segments.map((seg, i) => (
          <span key={i}>
            {i > 0 && <span className="vault-breadcrumb-sep">/</span>}
            <span
              className={`vault-breadcrumb-part ${seg.active ? "vault-breadcrumb-active" : ""}`}
              onClick={seg.onClick ? () => navigate("backward", seg.onClick!) : undefined}
            >
              {seg.label}
            </span>
          </span>
        ))}
        <div className="vault-breadcrumb-actions">
          {saveStatus === "saved" && <span className="vault-editor-saved">saved</span>}
          {saveStatus === "error" && <span className="vault-editor-error">save failed</span>}
          <button
            ref={createBtnRef}
            className="vault-create-btn"
            onClick={(e) => { e.stopPropagation(); setShowCreateMenu((v) => !v); }}
            title="New file or folder"
          >+</button>
        </div>
      </div>

      {vaultView === "notes" ? (
        <NotesView
          refreshKey={refreshKey}
          onOpenPath={(p) => navigate("forward", () => navigateToPath(p))}
          onRequestMove={(path, name, onDone) => openMoveModal(path, name, onDone)}
          onVaultChanged={refreshVaultIndex}
        />
      ) : vaultView === "library" ? (
        <LibraryView
          refreshKey={refreshKey}
          subPath={libSubPath}
          onSubPathChange={(p) => navigate("forward", () => setLibSubPath(p))}
          onOpenPath={(p) => navigate("forward", () => navigateToPath(p))}
          onRequestMove={(path, name, onDone) => openMoveModal(path, name, onDone)}
          onVaultChanged={refreshVaultIndex}
        />
      ) : vaultView === "projects" ? (
        <ProjectsView
          refreshKey={refreshKey}
          onOpenProject={(p) => navigate("forward", () => goToProjectHub(p))}
          onRequestMove={(path, name, onDone) => openMoveModal(path, name, onDone)}
          onVaultChanged={refreshVaultIndex}
        />
      ) : vaultView === "project-hub" ? (
        <ProjectHub
          refreshKey={refreshKey}
          projectPath={activeProjectPath}
          onOpenNotes={() => navigate("forward", () => goToProjectNotes(activeProjectPath))}
          onOpenTodos={() => navigate("forward", () => openProjectTodos(activeProjectPath))}
        />
      ) : vaultView === "project-notes" ? (
        <ProjectNotesView
          refreshKey={refreshKey}
          projectPath={activeProjectPath}
          onOpenPath={(p) => navigate("forward", () => navigateToPath(p))}
          onRequestMove={(path, name, onDone) => openMoveModal(path, name, onDone)}
          onVaultChanged={refreshVaultIndex}
        />
      ) : vaultView === "project-todos" ? (
        <ProjectTodos
          refreshKey={refreshKey}
          projectPath={activeProjectPath}
          onBack={() => navigate("backward", () => goToProjectHub(activeProjectPath))}
          onOpenRaw={() => navigate("forward", () => openProjectTodosRaw(activeProjectPath))}
        />
      ) : (
      <div
        className="vault-editor"
        data-exiting={editorExiting ? "true" : undefined}
      >

        {!openFile && (
          <div className="vault-editor-hero">
            <div className="vault-editor-hero-title">Find</div>
            <div className="vault-editor-hero-hint">
              <kbd>Ctrl+P</kbd> to find a note · <kbd>Ctrl+E</kbd> to explore
            </div>
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
      )}
        </>
      )}

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

      {/* ── Explorer overlay (summoned miller grid) ── */}
      {explorerOpen && (
        <div className="vault-explorer-overlay" onClick={() => setExplorerOpen(false)}>
          <div className="vault-explorer-panel" onClick={(e) => e.stopPropagation()}>
            <div className="vault-explorer-header">
              <span className="vault-explorer-title">Explore</span>
              <span className="vault-explorer-path">{currentDir || "find"}</span>
              <button
                className="vault-explorer-close"
                onClick={() => setExplorerOpen(false)}
                title="Close (Esc)"
                aria-label="Close explorer"
              >{"\u00D7"}</button>
            </div>
            <div className="vault-browser">
              <DndContext sensors={dndSensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
                <div className="vault-columns">
                  {visibleColumns.map((col, vi) => {
                    const realIndex = vi + columnOffset;
                    return (
                      <DroppableColumn key={col.path || "."} id={`drop:${col.path || "."}`} className="vault-column">
                        {col.entries.map((entry, ei) => {
                          const entryPath = col.path ? `${col.path}/${entry.name}` : entry.name;
                          const prevEntry = ei > 0 ? col.entries[ei - 1] : null;
                          const showSeparator = !entry.is_dir && prevEntry?.is_dir;
                          const lastDot = entry.name.lastIndexOf(".");
                          const baseName = !entry.is_dir && lastDot > 0 ? entry.name.slice(0, lastDot) : entry.name;
                          const ext = !entry.is_dir && lastDot > 0 ? entry.name.slice(lastDot) : "";
                          const entryContent = (
                            <div
                              className={`vault-entry ${col.selected === entry.name ? "vault-entry-selected" : ""} ${entry.is_dir ? "vault-entry-dir" : ""}`}
                              onClick={() => handleEntryClick(realIndex, entry)}
                              onContextMenu={(e) => handleContextMenu(e, entryPath, entry, realIndex)}
                            >
                              <span className={`vault-entry-icon ${iconClass(entry)}`}>
                                {fileIcon(entry)}
                              </span>
                              <span className="vault-entry-name">
                                {baseName}{ext && <span className="vault-entry-ext">{ext}</span>}
                              </span>
                              {entry.is_dir && <span className="vault-entry-chevron">&#x276F;</span>}
                            </div>
                          );
                          const wrapped = entry.is_dir ? (
                            <DraggableEntry key={entry.name} id={`drag:${entryPath}`}>
                              <DroppableDir id={`drop:${entryPath}`}>
                                {entryContent}
                              </DroppableDir>
                            </DraggableEntry>
                          ) : (
                            <DraggableEntry key={entry.name} id={`drag:${entryPath}`}>
                              {entryContent}
                            </DraggableEntry>
                          );
                          return showSeparator ? (
                            <React.Fragment key={entry.name}>
                              <div className="vault-entry-separator" />
                              {wrapped}
                            </React.Fragment>
                          ) : wrapped;
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
          </div>
        </div>
      )}

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
