import { Node, mergeAttributes } from "@tiptap/react";
import { InputRule } from "@tiptap/core";
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion";
import { invoke } from "@tauri-apps/api/core";
import type { Editor } from "@tiptap/core";

/**
 * WikiLink + WikiEmbed extensions for TipTap
 *
 * WikiLink  — [[page]]   → inline clickable link
 * WikiEmbed — ![[target]] → block-level rendered content (images, notes)
 */

/* ── Types ────────────────────────────────────────── */

export interface VaultFileInfo {
  stem: string;
  name: string;
  path: string;
}

export interface WikiLinkOptions {
  onNavigate?: (target: string) => void;
  checkExists?: (stem: string) => boolean;
  getVaultFiles?: () => VaultFileInfo[];
}

/* ── Post-load transform ──────────────────────────── */

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"]);

/**
 * Walk the editor document, find [[target]] and ![[target]] text patterns,
 * replace them with wikiLink / wikiEmbed nodes.
 */
export function convertTextToWikiLinks(editor: Editor) {
  const { state } = editor;
  const linkType = state.schema.nodes.wikiLink;
  const embedType = state.schema.nodes.wikiEmbed;

  interface Replacement {
    from: number;
    to: number;
    target: string;
    isEmbed: boolean;
  }
  const replacements: Replacement[] = [];

  state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    // Match ![[target]] (embed) and [[target]] (link), including escaped brackets
    const regex = /(!)?(\\?\[\\?\[)([^\]]+?)(\\?\]\\?\])/g;
    let match;
    while ((match = regex.exec(node.text)) !== null) {
      replacements.push({
        from: pos + match.index,
        to: pos + match.index + match[0].length,
        target: match[3],
        isEmbed: match[1] === "!",
      });
    }
  });

  if (replacements.length === 0) return;

  const tr = state.tr;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { from, to, target, isEmbed } = replacements[i];
    if (isEmbed && embedType) {
      tr.replaceWith(from, to, embedType.create({ target }));
    } else if (linkType) {
      tr.replaceWith(from, to, linkType.create({ target }));
    }
  }
  editor.view.dispatch(tr);
}

/* ── Suggestion popup (vanilla DOM) ───────────────── */

function createSuggestionRenderer() {
  let popup: HTMLElement | null = null;
  let items: VaultFileInfo[] = [];
  let selectedIndex = 0;
  let commandFn: ((props: VaultFileInfo) => void) | null = null;

  function render() {
    if (!popup) return;
    popup.innerHTML = "";
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "wl-suggest-empty";
      empty.textContent = "No matches";
      popup.appendChild(empty);
      return;
    }
    items.forEach((item, i) => {
      const row = document.createElement("div");
      row.className =
        "wl-suggest-item" + (i === selectedIndex ? " wl-suggest-selected" : "");

      const name = document.createElement("span");
      name.className = "wl-suggest-name";
      name.textContent = item.name;

      const path = document.createElement("span");
      path.className = "wl-suggest-path";
      const parts = item.path.split("/");
      path.textContent = parts.length > 1 ? parts.slice(0, -1).join("/") : "";

      row.appendChild(name);
      row.appendChild(path);
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        commandFn?.(item);
      });
      row.addEventListener("mouseenter", () => {
        selectedIndex = i;
        render();
      });
      popup!.appendChild(row);
    });

    const sel = popup.querySelector(".wl-suggest-selected") as HTMLElement;
    sel?.scrollIntoView({ block: "nearest" });
  }

  function position(clientRect: (() => DOMRect | null) | null) {
    if (!popup || !clientRect) return;
    const rect = typeof clientRect === "function" ? clientRect() : clientRect;
    if (!rect) return;
    popup.style.left = `${rect.left}px`;
    popup.style.top = `${rect.bottom + 4}px`;
  }

  return {
    onStart(props: SuggestionProps<VaultFileInfo>) {
      popup = document.createElement("div");
      popup.className = "wl-suggest";
      document.body.appendChild(popup);
      items = props.items as VaultFileInfo[];
      commandFn = (item) => props.command(item);
      selectedIndex = 0;
      render();
      position(props.clientRect ?? null);
    },
    onUpdate(props: SuggestionProps<VaultFileInfo>) {
      items = props.items as VaultFileInfo[];
      commandFn = (item) => props.command(item);
      if (selectedIndex >= items.length)
        selectedIndex = Math.max(0, items.length - 1);
      render();
      position(props.clientRect ?? null);
    },
    onKeyDown(props: { event: KeyboardEvent }) {
      if (props.event.key === "ArrowDown") {
        selectedIndex = (selectedIndex + 1) % Math.max(1, items.length);
        render();
        return true;
      }
      if (props.event.key === "ArrowUp") {
        selectedIndex =
          (selectedIndex - 1 + items.length) % Math.max(1, items.length);
        render();
        return true;
      }
      if (props.event.key === "Enter" || props.event.key === "Tab") {
        const item = items[selectedIndex];
        if (item) commandFn?.(item);
        return true;
      }
      if (props.event.key === "Escape") {
        popup?.remove();
        popup = null;
        return true;
      }
      return false;
    },
    onExit() {
      popup?.remove();
      popup = null;
    },
  };
}

/* ── Simple markdown → HTML for embedded notes ────── */

function miniMarkdownToHtml(md: string): string {
  // Strip frontmatter
  let text = md.replace(/^---[\s\S]*?---\s*/, "").trim();
  // Escape HTML
  text = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // Headings
  text = text.replace(/^######\s+(.+)$/gm, "<h6>$1</h6>");
  text = text.replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>");
  text = text.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
  text = text.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
  text = text.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
  text = text.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");
  // Bold & italic
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*(.+?)\*/g, "<em>$1</em>");
  // Checkboxes
  text = text.replace(
    /^- \[x\]\s+(.+)$/gm,
    '<div class="embed-task embed-task-done"><input type="checkbox" checked disabled />$1</div>'
  );
  text = text.replace(
    /^- \[ \]\s+(.+)$/gm,
    '<div class="embed-task"><input type="checkbox" disabled />$1</div>'
  );
  // Unordered list items
  text = text.replace(/^- (.+)$/gm, "<li>$1</li>");
  // Wrap consecutive <li> in <ul>
  text = text.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");
  // Paragraphs: wrap remaining non-tag lines
  text = text.replace(/^(?!<[hulo]|<div)(.+)$/gm, "<p>$1</p>");
  return text;
}

/* ═══════════════════════════════════════════════════
 * WikiLink — inline [[page]] node
 * ═══════════════════════════════════════════════════ */

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    wikiLink: {
      setWikiLink: (target: string) => ReturnType;
    };
  }
}

export const WikiLink = Node.create<WikiLinkOptions>({
  name: "wikiLink",
  group: "inline",
  inline: true,
  atom: true,

  addOptions() {
    return {
      onNavigate: undefined,
      checkExists: undefined,
      getVaultFiles: undefined,
    };
  },

  addAttributes() {
    return {
      target: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-target"),
        renderHTML: (attrs) => ({ "data-target": attrs.target }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="wiki-link"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const target = HTMLAttributes["data-target"] ?? "";
    const display = target.split("/").pop()?.replace(/\.md$/i, "") ?? target;
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-type": "wiki-link",
        class: "wiki-link",
      }),
      display,
    ];
  },

  addNodeView() {
    return ({ node }) => {
      const span = document.createElement("span");
      span.setAttribute("data-type", "wiki-link");

      const target = node.attrs.target as string;
      const display =
        target.split("/").pop()?.replace(/\.md$/i, "") ?? target;
      span.textContent = display;

      const check = this.options.checkExists;
      const stem = target.toLowerCase().replace(/\.md$/i, "");
      const leafStem = stem.includes("/") ? stem.split("/").pop()! : stem;
      const exists = check ? check(leafStem) : true;
      span.className = exists
        ? "wiki-link wiki-link-exists"
        : "wiki-link wiki-link-missing";

      span.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.options.onNavigate?.(target);
      });

      return { dom: span };
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: /\[\[([^\]]+)\]\]$/,
        handler: ({ state, range, match }) => {
          const target = match[1];
          const node = this.type.create({ target });
          const tr = state.tr.replaceWith(range.from, range.to, node);
          tr.insertText(" ", range.from + 1);
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    const extensionThis = this;
    return [
      Suggestion({
        editor: this.editor,
        char: "[[",
        allowSpaces: true,
        items: ({ query }: { query: string }) => {
          const files = extensionThis.options.getVaultFiles?.() ?? [];
          if (!query) return files.slice(0, 12);
          const q = query.toLowerCase();
          return files.filter((f) => f.stem.includes(q)).slice(0, 12);
        },
        command: ({
          editor,
          range,
          props,
        }: {
          editor: Editor;
          range: { from: number; to: number };
          props: VaultFileInfo;
        }) => {
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent([
              {
                type: "wikiLink",
                attrs: { target: props.path.replace(/\.md$/i, "") },
              },
              { type: "text", text: " " },
            ])
            .run();
        },
        render: createSuggestionRenderer,
      }),
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write(`[[${node.attrs.target}]]`);
        },
        parse: {},
      },
    };
  },
});

/* ═══════════════════════════════════════════════════
 * WikiEmbed — block-level ![[target]] node
 * Renders images inline, note content as embedded preview.
 * ═══════════════════════════════════════════════════ */

export const WikiEmbed = Node.create({
  name: "wikiEmbed",
  group: "block",
  atom: true,

  addAttributes() {
    return {
      target: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-target"),
        renderHTML: (attrs) => ({ "data-target": attrs.target }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="wiki-embed"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "wiki-embed",
        class: "wiki-embed",
      }),
      HTMLAttributes["data-target"] ?? "",
    ];
  },

  addNodeView() {
    return ({ node }) => {
      const container = document.createElement("div");
      container.className = "wiki-embed";
      container.setAttribute("data-type", "wiki-embed");

      const target = node.attrs.target as string;
      const ext = target.split(".").pop()?.toLowerCase() ?? "";
      const isImage = IMAGE_EXTS.has(ext);

      if (isImage) {
        // ── Image embed ──
        const img = document.createElement("img");
        img.className = "wiki-embed-img";
        img.alt = target.split("/").pop() ?? target;

        (async () => {
          try {
            const vaultPath = await invoke<string>("get_vault_path");
            const resolved = await invoke<string>("vault_resolve_link", {
              target,
            });
            const fullPath = `${vaultPath}/${resolved}`.replace(/\\/g, "/");
            img.src = `https://asset.localhost/${fullPath}`;
          } catch {
            img.alt = `Could not load: ${target}`;
            container.classList.add("wiki-embed-error");
          }
        })();

        container.appendChild(img);
      } else {
        // ── Note embed ──
        const header = document.createElement("div");
        header.className = "wiki-embed-header";
        const displayName =
          target.split("/").pop()?.replace(/\.md$/i, "") ?? target;
        header.textContent = displayName;
        container.appendChild(header);

        const content = document.createElement("div");
        content.className = "wiki-embed-content";
        content.innerHTML =
          '<span class="wiki-embed-loading">Loading...</span>';
        container.appendChild(content);

        (async () => {
          try {
            const resolved = await invoke<string>("vault_resolve_link", {
              target,
            });
            const md = await invoke<string>("vault_read_file", {
              relativePath: resolved,
            });
            content.innerHTML = miniMarkdownToHtml(md);
          } catch {
            content.innerHTML = `<span class="wiki-embed-error-text">Could not load: ${target}</span>`;
          }
        })();
      }

      return { dom: container };
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: /!\[\[([^\]]+)\]\]$/,
        handler: ({ state, range, match }) => {
          const target = match[1];
          const node = this.type.create({ target });
          state.tr.replaceWith(range.from, range.to, node);
        },
      }),
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write(`![[${node.attrs.target}]]\n`);
        },
        parse: {},
      },
    };
  },
});
