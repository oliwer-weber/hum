/* ═══════════════════════════════════════════════════════════════════
 * Response Classifiers
 *
 * Each classifier scores confidence (0–1) on raw response text and
 * provides a parser to extract structured data for its renderer.
 * The system picks the highest-scoring classifier above the threshold,
 * falling back to plain markdown.
 *
 * To add a new type: define a Classifier object here, add a renderer
 * in renderers.tsx, and register both in the maps below.
 * ═══════════════════════════════════════════════════════════════════ */

export type ResponseType =
  | "action-report"
  | "structured-list"
  | "confirmation"
  | "conversational"
  | "markdown";

export interface Classifier {
  type: ResponseType;
  confidence: (text: string) => number;
  parse: (text: string) => unknown;
}

/* ── Parsed data shapes ───────────────────────────── */

export interface ActionReportEntry {
  project: string;
  details: string;
  files: string[];
}

export interface ActionReportData {
  header: string;
  entries: ActionReportEntry[];
  footer: string;
}

export interface StructuredListItem {
  time?: string;
  label: string;
  sublabel?: string;
  checked?: boolean;
}

export interface StructuredListGroup {
  heading?: string;
  items: StructuredListItem[];
}

export interface StructuredListData {
  header: string;
  groups: StructuredListGroup[];
  footer: string;
}

export interface ConfirmationData {
  text: string;
}

export interface ConversationalData {
  body: string;
  question: string;
}

/* ── Action Report ────────────────────────────────── */
// Detects: "Done/completed" + bold project names + file paths + counts
// Covers: inbox processing, bulk file operations, any "I did things" response

const actionReportClassifier: Classifier = {
  type: "action-report",
  confidence(text) {
    let score = 0;
    // Bold project-style names
    if (/\*\*@?[\w\s—\-]+\*\*/.test(text)) score += 0.25;
    // Backtick file paths
    if (/`[\w.\/\-]+\.(md|txt|json)`/.test(text)) score += 0.2;
    // Counts (N todos, N items, N notes)
    if (/\d+\s+(todos?|items?|notes?|files?|sub-?todos?)/i.test(text)) score += 0.2;
    // Action words in opening
    if (/^(done|completed|finished|here'?s what|routed|processed|created|updated)/im.test(text)) score += 0.2;
    // Status footer patterns
    if (/(dashboard updated|inbox cleared|timestamp|updated at)/i.test(text)) score += 0.15;
    return Math.min(score, 1);
  },
  parse(text): ActionReportData {
    const lines = text.split("\n").filter((l) => l.trim());

    // First non-empty line is the header
    const header = lines[0] || "";

    // Lines with bold text are entries
    const entries: ActionReportEntry[] = [];
    for (const line of lines.slice(1)) {
      const projectMatch = line.match(/\*\*@?([^*]+)\*\*/);
      if (projectMatch) {
        const project = projectMatch[1].trim();
        const files = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
        // Everything after the bold project name is details
        const details = line
          .replace(/\*\*@?[^*]+\*\*/, "")
          .replace(/`[^`]+`/g, "")
          .replace(/^\s*[—\-:]\s*/, "")
          .trim();
        entries.push({ project, details, files });
      }
    }

    // Footer: last line(s) that mention status/dashboard/timestamp
    const footerLines = lines.filter((l) =>
      /(dashboard|inbox|timestamp|updated|cleared)/i.test(l) &&
      !/\*\*/.test(l)
    );
    const footer = footerLines.join(" ").trim();

    return { header, entries, footer };
  },
};

/* ── Structured List ──────────────────────────────── */
// Detects: time patterns, checkbox items, grouped lists
// Covers: schedules, todo summaries, activity summaries

const structuredListClassifier: Classifier = {
  type: "structured-list",
  confidence(text) {
    let score = 0;
    const lines = text.split("\n").filter((l) => l.trim());

    // Time patterns (09:00, 14:30, etc.) — even 1 is enough
    const timeLines = lines.filter((l) => /\d{1,2}:\d{2}/.test(l));
    if (timeLines.length >= 1) score += 0.35;
    if (timeLines.length >= 3) score += 0.15;

    // Checkbox patterns — even 1 is enough
    const checkboxLines = lines.filter((l) => /[-*]\s*\[[ x]\]/i.test(l));
    if (checkboxLines.length >= 1) score += 0.35;
    if (checkboxLines.length >= 3) score += 0.15;

    // Grouped structure (headings followed by list items)
    const headings = lines.filter((l) => /^#{1,4}\s/.test(l) || /^\*\*[^*]+\*\*\s*$/.test(l));
    const listItems = lines.filter((l) => /^\s*[-*]\s/.test(l));
    if (headings.length >= 1 && listItems.length >= 2) score += 0.25;

    // Bullet/numbered lists with content words (schedule, meeting, todo keywords)
    if (listItems.length >= 1 && /meeting|schedule|todo|task|event|call/i.test(text)) {
      score += 0.2;
    }

    // Numbered lists
    const numberedItems = lines.filter((l) => /^\d+\.\s/.test(l));
    if (numberedItems.length >= 2) score += 0.2;

    return Math.min(score, 1);
  },
  parse(text): StructuredListData {
    const lines = text.split("\n");
    const groups: StructuredListGroup[] = [];
    let currentGroup: StructuredListGroup = { items: [] };
    let header = "";
    let footer = "";
    let headerFound = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // First line before any list structure is the header
      if (!headerFound && !/^[-*#\d]/.test(trimmed) && !/\[[ x]\]/i.test(trimmed)) {
        header = trimmed.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1");
        headerFound = true;
        continue;
      }
      headerFound = true;

      // Heading = new group
      const headingMatch = trimmed.match(/^#{1,4}\s+(.+)/) || trimmed.match(/^\*\*([^*]+)\*\*\s*$/);
      if (headingMatch) {
        if (currentGroup.items.length > 0) {
          groups.push(currentGroup);
        }
        currentGroup = { heading: headingMatch[1].trim(), items: [] };
        continue;
      }

      // Time-based items (schedule) — handles various formats:
      // "- **11:00-11:30** — Event name", "* 09:00 - Event", "14:00–15:00: Meeting"
      // Strip markdown bold/italic before matching
      const stripped = trimmed.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1");
      const timeMatch = stripped.match(/^[-*•]?\s*(\d{1,2}:\d{2}(?:\s*[-–—]\s*\d{1,2}:\d{2})?)\s*[-–—:]\s*(.+)/);
      if (timeMatch) {
        currentGroup.items.push({
          time: timeMatch[1],
          label: timeMatch[2].replace(/\(([^)]+)\)/, "").trim(),
          sublabel: timeMatch[2].match(/\(([^)]+)\)/)?.[1],
        });
        continue;
      }

      // Checkbox items
      const checkMatch = stripped.match(/^[-*]\s*\[([ x])\]\s*(.+)/i);
      if (checkMatch) {
        currentGroup.items.push({
          label: checkMatch[2].trim(),
          checked: checkMatch[1].toLowerCase() === "x",
        });
        continue;
      }

      // Regular list items
      const listMatch = stripped.match(/^[-*]\s+(.+)/) || stripped.match(/^\d+\.\s+(.+)/);
      if (listMatch) {
        currentGroup.items.push({ label: listMatch[1].trim() });
        continue;
      }
    }

    if (currentGroup.items.length > 0) {
      groups.push(currentGroup);
    }

    // If no groups were created, the whole thing is the footer
    if (groups.length === 0) {
      footer = text;
    }

    return { header, groups, footer };
  },
};

/* ── Confirmation ─────────────────────────────────── */
// Detects: short responses (1–3 lines, < 200 chars)
// Covers: quick acknowledgments, simple answers

const confirmationClassifier: Classifier = {
  type: "confirmation",
  confidence(text) {
    const trimmed = text.trim();
    const lines = trimmed.split("\n").filter((l) => l.trim());

    if (lines.length > 3) return 0;
    if (trimmed.length > 200) return 0;

    let score = 0.5; // Base score for being short

    // Action words boost confidence
    if (/^(done|ok|sure|got it|noted|saved|updated|created|deleted|moved|processed)/i.test(trimmed)) {
      score += 0.3;
    }

    // Contains structured data → not a confirmation
    if (/\*\*/.test(trimmed) || /`[^`]+`/.test(trimmed) || /[-*]\s+/.test(trimmed)) {
      score -= 0.3;
    }

    return Math.max(0, Math.min(score, 1));
  },
  parse(text): ConfirmationData {
    return { text: text.trim() };
  },
};

/* ── Conversational ───────────────────────────────── */
// Detects: AI asking follow-up questions
// Covers: clarification requests, option presentations

const conversationalClassifier: Classifier = {
  type: "conversational",
  confidence(text) {
    const trimmed = text.trim();
    let score = 0;

    // Ends with a question
    if (/\?\s*$/.test(trimmed)) score += 0.3;

    // Question patterns
    if (/would you like|do you want|should I|which one|could you|can you clarify|let me know/i.test(trimmed)) {
      score += 0.3;
    }

    // Multiple questions
    const questionCount = (trimmed.match(/\?/g) || []).length;
    if (questionCount >= 2) score += 0.15;

    // Options/choices
    if (/\d\.\s+.+\n\d\.\s+/m.test(trimmed) || /option \d|choice \d/i.test(trimmed)) {
      score += 0.2;
    }

    // But if it's too short, it's probably a confirmation, not conversational
    if (trimmed.length < 60 && trimmed.split("\n").length <= 2) {
      score -= 0.3;
    }

    return Math.max(0, Math.min(score, 1));
  },
  parse(text): ConversationalData {
    const trimmed = text.trim();
    const lines = trimmed.split("\n");

    // Find the last question line
    let questionIdx = lines.length - 1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim().endsWith("?")) {
        questionIdx = i;
        break;
      }
    }

    const body = lines.slice(0, questionIdx).join("\n").trim();
    const question = lines.slice(questionIdx).join("\n").trim();

    return { body, question };
  },
};

/* ── Classifier registry ──────────────────────────── */

const CONFIDENCE_THRESHOLD = 0.5;

const allClassifiers: Classifier[] = [
  actionReportClassifier,
  structuredListClassifier,
  conversationalClassifier,
  confirmationClassifier,
  // markdown is the implicit fallback
];

export interface ClassificationResult {
  type: ResponseType;
  data: unknown;
  confidence: number;
}

export function classify(text: string): ClassificationResult {
  let best: ClassificationResult = {
    type: "markdown",
    data: text,
    confidence: 0,
  };

  for (const classifier of allClassifiers) {
    const score = classifier.confidence(text);
    if (score > best.confidence && score >= CONFIDENCE_THRESHOLD) {
      best = {
        type: classifier.type,
        data: classifier.parse(text),
        confidence: score,
      };
    }
  }

  return best;
}
