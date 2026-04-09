/* ═══════════════════════════════════════════════════════════════════
 * Response Renderers
 *
 * Each renderer takes parsed data from its classifier and renders
 * a purpose-built content surface — not text, not chat, but designed
 * UI components that present information the way it deserves.
 * ═══════════════════════════════════════════════════════════════════ */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ActionReportData,
  StructuredListData,
  ConfirmationData,
  ConversationalData,
} from "./classifiers";

/* ── Markdown (fallback) ──────────────────────────── */

export function MarkdownRenderer({ text }: { text: string }) {
  return (
    <div className="res-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

/* ── Action Report ────────────────────────────────── */
// Renders project-based action results as a structured card

const ACCENT_CYCLE = ["green", "aqua", "yellow", "blue", "purple", "orange"] as const;

export function ActionReportCard({ data }: { data: ActionReportData }) {
  return (
    <div className="res-action-report res-enter">
      {data.header && (
        <div className="res-action-header">{data.header}</div>
      )}

      {data.entries.length > 0 && (
        <div className="res-action-card">
          {data.entries.map((entry, i) => (
            <div
              key={i}
              className="res-action-row"
              style={{ "--accent-color": `var(--${ACCENT_CYCLE[i % ACCENT_CYCLE.length]})` } as React.CSSProperties}
            >
              <div className="res-action-row-main">
                <span className="res-action-project">{entry.project}</span>
                <span className="res-action-details">{entry.details}</span>
              </div>
              {entry.files.length > 0 && (
                <div className="res-action-files">
                  {entry.files.map((f, j) => (
                    <code key={j}>{f}</code>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {data.footer && (
        <div className="res-action-footer">
          <span className="res-action-footer-icon">&#x2713;</span>
          <span className="res-action-footer-text">{data.footer}</span>
        </div>
      )}
    </div>
  );
}

/* ── Structured List ──────────────────────────────── */
// Renders schedules (timeline cards), todos (checkbox groups), generic lists

export function StructuredListBlock({ data }: { data: StructuredListData }) {
  const isSchedule = data.groups.some((g) =>
    g.items.some((item) => item.time)
  );

  return (
    <div className={`res-structured ${isSchedule ? "res-is-schedule" : "res-is-list"} res-enter`}>
      {data.header && (
        <div className="res-structured-header">{data.header}</div>
      )}

      <div className="res-structured-card">
        {data.groups.map((group, gi) => (
          <div key={gi} className="res-structured-group">
            {group.heading && (
              <div className="res-structured-heading">{group.heading}</div>
            )}

            {isSchedule ? (
              <div className="res-schedule-items">
                {group.items.map((item, ii) => (
                  <div key={ii} className="res-schedule-event">
                    <div className="res-schedule-time-col">
                      <span className="res-schedule-time">{item.time}</span>
                    </div>
                    <div className="res-schedule-content">
                      <span className="res-schedule-title">{item.label}</span>
                      {item.sublabel && (
                        <span className="res-schedule-meta">{item.sublabel}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="res-list-items">
                {group.items.map((item, ii) => (
                  <div key={ii} className="res-list-item">
                    {item.checked !== undefined && (
                      <span className={`res-list-check ${item.checked ? "res-list-checked" : ""}`}>
                        {item.checked ? "\u2713" : ""}
                      </span>
                    )}
                    <span className={`res-list-label ${item.checked ? "res-list-label-done" : ""}`}>
                      {item.label}
                    </span>
                    {item.sublabel && (
                      <span className="res-list-sublabel">{item.sublabel}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {data.footer && (
        <div className="res-structured-footer">{data.footer}</div>
      )}
    </div>
  );
}

/* ── Confirmation ─────────────────────────────────── */

export function ConfirmationBadge({ data }: { data: ConfirmationData }) {
  return (
    <div className="res-confirmation res-enter">
      <span className="res-confirmation-icon">&#x2713;</span>
      <span className="res-confirmation-text">{data.text}</span>
    </div>
  );
}

/* ── Conversational ───────────────────────────────── */
// AI is asking a question — render body + visually distinct question prompt

export function ConversationalBlock({ data }: { data: ConversationalData }) {
  return (
    <div className="res-conversational res-enter">
      {data.body && (
        <div className="res-conversational-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.body}</ReactMarkdown>
        </div>
      )}
      <div className="res-conversational-prompt">
        <div className="res-conversational-question">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.question}</ReactMarkdown>
        </div>
        <div className="res-conversational-hint">reply below</div>
      </div>
    </div>
  );
}
