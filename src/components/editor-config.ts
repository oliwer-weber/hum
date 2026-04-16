/**
 * Shared editor configuration for Inbox and Vault Tiptap editors.
 * Single source of truth for extensions, keymaps, and auto-pair logic.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import Highlight from "@tiptap/extension-highlight";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import { Markdown } from "tiptap-markdown";
import type { EditorView } from "@tiptap/pm/view";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

/* ── Image paste/drop helpers ───────────────────── */

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
  "image/webp": "webp", "image/bmp": "bmp",
};

function timestampedFilename(ext: string): string {
  const d = new Date();
  const ts = [
    d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"), String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"), String(d.getSeconds()).padStart(2, "0"),
  ].join("");
  return `paste-${ts}.${ext}`;
}

async function saveImageBlob(blob: Blob): Promise<string | null> {
  const ext = MIME_TO_EXT[blob.type];
  if (!ext) return null;
  const filename = timestampedFilename(ext);
  const buf = await blob.arrayBuffer();
  const data = Array.from(new Uint8Array(buf));
  await invoke<string>("vault_save_image", { filename, data });
  return filename;
}

function insertWikiEmbed(view: EditorView, filename: string, pos?: number) {
  const insertPos = pos ?? view.state.selection.from;
  const embedType = view.state.schema.nodes.wikiEmbed;
  if (embedType) {
    const node = embedType.create({ target: filename });
    const tr = view.state.tr.insert(insertPos, node);
    view.dispatch(tr);
  } else {
    // Fallback if WikiEmbed extension isn't loaded
    const tr = view.state.tr.insertText(`![[${filename}]]\n`, insertPos);
    view.dispatch(tr);
  }
}

const imagePasteDropKey = new PluginKey("imagePasteDrop");

/* ── Auto-pair brackets ──────────────────────────── */

export const PAIRS: Record<string, string> = {
  "(": ")",
  "{": "}",
  "[": "]",
  '"': '"',
  "'": "'",
  "`": "`",
};

export const CLOSE_CHARS = new Set(Object.values(PAIRS));

/* ── Markdown wrap characters ────────────────────── */

const MARKDOWN_WRAPS: Record<string, { mark: string; cmd: string }> = {
  "*": { mark: "*", cmd: "toggleItalic" },
  "~": { mark: "~~", cmd: "toggleStrike" },
  "=": { mark: "==", cmd: "toggleHighlight" },
};

/* ── Shared keymap extension ─────────────────────── */

const autoPairKey = new PluginKey("sharedAutoPair");

export const SharedEditorKeymap = Extension.create({
  name: "sharedEditorKeymap",
  priority: 1000,

  onCreate() {
    // Tab is handled entirely at the DOM level because:
    // 1. The browser intercepts Tab for focus cycling before ProseMirror sees it
    // 2. Calling preventDefault() marks the event, and ProseMirror skips defaultPrevented events
    // So we must both prevent browser behavior AND do the work here.
    const editorInstance = this.editor;
    const el = editorInstance.view.dom;

    const handler = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key !== "Tab") return;

      ke.preventDefault();
      ke.stopPropagation();

      if (ke.shiftKey) {
        // Shift-Tab: dedent
        if (editorInstance.isActive("taskList")) {
          editorInstance.chain().focus().liftListItem("taskItem").run();
        } else if (editorInstance.isActive("bulletList") || editorInstance.isActive("orderedList")) {
          editorInstance.chain().focus().liftListItem("listItem").run();
        } else {
          // Plain text: remove up to 2 leading spaces from start of line
          editorInstance.chain().focus().command(({ tr, state }) => {
            const { from } = state.selection;
            const $pos = state.doc.resolve(from);
            const lineStart = $pos.start($pos.depth);
            const lineText = state.doc.textBetween(lineStart, $pos.end($pos.depth));
            const spaces = lineText.match(/^ {1,2}/);
            if (spaces) {
              tr.delete(lineStart, lineStart + spaces[0].length);
            }
            return true;
          }).run();
        }
      } else {
        // Tab: indent
        if (editorInstance.isActive("taskList")) {
          editorInstance.chain().focus().sinkListItem("taskItem").run();
        } else if (editorInstance.isActive("bulletList") || editorInstance.isActive("orderedList")) {
          editorInstance.chain().focus().sinkListItem("listItem").run();
        } else {
          // Plain text: insert 2 spaces at start of current line
          editorInstance.chain().focus().command(({ tr, state }) => {
            const { from } = state.selection;
            const $pos = state.doc.resolve(from);
            tr.insertText("  ", $pos.start($pos.depth));
            return true;
          }).run();
        }
      }
    };

    el.addEventListener("keydown", handler, true);
    (this as any)._tabHandler = handler;
  },

  onDestroy() {
    const el = this.editor.view.dom;
    if ((this as any)._tabHandler) {
      el.removeEventListener("keydown", (this as any)._tabHandler, true);
    }
  },

  addKeyboardShortcuts() {
    return {
      // Ctrl+L: toggle task list
      "Mod-l": ({ editor }) => {
        if (editor.isActive("taskList")) {
          return editor.chain().focus().liftListItem("taskItem").run();
        }
        return editor.chain().focus().toggleTaskList().run();
      },

      // Ctrl+Enter: new line below without splitting
      "Mod-Enter": ({ editor }) => {
        const { state, view } = editor;
        const { $to } = state.selection;
        const endOfBlock = $to.end($to.depth);
        const tr = state.tr;
        tr.split(endOfBlock);
        tr.setSelection(TextSelection.near(tr.doc.resolve(endOfBlock + 1)));
        view.dispatch(tr);
        return true;
      },

      // Ctrl+Shift+K: delete current line/block
      "Mod-Shift-k": ({ editor }) => {
        const { state, view } = editor;
        const { $from } = state.selection;
        const start = $from.start($from.depth);
        const end = $from.end($from.depth);
        if (start === end) {
          const before = $from.before($from.depth);
          const after = $from.after($from.depth);
          view.dispatch(state.tr.delete(before, after));
        } else {
          view.dispatch(state.tr.delete(start, end));
        }
        return true;
      },

      // Ctrl+K: insert link
      "Mod-k": ({ editor }) => {
        const { state, view } = editor;
        const { from, to } = state.selection;
        if (from === to) {
          const tr = state.tr;
          tr.insertText("[](url)", from);
          tr.setSelection(TextSelection.create(tr.doc, from + 1));
          view.dispatch(tr);
        } else {
          const selectedText = state.doc.textBetween(from, to);
          const tr = state.tr;
          tr.replaceWith(from, to, state.schema.text(`[${selectedText}](url)`));
          const urlStart = from + selectedText.length + 3;
          tr.setSelection(TextSelection.create(tr.doc, urlStart, urlStart + 3));
          view.dispatch(tr);
        }
        return true;
      },

      // Ctrl+Shift+V: paste as plain text
      "Mod-Shift-v": () => {
        navigator.clipboard.readText().then((text) => {
          this.editor.chain().focus().insertContent(text).run();
        });
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin({
        key: autoPairKey,
        props: {
          handleKeyDown(view: EditorView, event: KeyboardEvent) {
            // ── Markdown wrap-selection (*, ~, =) ──
            const wrap = MARKDOWN_WRAPS[event.key];
            if (wrap && !event.ctrlKey && !event.metaKey) {
              const { from, to } = editor.state.selection;
              if (from !== to) {
                event.preventDefault();
                const cmd = wrap.cmd;
                if (typeof (editor.commands as Record<string, unknown>)[cmd] === "function") {
                  (editor.chain().focus() as any)[cmd]().run();
                }
                return true;
              }
            }

            // ── Auto-pair: skip over closing char ──
            if (CLOSE_CHARS.has(event.key)) {
              const { from } = editor.state.selection;
              const docSize = editor.state.doc.content.size;
              if (from < docSize) {
                const after = editor.state.doc.textBetween(
                  from,
                  Math.min(docSize, from + 1)
                );
                if (after === event.key) {
                  event.preventDefault();
                  const tr = editor.state.tr;
                  tr.setSelection(
                    TextSelection.near(tr.doc.resolve(from + 1))
                  );
                  view.dispatch(tr);
                  return true;
                }
              }
            }

            // ── Auto-pair: insert pair ──
            const closing = PAIRS[event.key];
            if (closing) {
              // For [ key, don't auto-pair if starting a wikilink [[
              if (event.key === "[") {
                const { from } = editor.state.selection;
                if (from > 0) {
                  const charBefore = editor.state.doc.textBetween(from - 1, from);
                  if (charBefore === "[") {
                    return false;
                  }
                }
              }

              event.preventDefault();
              const { from, to } = editor.state.selection;
              const tr = editor.state.tr;
              if (from === to) {
                tr.insertText(event.key + closing, from);
                tr.setSelection(TextSelection.near(tr.doc.resolve(from + 1)));
              } else {
                tr.insertText(closing, to);
                tr.insertText(event.key, from);
              }
              view.dispatch(tr);
              return true;
            }

            // ── Backspace: delete empty pair ──
            if (event.key === "Backspace") {
              const { from } = editor.state.selection;
              if (from < 2) return false;
              const docSize = editor.state.doc.content.size;
              const before = editor.state.doc.textBetween(from - 1, from);
              const after =
                from < docSize
                  ? editor.state.doc.textBetween(from, Math.min(docSize, from + 1))
                  : "";
              const pair = PAIRS[before];
              if (pair && after === pair) {
                event.preventDefault();
                const tr = editor.state.tr;
                tr.delete(from - 1, from + 1);
                view.dispatch(tr);
                return true;
              }
            }

            return false;
          },
        },
      }),
      new Plugin({
        key: imagePasteDropKey,
        props: {
          handlePaste(view: EditorView, event: ClipboardEvent) {
            const items = event.clipboardData?.items;
            if (!items) return false;
            for (const item of Array.from(items)) {
              if (IMAGE_MIMES.has(item.type)) {
                event.preventDefault();
                const blob = item.getAsFile();
                if (!blob) return true;
                saveImageBlob(blob).then((name) => {
                  if (name) insertWikiEmbed(view, name);
                });
                return true;
              }
            }
            return false;
          },
          handleDrop(view: EditorView, event: DragEvent) {
            const files = event.dataTransfer?.files;
            if (!files || files.length === 0) return false;
            const imageFiles = Array.from(files).filter((f) => IMAGE_MIMES.has(f.type));
            if (imageFiles.length === 0) return false;
            event.preventDefault();
            const dropPos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            for (const file of imageFiles) {
              saveImageBlob(file).then((name) => {
                if (name) insertWikiEmbed(view, name, dropPos);
              });
            }
            return true;
          },
        },
      }),
    ];
  },
});

/* ── Vault-aware Image extension ─────────────────── */

const VaultImage = Image.extend({
  addNodeView() {
    return ({ node }) => {
      const container = document.createElement("div");
      container.className = "vault-image-wrapper";
      const img = document.createElement("img");
      img.alt = (node.attrs.alt as string) || "";
      const src = node.attrs.src as string;
      // Resolve relative vault paths to asset protocol URLs
      if (src && !src.startsWith("http") && !src.startsWith("data:")) {
        (async () => {
          try {
            const vaultPath = await invoke<string>("get_vault_path");
            const resolved = await invoke<string>("vault_resolve_link", {
              target: src,
              contextPath: undefined,
            });
            const fullPath = `${vaultPath}/${resolved}`.replace(/\\/g, "/");
            img.src = convertFileSrc(fullPath);
          } catch {
            img.alt = `Could not load: ${src}`;
          }
        })();
      } else {
        img.src = src;
      }
      container.appendChild(img);
      return { dom: container };
    };
  },
});

/* ── Shared extensions factory ───────────────────── */

interface SharedExtensionsOptions {
  placeholder?: string;
  extraExtensions?: any[];
}

export function createSharedExtensions(opts: SharedExtensionsOptions = {}) {
  const extensions = [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Link.configure({ openOnClick: false }),
    VaultImage,
    Highlight.configure({ multicolor: false }),
    Table.configure({ resizable: false }),
    TableRow,
    TableCell,
    TableHeader,
    Placeholder.configure({
      placeholder: opts.placeholder ?? "capture anything",
    }),
    Markdown.configure({
      html: false,
      transformPastedText: true,
      transformCopiedText: true,
    }),
    SharedEditorKeymap,
  ];

  if (opts.extraExtensions) {
    extensions.push(...opts.extraExtensions);
  }

  return extensions;
}
