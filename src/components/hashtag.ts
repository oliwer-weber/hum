/**
 * HashTag — TipTap Mark extension for #tag rendering.
 * Decorates #tag patterns as styled pills in the editor.
 * Display-only: the stored markdown is never modified.
 */

import { Mark, mergeAttributes } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const TAG_RE = /#[a-zA-Z][\w-]*/g;

const SEMANTIC: Record<string, string> = {
  "#blocked": "vault-tag-blocked",
  "#waiting": "vault-tag-waiting",
  "#on-hold": "vault-tag-onhold",
};

export const HashTag = Mark.create({
  name: "hashtag",

  parseHTML() {
    return [{ tag: "span.vault-tag" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes({ class: "vault-tag" }, HTMLAttributes), 0];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return;
              let match: RegExpExecArray | null;
              TAG_RE.lastIndex = 0;
              while ((match = TAG_RE.exec(node.text)) !== null) {
                const from = pos + match.index;
                const to = from + match[0].length;
                const semantic = SEMANTIC[match[0].toLowerCase()] ?? "";
                decorations.push(
                  Decoration.inline(from, to, {
                    class: `vault-tag ${semantic}`.trim(),
                  })
                );
              }
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
