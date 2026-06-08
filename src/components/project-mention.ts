import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/core";

/**
 * Project autocomplete for the Inbox editor.
 *
 * Watches the editor for "@" at line start, shows a dropdown of projects,
 * notes, and wiki files. Two modes:
 *
 * 1. Projects mode (default) — picking a project creates a new per-capture
 *    note inside it on inbox processing.
 * 2. Notes mode (drilled) — entered via right-arrow on a project row or by
 *    typing `/` after a recognized project name. Lists existing notes in
 *    that project; picking one switches routing to "append to this note".
 *    The stored mention is `@Project/Note Title`, parsed by the Rust
 *    inbox processor.
 *
 * - `attachProjectAutocomplete(editor, getMentionables, opts)` — hooks into
 *   editor transactions to detect @mentions and manage the popup lifecycle.
 *   `opts.listProjectNotes` is invoked when the popup needs to drill in.
 * - `ProjectMentionKeymap` — TipTap Extension registering a ProseMirror
 *   plugin for keyboard handling (arrow nav, Tab/Enter confirm, drill in/out,
 *   Escape).
 */

/* ── Types ────────────────────────────────────────── */

export interface ProjectItem {
  name: string;
  path: string;
}

export type MentionKind = "project" | "note" | "wiki";

export type CreateKind = "work-project" | "personal-project" | "wiki" | "note";

export interface MentionableItem {
  name: string;
  path: string;
  kind: MentionKind;
  has_notes?: boolean;     // projects only — drives the drill-in chevron
}

export interface NoteRow {
  path: string;            // relative vault path of the note
  title: string;           // cleaned display title (markdown stripped)
}

type RenderItem =
  | { kind: "mention"; item: MentionableItem; isDefault: boolean }
  | { kind: "create"; createKind: CreateKind; createName: string; isDefault: boolean }
  | { kind: "note"; note: NoteRow; isDefault: boolean }
  | { kind: "note-empty"; isDefault: false }
  | { kind: "note-loading"; isDefault: false };

/* ── Fuzzy filter ─────────────────────────────────── */

// Normalize the same way the Rust resolver does: strip all non-alphanumeric
// and lowercase. `song-tips`, `Song Tips`, `song_tips`, `songtips` all collapse
// to `songtips`.
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function fuzzyMatch(query: string, name: string): boolean {
  const q = normalize(query);
  if (!q) return true;
  const n = normalize(name);
  return n.includes(q);
}

function hasAnyMatch(query: string, items: MentionableItem[]): boolean {
  const q = normalize(query);
  if (!q) return false;
  return items.some((it) => fuzzyMatch(query, it.name));
}

/* ── Popup DOM ────────────────────────────────────── */

let popup: HTMLElement | null = null;
let popupBody: HTMLElement | null = null;
let popupHeader: HTMLElement | null = null;
let popupFooter: HTMLElement | null = null;
let items: RenderItem[] = [];
let selectedIndex = 0;
let onSelect: ((item: RenderItem) => void) | null = null;
let onArrowRight: (() => void) | null = null;
let onArrowLeft: (() => void) | null = null;
let editorRef: Editor | null = null;
let usingKeyboard = false; // suppress mouseenter during keyboard nav
let popupMode: "projects" | "notes" = "projects";
let drilledProject: MentionableItem | null = null;

// Shared mentionables accessor. Set by `attachProjectAutocomplete` so the
// decoration plugin (`ProjectTagStyle`) can classify @tags at render time.
let mentionablesGetter: (() => MentionableItem[]) | null = null;

/** Resolve an @tag to its kind (work/personal/note/wiki/append), or "pending". */
function resolveTagKind(tag: string): "work" | "personal" | "note" | "wiki" | "pending" {
  if (!mentionablesGetter) return "pending";
  // `Project/Note Title` — classify by the project (left side).
  const slashIdx = tag.indexOf("/");
  const lookup = slashIdx >= 0 ? tag.slice(0, slashIdx) : tag;
  const norm = normalize(lookup);
  if (!norm) return "pending";
  const match = mentionablesGetter().find((it) => normalize(it.name) === norm);
  if (!match) return "pending";
  if (match.kind === "project") {
    const scope = match.path.split("/")[1];
    return scope === "personal" ? "personal" : "work";
  }
  return match.kind;
}

function renderPopup() {
  if (!popup || !popupBody || !popupHeader || !popupFooter) return;
  popupBody.innerHTML = "";
  popupHeader.innerHTML = "";
  popupFooter.innerHTML = "";

  // Header — only in notes mode, shows what we're drilling into.
  if (popupMode === "notes" && drilledProject) {
    popupHeader.style.display = "";
    const label = document.createElement("span");
    label.className = "pm-suggest-header-label";
    label.textContent = "Appending to";
    popupHeader.appendChild(label);

    const chip = document.createElement("span");
    chip.className = "pm-suggest-header-chip";
    chip.setAttribute("data-mention-kind", displayKindOf(drilledProject));
    chip.textContent = drilledProject.name;
    popupHeader.appendChild(chip);
  } else {
    popupHeader.style.display = "none";
  }

  // Body — items list or empty state.
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pm-suggest-empty";
    empty.textContent = popupMode === "notes"
      ? "No notes here yet"
      : "Type a name...";
    popupBody.appendChild(empty);
  } else {
    items.forEach((item, i) => {
      const row = document.createElement("div");
      const baseClass = "pm-suggest-item" +
        (i === selectedIndex ? " pm-suggest-selected" : "");
      const kindClass = renderItemRow(item, row);
      row.className = baseClass + kindClass;

      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        onSelect?.(item);
      });
      row.addEventListener("mouseenter", () => {
        if (usingKeyboard || selectedIndex === i) return;
        popupBody?.querySelectorAll(".pm-suggest-item").forEach((el, j) => {
          el.classList.toggle("pm-suggest-selected", j === i);
        });
        selectedIndex = i;
      });
      popupBody!.appendChild(row);
    });
  }

  // Footer — affordance hint, changes per mode and per-selected-row.
  renderFooter();

  scrollToSelected();
}

/** Populate the row element for one RenderItem. Returns extra class suffix. */
function renderItemRow(item: RenderItem, row: HTMLElement): string {
  let extra = "";

  if (item.kind === "mention") {
    row.setAttribute("data-mention-kind", displayKindOf(item.item));

    const name = document.createElement("span");
    name.className = "pm-suggest-name";
    name.textContent = item.item.name;
    row.appendChild(name);

    const label = document.createElement("span");
    label.className = "pm-suggest-path";
    label.textContent = mentionLabel(item.item);
    row.appendChild(label);

    // Chevron only on projects that have notes — passive advertisement of
    // the drill-in affordance.
    if (item.item.kind === "project" && item.item.has_notes) {
      const chev = document.createElement("span");
      chev.className = "pm-suggest-chevron";
      chev.textContent = "›";
      row.appendChild(chev);
      extra += " pm-suggest-item-drillable";
    }
  } else if (item.kind === "create") {
    extra += " pm-suggest-create";
    row.setAttribute("data-mention-kind", createKindTokenOf(item.createKind));

    const name = document.createElement("span");
    name.className = "pm-suggest-name";
    name.textContent = `${createKindLabel(item.createKind)} "${item.createName}"`;
    row.appendChild(name);
  } else if (item.kind === "note") {
    row.setAttribute("data-mention-kind", drilledProject ? displayKindOf(drilledProject) : "note");

    const name = document.createElement("span");
    name.className = "pm-suggest-name";
    name.textContent = item.note.title || "(untitled)";
    row.appendChild(name);
  } else if (item.kind === "note-loading") {
    extra += " pm-suggest-state";
    const txt = document.createElement("span");
    txt.className = "pm-suggest-name pm-suggest-state-text";
    txt.textContent = "Loading notes...";
    row.appendChild(txt);
  } else if (item.kind === "note-empty") {
    extra += " pm-suggest-state";
    const txt = document.createElement("span");
    txt.className = "pm-suggest-name pm-suggest-state-text";
    txt.textContent = "No notes in this project yet";
    row.appendChild(txt);
  }

  return extra;
}

function renderFooter() {
  if (!popupFooter) return;
  popupFooter.innerHTML = "";

  const selectedRow = items[selectedIndex];
  let html: string;
  if (popupMode === "notes") {
    html = `<span><kbd>↵</kbd> append here</span><span><kbd>←</kbd> back</span><span><kbd>esc</kbd> cancel</span>`;
  } else if (selectedRow?.kind === "mention" && selectedRow.item.kind === "project" && selectedRow.item.has_notes) {
    html = `<span><kbd>↵</kbd> new note</span><span><kbd>→</kbd> append to existing</span><span><kbd>esc</kbd> cancel</span>`;
  } else {
    html = `<span><kbd>↵</kbd> accept</span><span><kbd>esc</kbd> cancel</span>`;
  }
  popupFooter.innerHTML = html;
}

function scrollToSelected() {
  if (!popupBody) return;
  const sel = popupBody.querySelector(".pm-suggest-selected") as HTMLElement;
  if (!sel) return;
  const bodyRect = popupBody.getBoundingClientRect();
  const selRect = sel.getBoundingClientRect();
  const pad = 8;
  if (selRect.bottom > bodyRect.bottom - pad) {
    popupBody.scrollTop += selRect.bottom - bodyRect.bottom + pad;
  } else if (selRect.top < bodyRect.top + pad) {
    popupBody.scrollTop -= bodyRect.top - selRect.top + pad;
  }
}

function ensurePopup(): HTMLElement {
  if (popup) return popup;
  popup = document.createElement("div");
  popup.className = "pm-suggest";

  popupHeader = document.createElement("div");
  popupHeader.className = "pm-suggest-header";
  popupHeader.style.display = "none";
  popup.appendChild(popupHeader);

  popupBody = document.createElement("div");
  popupBody.className = "pm-suggest-body";
  popup.appendChild(popupBody);

  popupFooter = document.createElement("div");
  popupFooter.className = "pm-suggest-footer";
  popup.appendChild(popupFooter);

  // Mouse wheel scrolling (since body is overflow:hidden)
  popup.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (popupBody) popupBody.scrollTop += e.deltaY;
  }, { passive: false });
  popup.addEventListener("mousedown", (e) => e.preventDefault());
  popup.addEventListener("mouseenter", () => {
    editorRef?.view.focus();
  });
  popup.addEventListener("mousemove", () => {
    usingKeyboard = false;
  });
  document.body.appendChild(popup);
  return popup;
}

interface ShowOptions {
  mode: "projects" | "notes";
  drilled: MentionableItem | null;
  rect: DOMRect;
  renderItems: RenderItem[];
  onSelect: (item: RenderItem) => void;
  onArrowRight?: () => void;
  onArrowLeft?: () => void;
}

function showPopup(opts: ShowOptions) {
  const el = ensurePopup();

  // Only reset selection when the item list actually changes, OR when the
  // mode flips (projects ↔ notes) — same path could otherwise stay selected
  // across modes and feel sticky.
  const modeChanged = popupMode !== opts.mode;
  const changed = modeChanged || opts.renderItems.length !== items.length ||
    opts.renderItems.some((r, i) => {
      const prev = items[i];
      if (!prev || r.kind !== prev.kind) return true;
      switch (r.kind) {
        case "mention": return r.item.path !== (prev as typeof r).item.path;
        case "create":  return r.createKind !== (prev as typeof r).createKind || r.createName !== (prev as typeof r).createName;
        case "note":    return r.note.path !== (prev as typeof r).note.path;
        default: return false;
      }
    });

  popupMode = opts.mode;
  drilledProject = opts.drilled;
  items = opts.renderItems;

  if (changed) {
    const defaultIdx = opts.renderItems.findIndex((r) => "isDefault" in r && r.isDefault);
    selectedIndex = defaultIdx >= 0 ? defaultIdx : 0;
  }
  if (selectedIndex >= items.length) selectedIndex = Math.max(0, items.length - 1);

  onSelect = opts.onSelect;
  onArrowRight = opts.onArrowRight ?? null;
  onArrowLeft = opts.onArrowLeft ?? null;

  el.style.left = `${opts.rect.left}px`;
  el.style.display = "";
  renderPopup();

  const popupHeight = el.offsetHeight || 280;
  if (opts.rect.bottom + 6 + popupHeight > window.innerHeight) {
    el.style.top = `${opts.rect.top - popupHeight - 6}px`;
  } else {
    el.style.top = `${opts.rect.bottom + 6}px`;
  }
}

function hidePopup() {
  if (popup) {
    popup.remove();
    popup = null;
    popupBody = null;
    popupHeader = null;
    popupFooter = null;
  }
  items = [];
  selectedIndex = 0;
  onSelect = null;
  onArrowRight = null;
  onArrowLeft = null;
  popupMode = "projects";
  drilledProject = null;
}

/* ── Detect @query in editor ──────────────────────── */

interface MentionMatch {
  query: string;   // text after "@"
  from: number;    // doc position of "@"
  to: number;      // doc position of end of query
}

function detectMention(editor: Editor): MentionMatch | null {
  const { state } = editor;
  const { from } = state.selection;
  const $from = state.doc.resolve(from);

  const textBefore = $from.parent.textBetween(0, $from.parentOffset);

  // Mention lives on its own line. Spaces and slashes inside the query are
  // allowed — the mention ends on Enter (which splits the block) or Escape.
  const match = textBefore.match(/^(\s*)@(.*)$/);
  if (!match) return null;

  const whitespace = match[1];
  const query = match[2];
  const blockStart = from - $from.parentOffset;
  const atPos = blockStart + whitespace.length;

  return {
    query,
    from: atPos,
    to: from,
  };
}

/** Detect whether the query targets a specific project's note (`Project/...`).
 * The lhs must uniquely identify a project — exact normalized match, or a
 * single fuzzy hit. This makes typed-slash drill-in feel deterministic. */
function detectDrilledProject(
  query: string,
  mentionables: MentionableItem[],
): { project: MentionableItem; noteFilter: string } | null {
  const slashIdx = query.indexOf("/");
  if (slashIdx < 0) return null;
  const lhs = query.slice(0, slashIdx);
  const rhs = query.slice(slashIdx + 1);
  const lhsNorm = normalize(lhs);
  if (!lhsNorm) return null;

  const projects = mentionables.filter((m) => m.kind === "project");
  const exact = projects.find((p) => normalize(p.name) === lhsNorm);
  if (exact) return { project: exact, noteFilter: rhs };

  const fuzzy = projects.filter((p) => fuzzyMatch(lhs, p.name));
  if (fuzzy.length === 1) return { project: fuzzy[0], noteFilter: rhs };

  return null;
}

/* ── Build filtered items list ────────────────────── */

/** Resolve a mentionable to the same 4-kind space used by the styling tokens. */
function displayKindOf(item: MentionableItem): "work" | "personal" | "note" | "wiki" {
  if (item.kind === "project") {
    const scope = item.path.split("/")[1];
    return scope === "personal" ? "personal" : "work";
  }
  return item.kind;
}

/** Right-aligned label shown in each popup row. */
function mentionLabel(item: MentionableItem): string {
  return displayKindOf(item);
}

/** Human-readable prefix shown in the zero-match create rows. */
function createKindLabel(kind: CreateKind): string {
  switch (kind) {
    case "work-project": return "Create work project";
    case "personal-project": return "Create personal project";
    case "wiki": return "Create wiki entry";
    case "note": return "Create new note";
  }
}

/** Token used for data-mention-kind on create rows — drives pill coloring. */
function createKindTokenOf(kind: CreateKind): string {
  switch (kind) {
    case "work-project": return "work";
    case "personal-project": return "personal";
    case "wiki": return "wiki";
    case "note": return "note";
  }
}

// Sort order within the popup: existing items (projects > notes > wiki) first,
// alphabetical within each kind.
const KIND_ORDER: Record<MentionKind, number> = { project: 0, note: 1, wiki: 2 };
function compareItems(a: MentionableItem, b: MentionableItem): number {
  const k = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (k !== 0) return k;
  return a.name.localeCompare(b.name);
}

function buildProjectItems(query: string, items: MentionableItem[]): RenderItem[] {
  const q = query.trim();

  if (!q) {
    return items.slice().sort(compareItems).slice(0, 12).map((it) => ({
      kind: "mention" as const,
      item: it,
      isDefault: false,
    }));
  }

  if (hasAnyMatch(q, items)) {
    return items
      .filter((it) => fuzzyMatch(q, it.name))
      .sort(compareItems)
      .slice(0, 10)
      .map((it) => ({
        kind: "mention" as const,
        item: it,
        isDefault: false,
      }));
  }

  const createKinds: CreateKind[] = ["work-project", "personal-project", "wiki", "note"];
  return createKinds.map((kind) => ({
    kind: "create" as const,
    createKind: kind,
    createName: q,
    isDefault: kind === "note",
  }));
}

function buildNoteItems(notes: NoteRow[], filter: string): RenderItem[] {
  const q = filter.trim();
  const filtered = q
    ? notes.filter((n) => fuzzyMatch(q, n.title))
    : notes;
  return filtered.slice(0, 12).map((note, i) => ({
    kind: "note" as const,
    note,
    isDefault: i === 0,
  }));
}

/* ── Get cursor coordinates for popup positioning ─── */

function getCursorRect(editor: Editor): DOMRect | null {
  const { view } = editor;
  const { from } = view.state.selection;
  try {
    const coords = view.coordsAtPos(from);
    return new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top);
  } catch {
    return null;
  }
}

/* ── Main attach function ─────────────────────────── */

export interface AutocompleteOptions {
  onCreate?: (kind: CreateKind, name: string) => Promise<void>;
  listProjectNotes?: (projectPath: string) => Promise<NoteRow[]>;
}

export function attachProjectAutocomplete(
  editor: Editor,
  getMentionables: () => MentionableItem[],
  opts: AutocompleteOptions = {},
): () => void {
  editorRef = editor;
  mentionablesGetter = getMentionables;
  let active = false;
  let currentMatch: MentionMatch | null = null;
  let committing = false;

  // Per-project notes cache. Keyed by project relative path. Populated on
  // first drill-in for that project and reused for subsequent typing.
  const notesCache = new Map<string, NoteRow[]>();
  const notesInFlight = new Set<string>();

  function getCachedOrFetch(projectPath: string): NoteRow[] | "loading" {
    const cached = notesCache.get(projectPath);
    if (cached) return cached;
    if (notesInFlight.has(projectPath)) return "loading";
    if (!opts.listProjectNotes) return [];
    notesInFlight.add(projectPath);
    opts.listProjectNotes(projectPath).then((rows) => {
      notesCache.set(projectPath, rows);
      notesInFlight.delete(projectPath);
      // Re-run update so popup picks up loaded notes if still relevant.
      update();
    }).catch((err) => {
      console.error("listProjectNotes failed:", err);
      notesCache.set(projectPath, []);
      notesInFlight.delete(projectPath);
      update();
    });
    return "loading";
  }

  function insertMention(name: string, from: number, to: number) {
    editor.chain().focus().command(({ tr, dispatch }) => {
      if (!dispatch) return false;
      const tagText = `@${name}`;
      tr.replaceWith(from, to, editor.state.schema.text(tagText));
      tr.split(from + tagText.length);
      return true;
    }).run();
  }

  /** Rewrite the @{anything} mention text in place without splitting. Used to
   * transition into/out of drill mode by editing the query, after which
   * `update()` re-detects and refreshes the popup. */
  function rewriteQuery(newQuery: string) {
    if (!currentMatch) return;
    const { from, to } = currentMatch;
    editor.chain().focus().command(({ tr, dispatch }) => {
      if (!dispatch) return false;
      const text = `@${newQuery}`;
      tr.replaceWith(from, to, editor.state.schema.text(text));
      const end = from + text.length;
      tr.setSelection(TextSelection.create(tr.doc, end));
      return true;
    }).run();
  }

  async function confirmSelection(item: RenderItem) {
    if (!currentMatch || committing) return;
    const { from, to } = currentMatch;

    if (item.kind === "create") {
      committing = true;
      try {
        if (opts.onCreate) {
          await opts.onCreate(item.createKind, item.createName);
        }
      } catch (err) {
        console.error("create mention failed:", err);
        committing = false;
        return;
      }
      committing = false;
      insertMention(item.createName, from, to);
    } else if (item.kind === "mention") {
      insertMention(item.item.name, from, to);
    } else if (item.kind === "note" && drilledProject) {
      insertMention(`${drilledProject.name}/${item.note.title}`, from, to);
    } else {
      return;
    }

    hidePopup();
    active = false;
    currentMatch = null;
  }

  /** Right-arrow on a project row with notes → rewrite query to `Project/`
   * so the typed-slash code path takes over. Keeps a single source of truth
   * (the editor text) instead of carrying parallel UI state. */
  function arrowRight() {
    const sel = items[selectedIndex];
    if (!sel || sel.kind !== "mention") return;
    if (sel.item.kind !== "project" || !sel.item.has_notes) return;
    rewriteQuery(`${sel.item.name}/`);
  }

  /** Left-arrow / back from notes mode → strip the `/...` portion of the
   * query so we revert to projects mode. */
  function arrowLeft() {
    if (!drilledProject) return;
    rewriteQuery(drilledProject.name);
  }

  function update(props?: { transaction?: Transaction }) {
    // Selection-only transactions (arrow keys, click) report docChanged=false.
    // Direct calls (e.g. notes finished loading) pass nothing → treat as a
    // change so the popup refreshes.
    const docChanged = props?.transaction?.docChanged ?? true;
    const mention = detectMention(editor);

    if (!mention) {
      if (active) {
        hidePopup();
        active = false;
        currentMatch = null;
      }
      return;
    }

    // Only auto-open as a result of typing. A pure caret move onto an existing
    // @mention must not summon the popup — otherwise it captures Up/Down and
    // traps the caret on the mention line. If the popup is already showing
    // (mid-composition) we still refresh on selection moves. Keying off `popup`
    // rather than `active` means "Escape then arrow" won't re-summon it.
    if (!docChanged && !popup) {
      return;
    }

    currentMatch = mention;
    const mentionables = getMentionables();
    const rect = getCursorRect(editor);

    if (!rect) {
      hidePopup();
      active = false;
      return;
    }

    const drilled = detectDrilledProject(mention.query, mentionables);

    if (drilled) {
      const cached = getCachedOrFetch(drilled.project.path);
      let renderItems: RenderItem[];
      if (cached === "loading") {
        renderItems = [{ kind: "note-loading", isDefault: false }];
      } else if (cached.length === 0) {
        renderItems = [{ kind: "note-empty", isDefault: false }];
      } else {
        renderItems = buildNoteItems(cached, drilled.noteFilter);
        if (renderItems.length === 0) {
          renderItems = [{ kind: "note-empty", isDefault: false }];
        }
      }
      active = true;
      showPopup({
        mode: "notes",
        drilled: drilled.project,
        rect,
        renderItems,
        onSelect: confirmSelection,
        onArrowLeft: arrowLeft,
      });
      return;
    }

    const renderItems = buildProjectItems(mention.query, mentionables);
    active = true;
    showPopup({
      mode: "projects",
      drilled: null,
      rect,
      renderItems,
      onSelect: confirmSelection,
      onArrowRight: arrowRight,
    });
  }

  editor.on("transaction", update);

  return () => {
    editor.off("transaction", update);
    editorRef = null;
    mentionablesGetter = null;
    hidePopup();
  };
}

/**
 * TipTap Extension that registers a ProseMirror plugin for popup keyboard
 * handling. Plugin priority — same level as TipTap's Suggestion plugin used
 * by wikilinks. ArrowRight/ArrowLeft are mode-aware (drill in/out); only
 * intercepted when they would do something, otherwise pass through so the
 * cursor moves normally.
 */
const pmPluginKey = new PluginKey("projectMentionKeyHandler");

export const ProjectMentionKeymap = Extension.create({
  name: "projectMentionKeymap",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: pmPluginKey,
        props: {
          handleKeyDown(_view, event) {
            if (!popup || items.length === 0) return false;

            if (event.key === "ArrowDown") {
              usingKeyboard = true;
              selectedIndex = (selectedIndex + 1) % Math.max(1, items.length);
              renderPopup();
              return true;
            }
            if (event.key === "ArrowUp") {
              usingKeyboard = true;
              selectedIndex = (selectedIndex - 1 + items.length) % Math.max(1, items.length);
              renderPopup();
              return true;
            }
            if (event.key === "ArrowRight" && onArrowRight) {
              // Only intercept when current selection is drillable; otherwise
              // let the cursor move.
              const sel = items[selectedIndex];
              if (sel?.kind === "mention" && sel.item.kind === "project" && sel.item.has_notes) {
                usingKeyboard = true;
                onArrowRight();
                return true;
              }
            }
            if (event.key === "ArrowLeft" && onArrowLeft && popupMode === "notes") {
              usingKeyboard = true;
              onArrowLeft();
              return true;
            }
            if (event.key === "Tab" || event.key === "Enter") {
              const item = items[selectedIndex];
              if (item) onSelect?.(item);
              return true;
            }
            if (event.key === "Escape") {
              hidePopup();
              return true;
            }

            return false;
          },
        },
      }),
    ];
  },
});

/* ── Decoration plugin: style confirmed @project tags ── */

/**
 * ProjectTagStyle — Mark extension that decorates @project tags as styled
 * pills. Matches paragraphs whose entire text is an @mention. Display-only;
 * stored markdown is never modified. For `@Project/Note Title` mentions, the
 * `/Note Title` portion gets its own decoration so it renders as a softer
 * companion to the project pill.
 */
export const ProjectTagStyle = Mark.create({
  name: "projectTagStyle",

  parseHTML() {
    return [{ tag: "span.project-mention" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes({ class: "project-mention" }, HTMLAttributes), 0];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (!node.isTextblock) return;
              const text = node.textContent;
              if (!text.startsWith("@") || text.length < 2) return;
              const trimmed = text.trimEnd();
              if (trimmed.includes("\n")) return;
              const from = pos + 1; // +1 for block open token
              const tag = trimmed.slice(1); // strip leading @
              const kind = resolveTagKind(tag);

              const slashIdx = tag.indexOf("/");
              if (slashIdx > 0) {
                // Two-piece pill: project segment, then note-title companion.
                const projectEnd = from + 1 + slashIdx; // include leading `@`
                const noteEnd = from + trimmed.length;
                decorations.push(
                  Decoration.inline(from, projectEnd, {
                    class: "project-mention project-mention-pair",
                    "data-mention-kind": kind,
                  })
                );
                decorations.push(
                  Decoration.inline(projectEnd, noteEnd, {
                    class: "project-mention-note",
                    "data-mention-kind": kind,
                  })
                );
              } else {
                const to = from + trimmed.length;
                decorations.push(
                  Decoration.inline(from, to, {
                    class: "project-mention",
                    "data-mention-kind": kind,
                  })
                );
              }
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
