import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

import { useEditor, EditorContent } from "@tiptap/react";
import { createSharedExtensions, insertWikiEmbed, PAIRS, CLOSE_CHARS } from "./editor-config";
import SketchCanvas from "./SketchCanvas";
import { WikiLink, WikiEmbed, convertTextToWikiLinks } from "./wikilink";
import { HashTag } from "./hashtag";
import { attachProjectAutocomplete, ProjectMentionKeymap, ProjectTagStyle } from "./project-mention";
import type { MentionableItem, CreateKind, NoteRow } from "./project-mention";
import type { VaultFileInfo } from "./wikilink";
import { EditorFormatMenus } from "./EditorFormatMenus";
import { attachSmoothWheelScroll } from "./smooth-scroll";
import { getStoredSpellcheckWrite, SPELLCHECK_CHANGED_EVENT } from "../theme/theme";

const FRONTMATTER = "---\ncssclasses:\n  - home-title\n---";

// Rolling tips shown in the Write status bar while idle. Each one shows
// for TIP_DWELL_MS, then rolls up and the next rolls in from below using
// the same status-roll keyframes the process result uses.
const TIPS = [
  "@mention picks the project a thought belongs to",
  "Ctrl+Enter sends everything to its place",
  "Edits save themselves as you write",
  "Ctrl+B for bold, Ctrl+I for italic",
  "Ctrl+L makes a line a checkbox",
  "Link a note with [[brackets]]",
  "Tag with # to find it again later",
  "Half-formed thoughts are welcome here",
  "Ctrl+1-4 jumps between tabs",
  "Ctrl+, opens settings",
];
const TIP_DWELL_MS = 12000;
const TIP_ROLL_MS = 350;

interface InboxProps {
  refreshKey: number;
  onVaultChanged?: () => void;
}

interface ProcessResult {
  routed: { project: string; path: string; todos_added: number; notes_added: number; appended_to?: string }[];
  notes_routed: { tag: string; path: string; entries_added: number; is_new: boolean }[];
  untagged_remaining: string[];
  timestamp: string;
}

export default function Inbox({ refreshKey, onVaultChanged }: InboxProps) {
  const [rawMarkdown, setRawMarkdown] = useState<string | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [lastResult, setLastResult] = useState<ProcessResult | null>(null);
  const [sketchOpen, setSketchOpen] = useState(false);
  const [prewarmSketch, setPrewarmSketch] = useState(false);
  const [statusRoll, setStatusRoll] = useState<"idle" | "rolling-out" | "result" | "rolling-back">("idle");
  const rollTimerRef = useRef<number | null>(null);
  const [tipIndex, setTipIndex] = useState(0);
  const [tipRoll, setTipRoll] = useState<"in" | "out">("in");
  const tipTimerRef = useRef<number | null>(null);
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

  // Mentionable list for @ autocomplete (projects + notes + wiki files)
  const mentionablesRef = useRef<MentionableItem[]>([]);

  const reloadMentionables = useCallback(() => {
    invoke<MentionableItem[]>("list_mentionables").then((items) => {
      mentionablesRef.current = items;
    });
  }, []);

  useEffect(() => {
    reloadMentionables();
  }, [reloadMentionables, refreshKey]);

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
      attributes: { class: "inbox-tiptap md-surface" },
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

  // ── Attach @ autocomplete once editor is ready ──
  useEffect(() => {
    if (!editor || !editorReady) return;
    const onCreate = async (kind: CreateKind, name: string) => {
      if (kind === "work-project" || kind === "personal-project") {
        const bucket = kind === "work-project" ? "work" : "personal";
        await invoke("register_project", { name, bucket });
      } else if (kind === "wiki") {
        await invoke("create_wiki_entry", { name });
      } else if (kind === "note") {
        await invoke("create_note", { name });
      }
      // New file/project is now on disk. Refresh the mentionables so this
      // mention resolves as a known kind, and bump vault-wide state so the
      // Find tab picks it up too.
      await new Promise<void>((resolve) => {
        invoke<MentionableItem[]>("list_mentionables").then((items) => {
          mentionablesRef.current = items;
          resolve();
        }).catch(() => resolve());
      });
      onVaultChanged?.();
    };
    const listProjectNotes = async (projectPath: string): Promise<NoteRow[]> => {
      try {
        const notes = await invoke<Array<{ path: string; title: string }>>(
          "list_project_notes",
          { projectPath },
        );
        return notes
          .filter((n) => n.title && n.title.trim().length > 0)
          .map((n) => ({ path: n.path, title: n.title }));
      } catch (err) {
        console.error("list_project_notes failed:", err);
        return [];
      }
    };
    const cleanup = attachProjectAutocomplete(editor, () => mentionablesRef.current, { onCreate, listProjectNotes });
    // Refresh the mentionables list whenever the editor gains focus — catches
    // files created externally (Vault view, filesystem) since component mount.
    const onFocus = () => reloadMentionables();
    editor.on("focus", onFocus);
    return () => {
      cleanup();
      editor.off("focus", onFocus);
    };
  }, [editor, editorReady, reloadMentionables, onVaultChanged]);

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
        // Skip when disk already matches the editor. Without this, an unrelated
        // vault refresh (e.g. @mention create) clobbers the editor and remaps
        // the cursor to the end of the doc — right after a freshly typed
        // @mention — which re-triggers the autocomplete popup.
        const currentMd = (editor!.storage as any).markdown.getMarkdown().trim();
        if (currentMd === stripped) return;
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

  // Tip rotation — cycles through TIPS while the status bar is idle.
  // Reuses the same roll-in/roll-out classes the process result uses, so
  // the animation language matches. Pauses while a result is being shown
  // and while saving so neither gets yanked mid-flight.
  useEffect(() => {
    if (statusRoll !== "idle" || saving) {
      if (tipTimerRef.current) {
        clearTimeout(tipTimerRef.current);
        tipTimerRef.current = null;
      }
      return;
    }
    if (tipRoll === "in") {
      tipTimerRef.current = window.setTimeout(() => {
        setTipRoll("out");
      }, TIP_DWELL_MS);
    } else {
      tipTimerRef.current = window.setTimeout(() => {
        setTipIndex((i) => (i + 1) % TIPS.length);
        setTipRoll("in");
      }, TIP_ROLL_MS);
    }
    return () => {
      if (tipTimerRef.current) clearTimeout(tipTimerRef.current);
    };
  }, [tipRoll, statusRoll, saving]);

  // When a process result takes over the bar, normalize the tip phase so
  // when we return to idle the next tip rolls in from below rather than
  // flashing out of the top.
  useEffect(() => {
    if (statusRoll !== "idle") setTipRoll("in");
  }, [statusRoll]);

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
      if (result.routed.length > 0 || result.notes_routed.length > 0) triggerStatusRoll();
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

      // Refresh mentionables so new notes show up in autocomplete immediately
      reloadMentionables();
    } catch (err) {
      console.error("Inbox processing failed:", err);
      // Clean up sweep state on failure
      if (currentEditor) currentEditor.setEditable(true);
      wrapEl?.classList.remove("swept");
    }
    setProcessing(false);
  }, [editorReady, rawMarkdown, saveToFile]);

  // ── Ctrl+Enter to process (only when Write tab is active) ──
  const handleProcessRef = useRef(handleProcess);
  const processingRef = useRef(processing);
  useEffect(() => { handleProcessRef.current = handleProcess; }, [handleProcess]);
  useEffect(() => { processingRef.current = processing; }, [processing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== "Enter") return;
      if (!document.querySelector(".tab-panel-active .inbox-canvas")) return;
      if (processingRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      handleProcessRef.current();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  // ── Sketch (Excalidraw) ───────────────────────────
  // Save the drawing into the vault and drop a .excalidraw.png embed at the
  // cursor. The PNG carries the full scene, so the embed re-opens as an
  // editable canvas later. It rides whatever @mention precedes it on process.
  const handleSaveSketch = useCallback(async (png: Blob) => {
    const data = Array.from(new Uint8Array(await png.arrayBuffer()));
    const d = new Date();
    const ts = [
      d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"), String(d.getHours()).padStart(2, "0"),
      String(d.getMinutes()).padStart(2, "0"), String(d.getSeconds()).padStart(2, "0"),
    ].join("");
    const filename = `sketch-${ts}.excalidraw.png`;
    try {
      await invoke<string>("vault_save_sketch", {
        relativePath: `.app/metadata/Assets/${filename}`,
        data,
      });
      const ed = editorRef.current;
      if (ed) {
        insertWikiEmbed(ed.view, filename);
        // Persist immediately rather than waiting on the 500ms autosave debounce.
        // The insert schedules a debounced save; cancel it and flush now so disk
        // matches the editor and no refresh can clobber the freshly inserted node.
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        await saveToFile((ed.storage as any).markdown.getMarkdown());
      }
      setSketchOpen(false);
    } catch (err) {
      console.error("[sketch] save failed:", err);
      alert(`Sketch save failed: ${err}`);
    }
  }, [saveToFile]);

  // Ctrl/Cmd+Shift+D opens the sketch canvas while the Write tab is active.
  // The bubble/right-click "Sketch" command opens it via the same window event.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
      if (e.key.toLowerCase() !== "d") return;
      if (!document.querySelector(".tab-panel-active .inbox-canvas")) return;
      e.preventDefault();
      setSketchOpen(true);
    };
    const onCreateSketch = () => setSketchOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("hum:create-sketch", onCreateSketch);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("hum:create-sketch", onCreateSketch);
    };
  }, []);

  // Pre-mount the sketch canvas on idle after launch so the first "insert
  // sketch" opens instantly — the cost is Excalidraw's first mount, not just
  // the chunk download, so we pay it ahead of time off the critical path.
  useEffect(() => {
    const warm = () => setPrewarmSketch(true);
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (ric) {
      const id = ric(warm, { timeout: 5000 });
      return () => (window as unknown as { cancelIdleCallback?: (id: number) => void })
        .cancelIdleCallback?.(id);
    }
    const t = window.setTimeout(warm, 2500);
    return () => window.clearTimeout(t);
  }, []);

  // Ease mouse-wheel scrolling on the editor surface.
  useEffect(() => {
    if (!editor || !editorReady) return;
    const scroller = editor.view.dom.closest(".inbox-editor-wrap") as HTMLElement | null;
    if (!scroller) return;
    return attachSmoothWheelScroll(scroller);
  }, [editor, editorReady]);

  // Apply the Write-tab spellcheck setting, and react to live toggles.
  useEffect(() => {
    if (!editor) return;
    const apply = () =>
      editor.view.dom.setAttribute("spellcheck", getStoredSpellcheckWrite() ? "true" : "false");
    apply();
    window.addEventListener(SPELLCHECK_CHANGED_EVENT, apply);
    return () => window.removeEventListener(SPELLCHECK_CHANGED_EVENT, apply);
  }, [editor]);

  // ── Render ────────────────────────────────────────

  if (rawMarkdown === null) {
    return (
      <div className="inbox-canvas">
        <div className="inbox-loading">Loading...</div>
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
        {editor && editorReady && <EditorFormatMenus editor={editor} />}
      </div>
      <div className="inbox-status-bar">
        <span className="inbox-status-left">
          {(statusRoll === "idle" || statusRoll === "rolling-out") && (
            <span
              className={`inbox-hint ${
                statusRoll === "rolling-out" || tipRoll === "out" ? "roll-out" : "roll-in"
              }`}
            >
              {saving ? "Saving..." : TIPS[tipIndex]}
            </span>
          )}
          {(statusRoll === "result" || statusRoll === "rolling-back") && lastResult && (
            <span className={`inbox-hint inbox-hint-result ${statusRoll === "rolling-back" ? "roll-out" : "roll-in"}`}>
              {[
                ...lastResult.routed.map((r) => {
                  const head = r.appended_to ? `${r.project} / ${r.appended_to}` : r.project;
                  const parts = [head];
                  if (r.todos_added > 0) parts.push(`${r.todos_added} todo${r.todos_added > 1 ? "s" : ""}`);
                  if (r.notes_added > 0) {
                    const verb = r.appended_to ? "appended" : `note${r.notes_added > 1 ? "s" : ""}`;
                    parts.push(r.appended_to ? `${r.notes_added} ${verb}` : `${r.notes_added} ${verb}`);
                  }
                  return parts.join(" · ");
                }),
                ...lastResult.notes_routed.map((n) => {
                  const label = n.is_new ? `new @${n.tag}` : `@${n.tag}`;
                  return `${label} · ${n.entries_added} line${n.entries_added > 1 ? "s" : ""}`;
                }),
              ].join("  —  ")}
            </span>
          )}
        </span>
        <div className="inbox-status-right">
          <button
            className="inbox-process-btn"
            onClick={handleProcess}
            disabled={processing}
          >
            {processing ? "Processing..." : "Process"}
          </button>
        </div>
      </div>

      <SketchCanvas
        open={sketchOpen}
        prewarm={prewarmSketch}
        onClose={() => setSketchOpen(false)}
        onSave={handleSaveSketch}
      />
    </div>
  );
}
