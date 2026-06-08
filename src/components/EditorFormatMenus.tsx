import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  Fragment,
} from "react";
import { createPortal } from "react-dom";
import { BubbleMenu } from "@tiptap/react/menus";
import type { Editor } from "@tiptap/core";
import { EDITOR_COMMANDS, type EditorCommand } from "./editor-commands";

/**
 * Mouse-driven formatting for the Inbox editor. Three surfaces over the one
 * shared command set in `editor-commands`:
 *   - bubble toolbar     — floats above a text selection
 *   - context menu       — right-click menu at the cursor
 *   - inline link editor — a small URL field, opened by the Link command
 *
 * `EditorFormatMenus` ties them together: it routes every command through
 * `runCommand`, which opens the link editor for link commands and otherwise
 * runs the command directly.
 */

/* ── Shared helpers ───────────────────────────────────── */

/** Re-render whenever the editor's selection/marks change so active states stay live. */
function useEditorTick(editor: Editor): void {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    editor.on("transaction", tick);
    return () => {
      editor.off("transaction", tick);
    };
  }, [editor]);
}

/** Walk the command list, yielding a divider between groups. */
function withGroupDividers(
  renderItem: (cmd: EditorCommand) => React.ReactNode,
  renderDivider: (key: string) => React.ReactNode,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let prevGroup: string | null = null;
  for (const cmd of EDITOR_COMMANDS) {
    if (prevGroup !== null && cmd.group !== prevGroup) {
      out.push(renderDivider(`div-${cmd.group}`));
    }
    out.push(<Fragment key={cmd.id}>{renderItem(cmd)}</Fragment>);
    prevGroup = cmd.group;
  }
  return out;
}

/* ── Selection bubble toolbar ─────────────────────────── */

function BubbleToolbar({
  editor,
  onRun,
}: {
  editor: Editor;
  onRun: (cmd: EditorCommand) => void;
}) {
  useEditorTick(editor);

  return (
    <BubbleMenu
      editor={editor}
      options={{
        placement: "top",
        offset: 8,
        // inline anchors to the selection's own client rects (not a loose
        // bounding box), so the bubble sits centred over the actual text.
        inline: true,
        // flip below when there's no room above; shift to stay on-screen.
        flip: true,
        shift: { padding: 8 },
      }}
      className="fmt-bubble"
    >
      {withGroupDividers(
        (cmd) => {
          const active = cmd.isActive(editor);
          return (
            <button
              type="button"
              className={"fmt-btn" + (active ? " fmt-btn-active" : "")}
              title={cmd.hint ? `${cmd.label} · ${cmd.hint}` : cmd.label}
              aria-label={cmd.label}
              aria-pressed={active}
              // mousedown+preventDefault keeps the text selection intact
              onMouseDown={(e) => {
                e.preventDefault();
                onRun(cmd);
              }}
            >
              {cmd.icon}
            </button>
          );
        },
        (key) => <span key={key} className="fmt-divider" aria-hidden="true" />,
      )}
    </BubbleMenu>
  );
}

/* ── Right-click context menu ─────────────────────────── */

interface MenuPos {
  x: number;
  y: number;
}

function ContextMenu({
  editor,
  onRun,
}: {
  editor: Editor;
  onRun: (cmd: EditorCommand) => void;
}) {
  const [pos, setPos] = useState<MenuPos | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEditorTick(editor);

  // Open on right-click inside the editor. Place the caret at the click when
  // there's no selection, so "insert" commands land where the user pointed.
  useEffect(() => {
    const dom = editor.view.dom as HTMLElement;
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      if (editor.state.selection.empty) {
        const hit = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
        if (hit) editor.chain().focus().setTextSelection(hit.pos).run();
      }
      setPos({ x: e.clientX, y: e.clientY });
    };
    dom.addEventListener("contextmenu", onContext);
    return () => dom.removeEventListener("contextmenu", onContext);
  }, [editor]);

  // Dismiss on outside click, Escape, scroll, blur, resize.
  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPos(null);
    };
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setPos(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [pos]);

  // Keep the menu inside the viewport.
  useLayoutEffect(() => {
    if (!pos || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const pad = 8;
    let x = pos.x;
    let y = pos.y;
    if (x + rect.width > window.innerWidth - pad) x = window.innerWidth - rect.width - pad;
    if (y + rect.height > window.innerHeight - pad) y = window.innerHeight - rect.height - pad;
    if (x !== pos.x || y !== pos.y) setPos({ x, y });
  }, [pos]);

  if (!pos) return null;

  return createPortal(
    <div ref={menuRef} className="fmt-menu" style={{ left: pos.x, top: pos.y }} role="menu">
      {withGroupDividers(
        (cmd) => {
          const active = cmd.isActive(editor);
          return (
            <button
              type="button"
              role="menuitem"
              className={"fmt-menu-item" + (active ? " fmt-menu-item-active" : "")}
              aria-pressed={active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onRun(cmd);
                setPos(null);
              }}
            >
              <span className="fmt-menu-icon">{cmd.icon}</span>
              <span className="fmt-menu-label">{cmd.label}</span>
              {cmd.hint && <span className="fmt-menu-hint">{cmd.hint}</span>}
            </button>
          );
        },
        (key) => <div key={key} className="fmt-menu-divider" aria-hidden="true" />,
      )}
    </div>,
    document.body,
  );
}

/* ── Inline link editor ───────────────────────────────── */

interface LinkEditState {
  from: number;
  to: number;
  empty: boolean;
  href: string;
  anchor: { left: number; top: number; bottom: number };
}

/** Capture the selection range + any existing href + an anchor rect. */
function buildLinkState(editor: Editor): LinkEditState | null {
  const { from, to, empty } = editor.state.selection;
  const href = (editor.getAttributes("link").href as string | undefined) ?? "";
  let coords;
  try {
    coords = editor.view.coordsAtPos(from);
  } catch {
    return null;
  }
  return {
    from,
    to,
    empty,
    href,
    anchor: { left: coords.left, top: coords.top, bottom: coords.bottom },
  };
}

/** Prepend https:// when there's no scheme, so bare domains still resolve. */
function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  if (/^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(t)) return t;
  return "https://" + t;
}

function applyLink(editor: Editor, st: LinkEditState, raw: string): void {
  const url = normalizeUrl(raw);
  const chain = editor.chain().focus();
  if (!url) {
    // Cleared field → drop the link if there was one.
    if (!st.empty || editor.isActive("link")) {
      chain.setTextSelection({ from: st.from, to: st.to }).extendMarkRange("link").unsetLink().run();
    }
    return;
  }
  if (st.empty && !editor.isActive("link")) {
    // No selection and not on a link → drop the URL in as its own linked text.
    chain
      .insertContentAt(st.from, {
        type: "text",
        text: url,
        marks: [{ type: "link", attrs: { href: url } }],
      })
      .run();
  } else {
    chain.setTextSelection({ from: st.from, to: st.to }).extendMarkRange("link").setLink({ href: url }).run();
  }
}

function LinkEditor({
  editor,
  state,
  onClose,
}: {
  editor: Editor;
  state: LinkEditState;
  onClose: () => void;
}) {
  const [value, setValue] = useState(state.href);
  const [pos, setPos] = useState<MenuPos>({ x: state.anchor.left, y: state.anchor.bottom + 6 });
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Dismiss on outside click.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [onClose]);

  // Keep on-screen; flip above the selection if it would overflow the bottom.
  useLayoutEffect(() => {
    if (!rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    const pad = 8;
    let x = pos.x;
    let y = pos.y;
    if (x + rect.width > window.innerWidth - pad) x = window.innerWidth - rect.width - pad;
    if (x < pad) x = pad;
    if (y + rect.height > window.innerHeight - pad) y = state.anchor.top - rect.height - 6;
    if (x !== pos.x || y !== pos.y) setPos({ x, y });
  }, [pos, state]);

  const submit = () => {
    applyLink(editor, state, value);
    onClose();
  };

  return createPortal(
    <div ref={rootRef} className="fmt-link" style={{ left: pos.x, top: pos.y }}>
      <input
        ref={inputRef}
        type="text"
        className="fmt-link-input"
        value={value}
        placeholder="Paste or type a link"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="fmt-link-hint" aria-hidden="true">↵</span>
    </div>,
    document.body,
  );
}

/* ── Wrapper ──────────────────────────────────────────── */

export function EditorFormatMenus({ editor }: { editor: Editor }) {
  const [linkState, setLinkState] = useState<LinkEditState | null>(null);

  const runCommand = useCallback(
    (cmd: EditorCommand) => {
      if (cmd.opensLinkEditor) {
        const st = buildLinkState(editor);
        if (st) setLinkState(st);
        return;
      }
      cmd.run(editor);
    },
    [editor],
  );

  return (
    <>
      <BubbleToolbar editor={editor} onRun={runCommand} />
      <ContextMenu editor={editor} onRun={runCommand} />
      {linkState && (
        <LinkEditor editor={editor} state={linkState} onClose={() => setLinkState(null)} />
      )}
    </>
  );
}
