import type { ReactNode } from "react";
import type { Editor } from "@tiptap/core";

/**
 * Shared formatting command set for the Inbox editor.
 *
 * One source of truth, rendered in two surfaces: the selection bubble toolbar
 * (`EditorBubbleMenu`) and the right-click context menu (`EditorContextMenu`).
 * Both read `isActive` / `run` from here so they can never drift.
 *
 * Link is intentionally absent for now — it needs a small inline URL field
 * (window.prompt is unreliable in the Tauri webview), tracked as a follow-up.
 */

export type CommandGroup = "format" | "block" | "insert";

export interface EditorCommand {
  id: string;
  label: string;
  hint?: string;            // keyboard shortcut hint, shown in the context menu
  group: CommandGroup;
  icon: ReactNode;
  isActive: (editor: Editor) => boolean;
  run: (editor: Editor) => void;
  // When set, the menus open the inline URL editor instead of calling `run`
  // (a link needs a URL, which `run` alone can't supply).
  opensLinkEditor?: boolean;
}

/* ── Icons (Feather-style, 16px, currentColor) ────────── */

function ico(children: ReactNode): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const BoldIcon = ico(
  <>
    <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7z" />
    <path d="M7 12h7a3.5 3.5 0 0 1 0 7H7z" />
  </>
);

const ItalicIcon = ico(
  <>
    <line x1="19" y1="5" x2="11" y2="5" />
    <line x1="13" y1="19" x2="5" y2="19" />
    <line x1="15" y1="5" x2="9" y2="19" />
  </>
);

const StrikeIcon = ico(
  <>
    <line x1="4" y1="12" x2="20" y2="12" />
    <path d="M16 7.2C15 5.9 13.6 5.4 12 5.4c-2 0-3.6 1-3.6 2.6 0 1 .6 1.7 1.7 2.2" />
    <path d="M8.4 15.2c.5 1.7 2 2.4 3.9 2.4 2 0 3.7-.9 3.7-2.7" />
  </>
);

const HighlightIcon = ico(
  <>
    <path d="M15.5 4.5l4 4-9 9-4 1 1-4z" />
    <line x1="4" y1="20.5" x2="15" y2="20.5" />
  </>
);

const CodeIcon = ico(
  <>
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </>
);

const HeadingIcon = ico(
  <>
    <path d="M6 5v14" />
    <path d="M18 5v14" />
    <path d="M6 12h12" />
  </>
);

const BulletIcon = ico(
  <>
    <line x1="9" y1="6" x2="20" y2="6" />
    <line x1="9" y1="12" x2="20" y2="12" />
    <line x1="9" y1="18" x2="20" y2="18" />
    <circle cx="4.5" cy="6" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="18" r="1.4" fill="currentColor" stroke="none" />
  </>
);

const CheckboxIcon = ico(
  <>
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <path d="M8 12l3 3 5-6" />
  </>
);

const MentionIcon = ico(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94" />
  </>
);

const WikiLinkIcon = ico(
  <>
    <path d="M8 4H5v16h3" />
    <path d="M16 4h3v16h-3" />
  </>
);

const LinkIcon = ico(
  <>
    <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </>
);

/* ── Insert helpers ───────────────────────────────────── */

/** Start an @mention. It must sit at the start of its own line for the project
 * picker to fire, so drop to a fresh line when the current block has content;
 * collapse any selection to its end first so selected text is never replaced. */
function insertMention(e: Editor): void {
  const { $to } = e.state.selection;
  const blockEmpty = $to.parent.textContent.length === 0;
  if (blockEmpty) {
    e.chain().focus().setTextSelection($to.pos).insertContent("@").run();
  } else {
    e.chain().focus().setTextSelection($to.end()).splitBlock().insertContent("@").run();
  }
}

/** Start a [[wikilink]] and let the existing picker take over. The suggestion
 * only fires when "[[" sits at a text-node start or after whitespace, so add a
 * leading space when the preceding char is neither. */
function insertWikiLink(e: Editor): void {
  const { state } = e;
  const pos = state.selection.to; // collapse to the end of any selection
  const charBefore = pos > 0 ? state.doc.textBetween(pos - 1, pos) : "";
  const needsSpace = charBefore !== "" && !/\s/.test(charBefore);
  e.chain().focus().setTextSelection(pos).insertContent((needsSpace ? " " : "") + "[[").run();
}

/* ── Command list ─────────────────────────────────────── */

export const EDITOR_COMMANDS: EditorCommand[] = [
  {
    id: "bold",
    label: "Bold",
    hint: "Ctrl B",
    group: "format",
    icon: BoldIcon,
    isActive: (e) => e.isActive("bold"),
    run: (e) => e.chain().focus().toggleBold().run(),
  },
  {
    id: "italic",
    label: "Italic",
    hint: "Ctrl I",
    group: "format",
    icon: ItalicIcon,
    isActive: (e) => e.isActive("italic"),
    run: (e) => e.chain().focus().toggleItalic().run(),
  },
  {
    id: "strike",
    label: "Strikethrough",
    group: "format",
    icon: StrikeIcon,
    isActive: (e) => e.isActive("strike"),
    run: (e) => e.chain().focus().toggleStrike().run(),
  },
  {
    id: "highlight",
    label: "Highlight",
    group: "format",
    icon: HighlightIcon,
    isActive: (e) => e.isActive("highlight"),
    run: (e) => e.chain().focus().toggleHighlight().run(),
  },
  {
    id: "code",
    label: "Inline code",
    group: "format",
    icon: CodeIcon,
    isActive: (e) => e.isActive("code"),
    run: (e) => e.chain().focus().toggleCode().run(),
  },
  {
    id: "heading",
    label: "Heading",
    group: "block",
    icon: HeadingIcon,
    isActive: (e) => e.isActive("heading", { level: 2 }),
    run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    id: "bulletList",
    label: "Bullet list",
    group: "block",
    icon: BulletIcon,
    isActive: (e) => e.isActive("bulletList"),
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    id: "checkbox",
    label: "Checkbox",
    hint: "Ctrl L",
    group: "block",
    icon: CheckboxIcon,
    isActive: (e) => e.isActive("taskList"),
    run: (e) => e.chain().focus().toggleTaskList().run(),
  },
  {
    id: "mention",
    label: "Mention",
    hint: "@",
    group: "insert",
    icon: MentionIcon,
    isActive: () => false,
    run: insertMention,
  },
  {
    id: "wikilink",
    label: "Wikilink",
    hint: "[[",
    group: "insert",
    icon: WikiLinkIcon,
    isActive: () => false,
    run: insertWikiLink,
  },
  {
    id: "link",
    label: "Link",
    hint: "Ctrl K",
    group: "insert",
    icon: LinkIcon,
    isActive: (e) => e.isActive("link"),
    run: () => {}, // handled by the menus via opensLinkEditor
    opensLinkEditor: true,
  },
];
