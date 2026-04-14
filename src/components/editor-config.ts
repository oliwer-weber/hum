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
    ];
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
    Image,
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
