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

interface ProcessResult {
  routed: { project: string; path: string; todos_added: number; notes_added: number }[];
  untagged_remaining: string[];
  unknown_tags: string[];
  hub_files_updated: string[];
  timestamp: string;
}

export default function Inbox({ refreshKey }: InboxProps) {
  const [rawMarkdown, setRawMarkdown] = useState<string | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [lastResult, setLastResult] = useState<ProcessResult | null>(null);
  const saveTimeoutRef = useRef<number | null>(null);
  const skipNextSave = useRef(false);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Vault file index for suggestions
  const vaultFilesRef = useRef<VaultFileInfo[]>([]);
  const vaultStemsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    invoke<VaultFileInfo[]>("vault_all_files").then((files) => {
      vaultFilesRef.current = files;
      vaultStemsRef.current = new Set(files.map((f) => f.stem));
    });
  }, []);

  // ── Load raw markdown immediately on mount ────────
  useEffect(() => {
    invoke<string>("read_inbox").then((raw) => {
      const stripped = raw.replace(/^---[\s\S]*?---\s*/, "").trim();
      setRawMarkdown(stripped);
    }).catch((err) => {
      console.error("Failed to read inbox:", err);
      setRawMarkdown("");
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

  // ── Auto-save for textarea phase ──────────────────
  const handleTextareaChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setRawMarkdown(value);
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = window.setTimeout(() => {
      saveToFile(value);
    }, 500);
  }, [saveToFile]);

  // ── Auto-pair brackets in textarea ────────────────
  const handleTextareaKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const { selectionStart: start, selectionEnd: end } = ta;

    // Skip-over closing char
    if (CLOSE_CHARS.has(e.key)) {
      const after = ta.value[start];
      if (after === e.key && start === end) {
        e.preventDefault();
        ta.setSelectionRange(start + 1, start + 1);
        return;
      }
    }

    // Insert pair
    const closing = PAIRS[e.key];
    if (closing) {
      e.preventDefault();
      const before = ta.value.slice(0, start);
      const selected = ta.value.slice(start, end);
      const after = ta.value.slice(end);
      const newValue = before + e.key + selected + closing + after;
      setRawMarkdown(newValue);
      // Need to defer cursor positioning after React render
      requestAnimationFrame(() => {
        ta.value = newValue;
        ta.setSelectionRange(start + 1, start + 1 + selected.length);
      });
      return;
    }

    // Backspace: delete empty pair
    if (e.key === "Backspace" && start === end && start > 0) {
      const charBefore = ta.value[start - 1];
      const charAfter = ta.value[start];
      if (PAIRS[charBefore] && PAIRS[charBefore] === charAfter) {
        e.preventDefault();
        const newValue = ta.value.slice(0, start - 1) + ta.value.slice(start + 1);
        setRawMarkdown(newValue);
        requestAnimationFrame(() => {
          ta.value = newValue;
          ta.setSelectionRange(start - 1, start - 1);
        });
      }
    }
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

  // ── Switchover: when editor is ready, transfer content ──
  useEffect(() => {
    if (!editor || editorReady) return;
    // Get the latest content (user may have typed in textarea)
    const current = rawMarkdown ?? "";
    skipNextSave.current = true;
    editor.commands.setContent(current || "");
    convertTextToWikiLinks(editor);

    // Transfer cursor to end of editor
    editor.commands.focus("end");
    setEditorReady(true);
  }, [editor, rawMarkdown, editorReady]);

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
        setRawMarkdown(stripped);
      } catch (err) {
        console.error("Failed to reload inbox:", err);
      }
    }
    reload();
  }, [refreshKey, editor]);

  const handleProcess = useCallback(async () => {
    const currentEditor = editorRef.current;
    // Flush any pending save first
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      if (editorReady && currentEditor) {
        const md = (currentEditor.storage as any).markdown.getMarkdown();
        await saveToFile(md);
      } else if (rawMarkdown) {
        await saveToFile(rawMarkdown);
      }
    }
    setProcessing(true);
    setLastResult(null);
    try {
      const result = await invoke<ProcessResult>("process_inbox");
      setLastResult(result);
      // Reload with whatever remains in inbox
      const raw = await invoke<string>("read_inbox");
      const stripped = raw.replace(/^---[\s\S]*?---\s*/, "").trim();
      setRawMarkdown(stripped);
      if (editorReady && currentEditor) {
        skipNextSave.current = true;
        currentEditor.commands.setContent(stripped || "");
        convertTextToWikiLinks(currentEditor);
      }
    } catch (err) {
      console.error("Inbox processing failed:", err);
    }
    setProcessing(false);
  }, [editorReady, rawMarkdown, saveToFile]);

  // ── Render ────────────────────────────────────────

  if (rawMarkdown === null) {
    return (
      <div className="inbox-canvas">
        <div className="inbox-loading">Loading inbox...</div>
      </div>
    );
  }

  return (
    <div className="inbox-canvas">
      {/* Textarea shown immediately, hidden once TipTap takes over */}
      {!editorReady && (
        <div className="inbox-editor-wrap">
          <textarea
            ref={textareaRef}
            className="inbox-textarea"
            value={rawMarkdown}
            onChange={handleTextareaChange}
            onKeyDown={handleTextareaKeyDown}
            placeholder="Start writing..."
            autoFocus
          />
        </div>
      )}
      {/* TipTap editor — rendered offscreen until ready, then shown */}
      <div
        className="inbox-editor-wrap"
        style={editorReady ? undefined : { position: "absolute", left: "-9999px", top: 0, width: "100%", height: "100%" }}
      >
        <EditorContent editor={editor} />
      </div>
      {lastResult && lastResult.routed.length > 0 && (
        <div className="inbox-process-result">
          {lastResult.routed.map((r) => (
            <span key={r.path} className="inbox-route-tag">
              {r.project}
              {r.todos_added > 0 && <span className="route-count"> {r.todos_added} todo{r.todos_added > 1 ? "s" : ""}</span>}
              {r.notes_added > 0 && <span className="route-count"> {r.notes_added} note{r.notes_added > 1 ? "s" : ""}</span>}
            </span>
          ))}
          {lastResult.unknown_tags.length > 0 && (
            <span className="inbox-route-unknown">
              Unknown: {lastResult.unknown_tags.join(", ")}
            </span>
          )}
        </div>
      )}
      <div className="inbox-status-bar">
        <span className="inbox-status-left">
          {saving ? (
            <span className="inbox-hint">Saving...</span>
          ) : (
            <span className="inbox-hint">@project to route — edits auto-save — Ctrl+B bold, Ctrl+I italic, Ctrl+L checkbox</span>
          )}
        </span>
        <button
          className="inbox-process-btn"
          onClick={handleProcess}
          disabled={processing}
        >
          {processing ? "Processing..." : "Process inbox"}
        </button>
      </div>
    </div>
  );
}
