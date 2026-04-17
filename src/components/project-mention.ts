import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/core";

/**
 * Project autocomplete for the Inbox editor.
 *
 * Watches the editor for "@" at line start, shows a dropdown of projects,
 * and replaces the @query with the selected project name on confirm.
 *
 * - `attachProjectAutocomplete(editor, getProjects)` — hooks into editor
 *   transactions to detect @mentions and manage the popup lifecycle.
 * - `ProjectMentionKeymap` — TipTap Extension registering a ProseMirror
 *   plugin for keyboard handling (arrow nav, Tab/Enter confirm, Escape).
 */

/* ── Types ────────────────────────────────────────── */

export interface ProjectItem {
  name: string;
  path: string;
}

export type MentionKind = "project" | "note" | "wiki";

export interface MentionableItem {
  name: string;
  path: string;
  kind: MentionKind;
}

interface RenderItem {
  item: MentionableItem | null;
  isCreate: boolean;
  createName: string;
}

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

function hasExactMatch(query: string, items: MentionableItem[]): boolean {
  const q = normalize(query);
  if (!q) return false;
  return items.some((it) => normalize(it.name) === q);
}

/* ── Popup DOM ────────────────────────────────────── */

let popup: HTMLElement | null = null;
let items: RenderItem[] = [];
let selectedIndex = 0;
let onSelect: ((item: RenderItem) => void) | null = null;
let editorRef: Editor | null = null;
let usingKeyboard = false; // suppress mouseenter during keyboard nav

// Shared mentionables accessor. Set by `attachProjectAutocomplete` so the
// decoration plugin (`ProjectTagStyle`) can classify @tags at render time.
let mentionablesGetter: (() => MentionableItem[]) | null = null;

/** Resolve an @tag to its kind (work/personal/note/wiki), or "pending" if unknown. */
function resolveTagKind(tag: string): "work" | "personal" | "note" | "wiki" | "pending" {
  if (!mentionablesGetter) return "pending";
  const norm = normalize(tag);
  if (!norm) return "pending";
  const match = mentionablesGetter().find((it) => normalize(it.name) === norm);
  if (!match) return "pending";
  if (match.kind === "project") {
    // path is "projects/<scope>/<name>" — only work/personal appear in the
    // mentionables list (archive is excluded), so treat anything else as work.
    const scope = match.path.split("/")[1];
    return scope === "personal" ? "personal" : "work";
  }
  return match.kind;
}

function renderPopup() {
  if (!popup) return;
  popup.innerHTML = "";

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pm-suggest-empty";
    empty.textContent = "Type a project name...";
    popup.appendChild(empty);
    return;
  }

  items.forEach((item, i) => {
    const row = document.createElement("div");
    row.className =
      "pm-suggest-item" +
      (i === selectedIndex ? " pm-suggest-selected" : "") +
      (item.isCreate ? " pm-suggest-create" : "");
    if (!item.isCreate && item.item) {
      row.setAttribute("data-mention-kind", displayKindOf(item.item));
    } else if (item.isCreate) {
      row.setAttribute("data-mention-kind", "pending");
    }

    const name = document.createElement("span");
    name.className = "pm-suggest-name";
    name.textContent = item.isCreate
      ? `new note: ${item.createName}`
      : item.item!.name;
    row.appendChild(name);

    if (!item.isCreate && item.item) {
      const label = document.createElement("span");
      label.className = "pm-suggest-path";
      label.textContent = mentionLabel(item.item);
      row.appendChild(label);
    }

    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      onSelect?.(item);
    });
    row.addEventListener("mouseenter", () => {
      if (usingKeyboard || selectedIndex === i) return;
      popup?.querySelectorAll(".pm-suggest-item").forEach((el, j) => {
        el.classList.toggle("pm-suggest-selected", j === i);
      });
      selectedIndex = i;
    });
    popup!.appendChild(row);
  });

  // Programmatic scroll — popup is overflow:hidden so browser can't steal arrow keys
  scrollToSelected();
}

function scrollToSelected() {
  if (!popup) return;
  const sel = popup.querySelector(".pm-suggest-selected") as HTMLElement;
  if (!sel) return;
  const popupRect = popup.getBoundingClientRect();
  const selRect = sel.getBoundingClientRect();
  const pad = 8;
  if (selRect.bottom > popupRect.bottom - pad) {
    popup.scrollTop += selRect.bottom - popupRect.bottom + pad;
  } else if (selRect.top < popupRect.top + pad) {
    popup.scrollTop -= popupRect.top - selRect.top + pad;
  }
}

function showPopup(rect: DOMRect, renderItems: RenderItem[], selectFn: (item: RenderItem) => void) {
  if (!popup) {
    popup = document.createElement("div");
    popup.className = "pm-suggest";
    // Mouse wheel scrolling (since overflow:hidden blocks native scroll)
    popup.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (popup) popup.scrollTop += e.deltaY;
    }, { passive: false });
    // Prevent clicks on popup from stealing editor focus
    popup.addEventListener("mousedown", (e) => e.preventDefault());
    // Force editor to keep focus when mouse enters popup
    popup.addEventListener("mouseenter", () => {
      editorRef?.view.focus();
    });
    // Real mouse movement resets keyboard nav mode
    popup.addEventListener("mousemove", () => {
      usingKeyboard = false;
    });
    document.body.appendChild(popup);
  }
  // Only reset selection when the item list actually changes
  const changed = renderItems.length !== items.length ||
    renderItems.some((r, i) => {
      const prev = items[i];
      if (r.isCreate !== prev?.isCreate) return true;
      if (r.isCreate) return r.createName !== prev.createName;
      return r.item?.path !== prev?.item?.path;
    });
  items = renderItems;
  if (changed) selectedIndex = 0;
  if (selectedIndex >= items.length) selectedIndex = Math.max(0, items.length - 1);
  onSelect = selectFn;
  popup.style.left = `${rect.left}px`;
  popup.style.display = "";
  renderPopup();
  const popupHeight = popup.offsetHeight || 280;
  if (rect.bottom + 6 + popupHeight > window.innerHeight) {
    popup.style.top = `${rect.top - popupHeight - 6}px`;
  } else {
    popup.style.top = `${rect.bottom + 6}px`;
  }
}

function hidePopup() {
  if (popup) {
    popup.remove();
    popup = null;
  }
  items = [];
  selectedIndex = 0;
  onSelect = null;
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

  // Get text of the current block node from start to cursor
  const textBefore = $from.parent.textBetween(0, $from.parentOffset);

  // Check if the line starts with @ (possibly with leading whitespace)
  const match = textBefore.match(/^(\s*)@([^\s]*)$/);
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

// Sort order within the popup: existing items (projects > notes > wiki) first,
// alphabetical within each kind.
const KIND_ORDER: Record<MentionKind, number> = { project: 0, note: 1, wiki: 2 };
function compareItems(a: MentionableItem, b: MentionableItem): number {
  const k = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (k !== 0) return k;
  return a.name.localeCompare(b.name);
}

function buildItems(query: string, items: MentionableItem[]): RenderItem[] {
  const q = query.trim();

  if (!q) {
    return items.slice().sort(compareItems).slice(0, 12).map((it) => ({
      item: it,
      isCreate: false,
      createName: "",
    }));
  }

  const matched: RenderItem[] = items
    .filter((it) => fuzzyMatch(q, it.name))
    .sort(compareItems)
    .slice(0, 10)
    .map((it) => ({
      item: it,
      isCreate: false,
      createName: "",
    }));

  if (q.length > 0 && !hasExactMatch(q, items)) {
    matched.push({
      item: null,
      isCreate: true,
      createName: q,
    });
  }

  return matched;
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

export function attachProjectAutocomplete(
  editor: Editor,
  getMentionables: () => MentionableItem[],
): () => void {
  editorRef = editor;
  mentionablesGetter = getMentionables;
  let active = false;
  let currentMatch: MentionMatch | null = null;

  function confirmSelection(item: RenderItem) {
    if (!currentMatch) return;
    const name = item.isCreate ? item.createName : item.item!.name;
    const { from, to } = currentMatch;

    // Single transaction: delete @query, insert @ProjectName, split block.
    // Using one transaction avoids position-mapping issues between chained commands.
    editor.chain().focus().command(({ tr, dispatch }) => {
      if (!dispatch) return false;
      const tagText = `@${name}`;
      tr.replaceWith(from, to, editor.state.schema.text(tagText));
      tr.split(from + tagText.length);
      return true;
    }).run();

    hidePopup();
    active = false;
    currentMatch = null;
  }

  function update() {
    const mention = detectMention(editor);

    if (!mention) {
      if (active) {
        hidePopup();
        active = false;
        currentMatch = null;
      }
      return;
    }

    currentMatch = mention;
    const mentionables = getMentionables();
    const renderItems = buildItems(mention.query, mentionables);
    const rect = getCursorRect(editor);

    if (!rect) {
      hidePopup();
      active = false;
      return;
    }

    active = true;
    showPopup(rect, renderItems, confirmSelection);
  }

  // Listen to editor transactions (cursor moves, text changes)
  editor.on("transaction", update);

  // Cleanup
  return () => {
    editor.off("transaction", update);
    editorRef = null;
    mentionablesGetter = null;
    hidePopup();
  };
}

/**
 * TipTap Extension that registers a ProseMirror plugin for popup keyboard
 * handling. This runs at plugin priority — the same level as TipTap's
 * Suggestion plugin used by wikilinks.
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
 * ProjectTagStyle — Mark extension that decorates @project tags
 * as styled pills. Matches paragraphs whose entire text is an
 * @mention (the tag always occupies its own line). Display-only:
 * stored markdown is never modified (same pattern as HashTag).
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
              const to = from + trimmed.length;
              const tag = trimmed.slice(1); // strip leading @
              const kind = resolveTagKind(tag);
              decorations.push(
                Decoration.inline(from, to, {
                  class: "project-mention",
                  "data-mention-kind": kind,
                })
              );
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
