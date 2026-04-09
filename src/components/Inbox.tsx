import { useState, useEffect, useRef, useCallback } from "react";
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

const FRONTMATTER = "---\ncssclasses:\n  - home-title\n---";

/* ── Auto-pair brackets ──────────────────────────── */

const PAIRS: Record<string, string> = {
  "(": ")",
  "{": "}",
  '"': '"',
  "'": "'",
  "`": "`",
};

const CLOSE_CHARS = new Set(Object.values(PAIRS));

interface InboxProps {
  refreshKey: number;
}

export default function Inbox({ refreshKey }: InboxProps) {
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveTimeoutRef = useRef<number | null>(null);
  const skipNextSave = useRef(false);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);

  // Vault file index for suggestions
  const vaultFilesRef = useRef<VaultFileInfo[]>([]);
  const vaultStemsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    invoke<VaultFileInfo[]>("vault_all_files").then((files) => {
      vaultFilesRef.current = files;
      vaultStemsRef.current = new Set(files.map((f) => f.stem));
    });
  }, []);

  const saveToFile = useCallback(async (md: string) => {
    setSaving(true);
    try {
      const fullContent = md.trim()
        ? `${FRONTMATTER}\n${md}\n`
        : `${FRONTMATTER}\n`;
      await invoke("write_inbox_raw", { content: fullContent });
    } catch (err) {
      console.error("Failed to save inbox:", err);
    }
    setSaving(false);
  }, []);

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
        getVaultFiles: () => vaultFilesRef.current,
        checkExists: (stem: string) => vaultStemsRef.current.has(stem),
      }),
      WikiEmbed,
    ],
    editorProps: {
      attributes: { class: "inbox-tiptap" },
      handleKeyDown: (_view, event) => {
        // Ctrl+L: toggle task list
        if (event.ctrlKey && event.key === "l") {
          event.preventDefault();
          if (editorRef.current) {
            if (editorRef.current.isActive("taskList")) {
              editorRef.current.chain().focus().liftListItem("taskItem").run();
            } else {
              editorRef.current.chain().focus().toggleTaskList().run();
            }
          }
          return true;
        }

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
            tr.insertText(event.key + closing, from);
            tr.setSelection(
              editorRef.current.state.selection.constructor.near(
                tr.doc.resolve(from + 1)
              ) as typeof editorRef.current.state.selection
            );
          } else {
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
      if (skipNextSave.current) {
        skipNextSave.current = false;
        return;
      }
      const md = (ed.storage as any).markdown.getMarkdown();
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = window.setTimeout(() => {
        saveToFile(md);
      }, 500);
    },
  });

  // Keep ref in sync
  useEffect(() => {
    (editorRef as React.MutableRefObject<typeof editor>).current = editor;
  }, [editor]);

  // Load inbox.md on mount
  useEffect(() => {
    async function load() {
      try {
        const raw = await invoke<string>("read_inbox");
        const stripped = raw.replace(/^---[\s\S]*?---\s*/, "").trim();
        if (editor) {
          skipNextSave.current = true;
          editor.commands.setContent(stripped || "");
          convertTextToWikiLinks(editor);
        }
      } catch (err) {
        console.error("Failed to read inbox:", err);
      }
      setLoaded(true);
    }
    if (editor) load();
  }, [editor]);

  // Reload from disk when refreshKey changes
  useEffect(() => {
    if (!editor || refreshKey === 0) return;
    async function reload() {
      try {
        const raw = await invoke<string>("read_inbox");
        const stripped = raw.replace(/^---[\s\S]*?---\s*/, "").trim();
        skipNextSave.current = true;
        editor!.commands.setContent(stripped || "");
        convertTextToWikiLinks(editor!);
      } catch (err) {
        console.error("Failed to reload inbox:", err);
      }
    }
    reload();
  }, [refreshKey, editor]);

  if (!loaded) {
    return (
      <div className="inbox-canvas">
        <div className="inbox-loading">Loading inbox...</div>
      </div>
    );
  }

  return (
    <div className="inbox-canvas">
      <EditorContent editor={editor} className="inbox-editor-wrap" />
      <div className="inbox-status-bar">
        <span className="inbox-status-left">
          {saving ? (
            <span className="inbox-hint">Saving...</span>
          ) : (
            <span className="inbox-hint">@project to route — edits auto-save — Ctrl+B bold, Ctrl+I italic, Ctrl+L checkbox</span>
          )}
        </span>
      </div>
    </div>
  );
}
