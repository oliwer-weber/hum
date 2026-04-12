/**
 * TaggedText — renders #tag patterns as styled pills.
 * Display-only: the underlying text is never modified.
 *
 * Usage:
 *   <TaggedText text="Fix login #blocked" />
 *   → "Fix login " + <span class="vault-tag vault-tag-blocked">#blocked</span>
 */

import React from "react";

const TAG_RE = /(#[a-zA-Z][\w-]*)/g;

const SEMANTIC_TAGS: Record<string, string> = {
  "#blocked": "vault-tag-blocked",
  "#waiting": "vault-tag-waiting",
  "#on-hold": "vault-tag-onhold",
};

export function TaggedText({ text }: { text: string }) {
  const parts = text.split(TAG_RE);
  if (parts.length === 1) return <>{text}</>;

  return (
    <>
      {parts.map((part, i) =>
        TAG_RE.test(part) ? (
          <span key={i} className={`vault-tag ${SEMANTIC_TAGS[part.toLowerCase()] ?? ""}`}>
            {part}
          </span>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        )
      )}
    </>
  );
}

/**
 * Custom components for ReactMarkdown that render #tags in text nodes.
 * Spread into <ReactMarkdown components={tagComponents}>.
 */
export const tagComponents = {
  // Override paragraph to process #tags in children
  p: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement> & { children?: React.ReactNode }) => (
    <p {...props}>{processChildren(children)}</p>
  ),
  li: ({ children, ...props }: React.LiHTMLAttributes<HTMLLIElement> & { children?: React.ReactNode }) => (
    <li {...props}>{processChildren(children)}</li>
  ),
  td: ({ children, ...props }: React.TdHTMLAttributes<HTMLTableCellElement> & { children?: React.ReactNode }) => (
    <td {...props}>{processChildren(children)}</td>
  ),
};

function processChildren(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, (child) => {
    if (typeof child === "string") {
      return <TaggedText text={child} />;
    }
    return child;
  });
}
