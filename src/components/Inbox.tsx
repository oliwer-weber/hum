import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

import { useEditor, EditorContent } from "@tiptap/react";
import { createSharedExtensions, PAIRS, CLOSE_CHARS } from "./editor-config";
import { WikiLink, WikiEmbed, convertTextToWikiLinks } from "./wikilink";
import { HashTag } from "./hashtag";
import { attachProjectAutocomplete, ProjectMentionKeymap, ProjectTagStyle } from "./project-mention";
import type { ProjectItem } from "./project-mention";
import type { VaultFileInfo } from "./wikilink";

const FRONTMATTER = "---\ncssclasses:\n  - home-title\n---";

interface InboxProps {
  refreshKey: number;
  onVaultChanged?: () => void;
}

interface ProcessResult {
  routed: { project: string; path: string; todos_added: number; notes_added: number }[];
  untagged_remaining: string[];
  unknown_tags: string[];
  hub_files_updated: string[];
  timestamp: string;
}

export default function Inbox({ refreshKey, onVaultChanged }: InboxProps) {
  const [rawMarkdown, setRawMarkdown] = useState<string | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [lastResult, setLastResult] = useState<ProcessResult | null>(null);
  const [statusRoll, setStatusRoll] = useState<"idle" | "rolling-out" | "result" | "rolling-back">("idle");
  const rollTimerRef = useRef<number | null>(null);
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

  // Project list for @project autocomplete
  const projectsRef = useRef<ProjectItem[]>([]);

  useEffect(() => {
    invoke<ProjectItem[]>("list_projects").then((projects) => {
      projectsRef.current = projects;
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
    extensions: createSharedExtensions({
      extraExtensions: [
        WikiLink.configure({
          getVaultFiles: () => vaultFilesRef.current,
          checkExists: (stem: string) => vaultStemsRef.current.has(stem),
        }),
        WikiEmbed,
        HashTag,
        ProjectMentionKeymap,
        ProjectTagStyle,
      ],
    }),
    editorProps: {
      attributes: { class: "inbox-tiptap" },
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

  // ── Attach @project autocomplete once editor is ready ──
  useEffect(() => {
    if (!editor || !editorReady) return;
    const cleanup = attachProjectAutocomplete(editor, () => projectsRef.current);
    return cleanup;
  }, [editor, editorReady]);

  // ── Switchover: when editor is ready, transfer content ──
  useEffect(() => {
    if (!editor || editorReady) return;
    // Don't switch over until the async read has finished
    if (rawMarkdown === null) return;
    skipNextSave.current = true;
    editor.commands.setContent(rawMarkdown || "");
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

  const triggerStatusRoll = useCallback(() => {
    if (rollTimerRef.current) clearTimeout(rollTimerRef.current);
    const ROLL_DURATION = 350;
    // Phase 1: roll default text out (up)
    setStatusRoll("rolling-out");
    rollTimerRef.current = window.setTimeout(() => {
      // Phase 2: show result text (rolls in from below)
      setStatusRoll("result");
      rollTimerRef.current = window.setTimeout(() => {
        // Phase 3: roll result text out (up)
        setStatusRoll("rolling-back");
        rollTimerRef.current = window.setTimeout(() => {
          // Phase 4: back to idle (default rolls in from below)
          setStatusRoll("idle");
        }, ROLL_DURATION);
      }, 3000);
    }, ROLL_DURATION);
  }, []);

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

    // ── Sweep-out animation: stagger bottom→top ──
    let wrapEl: HTMLElement | null = null;
    if (editorReady && currentEditor) {
      const tiptapEl = currentEditor.view.dom as HTMLElement;
      wrapEl = tiptapEl.closest(".inbox-editor-wrap") as HTMLElement | null;
      const children = Array.from(tiptapEl.children) as HTMLElement[];
      if (children.length > 0 && wrapEl) {
        const STAGGER = 85;
        const DURATION = 1000;
        const total = children.length;
        children.forEach((child, i) => {
          const reverseIndex = total - 1 - i;
          child.style.setProperty("--sweep-delay", `${reverseIndex * STAGGER}ms`);
        });
        currentEditor.setEditable(false);
        wrapEl.classList.add("sweeping");
        await new Promise((resolve) =>
          setTimeout(resolve, (total - 1) * STAGGER + DURATION)
        );
        // Transition to swept: keeps content invisible while we reload
        wrapEl.classList.remove("sweeping");
        wrapEl.classList.add("swept");
      }
    }

    try {
      const result = await invoke<ProcessResult>("process_inbox");
      setLastResult(result);
      if (result.routed.length > 0) triggerStatusRoll();
      // Reload with whatever remains in inbox
      const raw = await invoke<string>("read_inbox");
      const stripped = raw.replace(/^---[\s\S]*?---\s*/, "").trim();
      setRawMarkdown(stripped);
      if (editorReady && currentEditor) {
        skipNextSave.current = true;
        currentEditor.commands.setContent(stripped || "");
        convertTextToWikiLinks(currentEditor);
        // Clean up sweep state — new content is ready
        currentEditor.setEditable(true);
        wrapEl?.classList.remove("swept");
      }

      // Signal that vault files changed (triggers Dashboard reload etc.)
      onVaultChanged?.();

      // Refresh project list in case new projects were created
      invoke<ProjectItem[]>("list_projects").then((projects) => {
        projectsRef.current = projects;
      });
    } catch (err) {
      console.error("Inbox processing failed:", err);
      // Clean up sweep state on failure
      if (currentEditor) currentEditor.setEditable(true);
      wrapEl?.classList.remove("swept");
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
            placeholder="capture anything"
            autoFocus
          />
        </div>
      )}
      {/* TipTap editor — rendered offscreen until ready, then shown */}
      <div
        className="inbox-editor-wrap"
        style={editorReady ? undefined : { position: "absolute", left: "-9999px", top: 0, width: "100%", height: "100%" }}
        onClick={(e) => {
          // Only focus-end when clicking the wrapper's empty space, not the editor content itself
          if (e.target === e.currentTarget) editor?.commands.focus("end");
        }}
      >
        <EditorContent editor={editor} />
      </div>
      <div className="inbox-status-bar">
        <span className="inbox-status-left">
          {(statusRoll === "idle" || statusRoll === "rolling-out") && (
            <span className={`inbox-hint ${statusRoll === "rolling-out" ? "roll-out" : "roll-in"}`}>
              {saving ? "Saving..." : "@project to route — edits auto-save — Ctrl+B bold, Ctrl+I italic, Ctrl+L checkbox"}
            </span>
          )}
          {(statusRoll === "result" || statusRoll === "rolling-back") && lastResult && (
            <span className={`inbox-hint inbox-hint-result ${statusRoll === "rolling-back" ? "roll-out" : "roll-in"}`}>
              {lastResult.routed.map((r) => {
                const parts = [r.project];
                if (r.todos_added > 0) parts.push(`${r.todos_added} todo${r.todos_added > 1 ? "s" : ""}`);
                if (r.notes_added > 0) parts.push(`${r.notes_added} note${r.notes_added > 1 ? "s" : ""}`);
                return parts.join(" · ");
              }).join("  —  ")}
              {lastResult.unknown_tags.length > 0 && `  ·  new: ${lastResult.unknown_tags.join(", ")}`}
            </span>
          )}
        </span>
        <div className="inbox-status-right">
          <button
            className="inbox-process-btn"
            onClick={handleProcess}
            disabled={processing}
          >
            {processing ? "Processing..." : "Process inbox"}
          </button>
        </div>
      </div>
    </div>
  );
}
