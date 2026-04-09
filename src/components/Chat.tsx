import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { Command } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  classify,
  type ResponseType,
  type ActionReportData,
  type StructuredListData,
  type ConfirmationData,
  type ConversationalData,
} from "./classifiers";
import {
  MarkdownRenderer,
  ActionReportCard,
  StructuredListBlock,
  ConfirmationBadge,
  ConversationalBlock,
} from "./renderers";

/* ── Types ────────────────────────────────────────── */

interface Interaction {
  command: string;
  response: string;
  status: "streaming" | "done" | "error";
  activity: string;
  startedAt: number;
  classified?: {
    type: ResponseType;
    data: unknown;
  };
}

interface ChatProps {
  onVaultChanged: () => void;
}

/* ── Hum personality (appended to system prompt) ──── */

const HUM_PERSONALITY = `You are Hum — a personal assistant integrated into the user's productivity app.

Personality:
- Concise and sharp. Lead with the answer, not the preamble.
- Dry wit when appropriate — never forced, never corny. Think Jarvis: competent with a light touch.
- One short contextual remark per response is enough.
- Professional peer, not a servant. Confident, direct, occasionally opinionated.
- Never say "Great question!", "Hope that helps!", "Sure!", or any filler. Just deliver.
- When presenting schedules or summaries, add a brief human observation.
- The user is in Stockholm, Sweden.
- Keep responses short. If the answer is one sentence, don't write three.
- When you've completed an action, confirm briefly and mention what changed — don't narrate every step.

Output format (your output feeds a card renderer):
- Schedules: \`- **HH:MM-HH:MM** — Title (Location)\` (bulleted, bold times)
- Action reports: \`**@project** — N todos to \\\`file.md\\\`\` per project, summary footer line
- Todos: \`- [ ]\` / \`- [x]\` checkboxes under \`### Project\` headings
- Short confirmations: 1-2 plain lines
- Everything else: standard markdown
Put personality around the structured data, not instead of it.`;

/* ── Thinking phrases ─────────────────────────────── */

const THINKING_PHRASES = [
  "on it",
  "checking",
  "pulling threads",
  "digging in",
  "one moment",
  "working",
  "reading up",
  "crunching",
  "looking into it",
  "scanning",
  "processing",
  "almost there",
];

function useThinkingPhrase(isActive: boolean) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!isActive) {
      setIndex(0);
      return;
    }
    setIndex(Math.floor(Math.random() * THINKING_PHRASES.length));
    const interval = setInterval(() => {
      setIndex((prev) => (prev + 1) % THINKING_PHRASES.length);
    }, 2400);
    return () => clearInterval(interval);
  }, [isActive]);

  return THINKING_PHRASES[index];
}

/* ── Elapsed time ─────────────────────────────────── */

function useElapsedTime(startedAt: number, isActive: boolean) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isActive || !startedAt) {
      setElapsed(0);
      return;
    }
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startedAt, isActive]);

  if (elapsed < 3) return null;
  if (elapsed < 60) return `${elapsed}s`;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return `${mins}m ${secs}s`;
}

/* ── Streaming markdown ───────────────────────────── */

function StreamingMarkdown({ content }: { content: string }) {
  return (
    <div className="res-markdown res-streaming">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      <span className="res-cursor" />
    </div>
  );
}

/* ── Response block ───────────────────────────────── */

function ResponseBlock({ interaction }: { interaction: Interaction }) {
  const { response, status, classified } = interaction;

  if (status === "error") {
    return <div className="res-error res-enter">{response}</div>;
  }

  if (status === "streaming") {
    return <StreamingMarkdown content={response} />;
  }

  if (!classified || classified.type === "markdown") {
    return (
      <div className="res-enter">
        <MarkdownRenderer text={response} />
      </div>
    );
  }

  switch (classified.type) {
    case "action-report":
      return <ActionReportCard data={classified.data as ActionReportData} />;
    case "structured-list":
      return <StructuredListBlock data={classified.data as StructuredListData} />;
    case "confirmation":
      return <ConfirmationBadge data={classified.data as ConfirmationData} />;
    case "conversational":
      return <ConversationalBlock data={classified.data as ConversationalData} />;
    default:
      return (
        <div className="res-enter">
          <MarkdownRenderer text={response} />
        </div>
      );
  }
}

/* ── Thinking indicator ───────────────────────────── */

function ThinkingIndicator({ activity, startedAt }: { activity: string; startedAt: number }) {
  const phrase = useThinkingPhrase(true);
  const elapsed = useElapsedTime(startedAt, true);

  return (
    <div className="cmd-thinking">
      <div className="cmd-thinking-main">
        <span className="cmd-thinking-phrase">{phrase}</span>
        <span className="cmd-thinking-dots">
          <span className="cmd-thinking-dot" />
          <span className="cmd-thinking-dot" />
          <span className="cmd-thinking-dot" />
        </span>
      </div>
      <div className="cmd-thinking-meta">
        {activity && <span className="cmd-thinking-activity">{activity}</span>}
        {elapsed && <span className="cmd-thinking-elapsed">{elapsed}</span>}
      </div>
    </div>
  );
}

/* ── Command Surface ──────────────────────────────── */

export default function Chat({ onVaultChanged }: ChatProps) {
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (canvasRef.current) {
      canvasRef.current.scrollTop = canvasRef.current.scrollHeight;
    }
  }, [interactions]);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
      inputRef.current.style.height =
        Math.min(inputRef.current.scrollHeight, 120) + "px";
    }
  }, [input]);

  useEffect(() => {
    if (!loading) {
      inputRef.current?.focus();
    }
  }, [loading]);

  const latestInteraction = useMemo(
    () =>
      interactions.length > 0
        ? interactions[interactions.length - 1]
        : null,
    [interactions]
  );

  const isStreaming = loading && latestInteraction?.status === "streaming";
  const hasStreamContent = isStreaming && !!latestInteraction?.response;

  const newSession = useCallback(() => {
    setInteractions([]);
  }, []);

  async function sendCommand() {
    const text = input.trim();
    if (!text || loading) return;

    setInput("");
    const idx = interactions.length;
    const now = Date.now();
    setInteractions((prev) => [
      ...prev,
      { command: text, response: "", status: "streaming", activity: "", startedAt: now },
    ]);
    setLoading(true);

    try {
      const vaultPath = await invoke<string>("get_vault_path");

      // Build conversation context from previous interactions (last 6 exchanges max)
      const recent = interactions.slice(-6);
      let contextPrompt = text;
      if (recent.length > 0) {
        const history = recent
          .filter((ix) => ix.status === "done" && ix.response)
          .map((ix) => `User: ${ix.command}\nAssistant: ${ix.response}`)
          .join("\n\n");
        if (history) {
          contextPrompt = `[Previous conversation for context]\n${history}\n\n[Current request]\n${text}`;
        }
      }

      const command = Command.create(
        "claude",
        [
          "--print",
          "--dangerously-skip-permissions",
          "--append-system-prompt",
          HUM_PERSONALITY,
          contextPrompt,
        ],
        { cwd: vaultPath }
      );

      let output = "";

      command.stdout.on("data", (data) => {
        output += data;
        setInteractions((prev) => {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], response: output };
          return updated;
        });
      });

      command.stderr.on("data", (data) => {
        const line = String(data).trim();
        if (!line) return;
        if (line.includes("stdin") || line.includes("piping from")) return;
        if (line.includes("Warning:") || line.includes("warn")) return;

        let activity = line;
        if (activity.length > 80) {
          activity = activity.slice(0, 77) + "...";
        }

        setInteractions((prev) => {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], activity };
          return updated;
        });
      });

      await command.spawn();

      await new Promise<void>((resolve) => {
        command.on("close", () => resolve());
      });

      const result = classify(output);

      setInteractions((prev) => {
        const updated = [...prev];
        updated[idx] = {
          ...updated[idx],
          status: "done",
          activity: "",
          classified: { type: result.type, data: result.data },
        };
        return updated;
      });
    } catch (err) {
      setInteractions((prev) => {
        const updated = [...prev];
        updated[idx] = {
          ...updated[idx],
          response: `Error: ${err instanceof Error ? err.message : String(err)}`,
          status: "error",
          activity: "",
        };
        return updated;
      });
    } finally {
      setLoading(false);
      onVaultChanged();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendCommand();
    }
  }

  return (
    <div className="cmd-surface">
      <div className="cmd-canvas" ref={canvasRef}>
        {interactions.length === 0 && (
          <div className="cmd-empty">
            <div className="cmd-empty-icon">&#x276F;</div>
            <p className="cmd-empty-text">
              Standing by. What do you need?
            </p>
            <div className="cmd-empty-hints">
              <span className="cmd-hint">"what's on today?"</span>
              <span className="cmd-hint">"process my inbox"</span>
              <span className="cmd-hint">"what needs my attention?"</span>
            </div>
          </div>
        )}

        {interactions.map((ix, i) => (
          <div key={i} className="cmd-interaction">
            <div className="cmd-user">
              <span className="cmd-prompt">&#x276F;</span>
              <span className="cmd-user-text">{ix.command}</span>
            </div>

            {ix.status === "streaming" && !ix.response && (
              <ThinkingIndicator activity={ix.activity} startedAt={ix.startedAt} />
            )}

            {ix.response && <ResponseBlock interaction={ix} />}

            {i < interactions.length - 1 && <div className="cmd-separator" />}
          </div>
        ))}
      </div>

      <div className="cmd-bar">
        {hasStreamContent && (
          <div className="cmd-bar-status">
            <span className="cmd-bar-streaming">streaming</span>
          </div>
        )}
        <div className="cmd-bar-row">
          <div className="cmd-bar-input">
            <span className="cmd-bar-prompt">&#x276F;</span>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                loading ? "Waiting for response..." : "Ask something..."
              }
              rows={1}
              disabled={loading}
            />
          </div>
          {interactions.length > 0 && !loading && (
            <button
              className="cmd-bar-new secondary"
              onClick={newSession}
              title="Start a new conversation"
            >
              New
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
