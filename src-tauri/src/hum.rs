//! Hum — Anthropic API with tool use and streaming
//!
//! Reads vault context, defines tools for vault operations, implements
//! the full tool use loop, and streams responses via Tauri events.

use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const MODEL: &str = "claude-haiku-4-5-20251001";
const MAX_TOKENS: u32 = 8192;
const MAX_TOOL_ROUNDS: usize = 25;

/// Lean system prompt for Hum — contains only what's needed for daily operations.
/// Extended rules live in `.app/CLAUDE.md` and can be read on demand.
const HUM_PROMPT: &str = r#"# Hum — Vault Assistant

You are Hum, a personal assistant operating on a markdown vault. You have tools to read, write, append files, list directories, and fetch the calendar.

## Personality

- Concise and sharp. Lead with the answer, not the preamble.
- Dry wit when appropriate — never forced, never corny. Think Jarvis: competent with a light touch.
- One short contextual remark per response is enough. "Light day." or "That's a lot of open threads."
- Professional peer, not a servant. Confident, direct, occasionally opinionated.
- Never say "Great question!", "Hope that helps!", "Sure!", or any filler. Just deliver.
- When presenting schedules or summaries, add a brief human observation.
- The user is in Stockholm, Sweden.
- Keep responses short. If the answer is one sentence, don't write three.
- When you've completed an action, confirm briefly and mention what changed — don't narrate every step.

## Core Rules

- **Never rewrite the user's words.** Move content verbatim. Fix typos only.
- **Stay within the vault.** Read and write anywhere inside it. Nothing outside.
- **Be conversational.** The user talks in freeform. Figure out intent from context.

## Vault Structure

- `inbox/inbox.md` — single capture point
- `projects/work/<name>/` — work projects (each has `todos.md` + `notes/`)
- `projects/personal/<name>/` — personal projects (same structure)
- `projects/archive/` — inactive projects, don't scan unless asked
- `notes/` — standalone running-list notes (films, coffee, song tips, etc.)
- `notes/archive/` — retired notes
- `wiki/` — knowledge base / reference material
- `.app/` — app plumbing (dashboard, config, memory, assets). Hidden from the user; read only when needed.
  - `.app/dashboard.md` — static overview (regenerated deterministically)
  - `.app/claude-config.md` — active projects list, processing state
  - `.app/memory.md` — persistent memory across sessions
  - `.app/metadata/Assets/` — pasted/embedded images

## Inbox Processing

Inbox processing is a **two-phase** operation:

**Phase 1 (deterministic — use the `process_inbox` tool):**
Call `process_inbox` first. It resolves every `@tag` in this order:
1. **Project match** → routes todos → project's `todos.md`, notes → project's `notes/YYYY-MM-DD.md`.
2. **Existing note/wiki file match** (case-insensitive, hyphen/space equivalent) → appends content verbatim to that file.
3. **No match** → creates a new `notes/<tag>.md` and drops content in. The tag is respected exactly as typed (no renaming).

Returns a summary: `routed` (projects), `notes_routed` (note/wiki files, with `is_new`), and `untagged_remaining`.

**Phase 2 (your job — AI follow-up):**
After `process_inbox` returns:
1. Handle **untagged content** left in inbox — ask the user where it goes, don't guess.
2. If the user asked a question (e.g. "what's in my inbox?"), answer it.
3. Report what was done — short summary of routing.

Never manually route `@tagged` content with read/write/append — that's what `process_inbox` does.

If the user wants to **promote** a note to wiki (e.g. "move @restaurant-tips to wiki"), read the file, write a copy into `wiki/<tag>.md` with `type: wiki` in the frontmatter, and ask the user before deleting the source.

## Todo System

Todos are tracked by UUID in `.todo-index.json`. Each todo in `todos.md` has an HTML comment `<!-- id:xxxx -->` on its checkbox line. The deterministic system handles:
- UUID assignment (at inbox routing time)
- Index building (scanning all todos.md files)
- Dashboard regeneration
- Duplicate detection, staleness, reconciliation

**You do NOT need to:**
- Manually reconcile todos across files
- Stamp creation dates or UUIDs
- Regenerate the dashboard
- Detect duplicates or stale todos

**You CAN:**
- Read todos via the index or by reading todos.md files
- Create new todos (the system will stamp UUIDs on next index rebuild)
- Complete todos by checking them off with `✅ YYYY-MM-DD`

## Weekly Summary

When the user asks for a weekly summary (or "what did I do this week", etc.):
1. Call `get_weekly_summary` with the appropriate `week_offset` (0 = this week, -1 = last week)
2. Present the structured data conversationally, grouped by day
3. For each active day, list the project and what was completed / noted
4. Add a brief human observation at the end (busy week, quiet week, heavy on one project, etc.)
5. This is for timesheet reporting — focus on what was DONE, not what's still open
6. Do NOT scan the vault manually for this — the tool already gathers everything deterministically

## Dashboard

The dashboard is regenerated deterministically by the app after inbox processing or todo toggling. You do not need to regenerate it manually.

## Tagging

- `@projectname` in inbox = routing marker
- `#blocked`, `#waiting`, `#on-hold` on todos = exceptional status
- No priority tags, no type tags

## Output Format

Your output feeds a card renderer. Use these patterns so cards trigger correctly:
- Schedules: `- **HH:MM-HH:MM** — Title (Location)` (bulleted, bold times)
- Action reports: `**@project** — N todos to \`file.md\`` per project, summary footer line
- Todos: `- [ ]` / `- [x]` checkboxes under `### Project` headings
- Short confirmations: 1-2 plain lines
- Everything else: standard markdown
Put personality around the structured data, not instead of it.

## For detailed rules

If you need the full formatting spec or weekly summary format, use `read_file(".app/CLAUDE.md")`.
"#;

/* ═══════════════════════════════════════════════════════════════════
 * Tool definitions — what Claude can use
 * ═══════════════════════════════════════════════════════════════════ */

fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "read_file",
            "description": "Read the contents of a file in the vault. Use relative paths from the vault root (e.g. 'inbox/inbox.md', 'projects/work/my-project/todos.md').",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path from vault root"
                    }
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "write_file",
            "description": "Write content to a file in the vault (creates or overwrites). Automatically creates parent directories if they don't exist. Use for creating new files or replacing entire file contents. For adding content to an existing file, prefer append_file.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path from vault root"
                    },
                    "content": {
                        "type": "string",
                        "description": "Full file content to write"
                    }
                },
                "required": ["path", "content"]
            }
        }),
        json!({
            "name": "append_file",
            "description": "Append content to the end of an existing file in the vault. Creates the file if it doesn't exist.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path from vault root"
                    },
                    "content": {
                        "type": "string",
                        "description": "Content to append"
                    }
                },
                "required": ["path", "content"]
            }
        }),
        json!({
            "name": "list_directory",
            "description": "List files and subdirectories in a vault directory. Returns names with '/' suffix for directories.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path from vault root (use '' or '.' for root)"
                    }
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "create_directory",
            "description": "Create a directory (and any parent directories) in the vault. Use this when setting up new project structures. Example: 'create_directory(\"projects/work/my-project/notes\")' creates the full path.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path from vault root"
                    }
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "fetch_calendar",
            "description": "Fetch the user's work calendar for the current week. Returns JSON with events including title, date, day, start time, end time, location, and attendees. Times are in local Stockholm time (CET/CEST).",
            "input_schema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }),
        json!({
            "name": "process_inbox",
            "description": "Run the deterministic inbox processor. Instantly routes all @project-tagged content from inbox.md to the correct project files (todos.md, notes/date.md). Returns a JSON summary of what was routed, what's left untagged, and any unknown @tags. Always call this FIRST when the user asks to process the inbox — then handle the leftovers yourself.",
            "input_schema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }),
        json!({
            "name": "get_weekly_summary",
            "description": "Get a structured summary of what was done during a week. Returns per-day, per-project data: completed todos (with text) and whether notes were written. Use week_offset 0 for current week, -1 for last week, etc. Always call this FIRST when the user asks for a weekly summary — then present the data conversationally.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "week_offset": {
                        "type": "integer",
                        "description": "Week offset from current week. 0 = this week, -1 = last week, etc."
                    }
                },
                "required": ["week_offset"]
            }
        }),
    ]
}

/* ═══════════════════════════════════════════════════════════════════
 * Tool execution — sandboxed to the vault
 * ═══════════════════════════════════════════════════════════════════ */

/// Resolve a relative path to an absolute path within the vault.
/// Returns None if the resolved path escapes the vault (path traversal).
fn safe_resolve(vault: &Path, relative: &str) -> Option<PathBuf> {
    let cleaned = relative.replace('\\', "/");
    let cleaned = cleaned.trim_start_matches('/');
    let resolved = vault.join(cleaned);

    // Canonicalize what exists, then check prefix
    // For new files, canonicalize the parent
    let check_path = if resolved.exists() {
        resolved.canonicalize().ok()?
    } else {
        let parent = resolved.parent()?.canonicalize().ok()?;
        parent.join(resolved.file_name()?)
    };

    let vault_canon = vault.canonicalize().ok()?;
    if check_path.starts_with(&vault_canon) {
        Some(resolved)
    } else {
        None
    }
}

fn execute_tool(vault: &Path, name: &str, input: &Value) -> String {
    match name {
        "read_file" => {
            let path = input.get("path").and_then(|p| p.as_str()).unwrap_or("");
            match safe_resolve(vault, path) {
                Some(resolved) => match fs::read_to_string(&resolved) {
                    Ok(content) => content,
                    Err(e) => format!("Error reading file: {}", e),
                },
                None => format!("Error: path '{}' is outside the vault or invalid", path),
            }
        }
        "write_file" => {
            let path = input.get("path").and_then(|p| p.as_str()).unwrap_or("");
            let content = input.get("content").and_then(|c| c.as_str()).unwrap_or("");
            match safe_resolve(vault, path) {
                Some(resolved) => {
                    // Create parent directories if needed
                    if let Some(parent) = resolved.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    match fs::write(&resolved, content) {
                        Ok(()) => format!("Written {} bytes to {}", content.len(), path),
                        Err(e) => format!("Error writing file: {}", e),
                    }
                }
                None => format!("Error: path '{}' is outside the vault or invalid", path),
            }
        }
        "append_file" => {
            let path = input.get("path").and_then(|p| p.as_str()).unwrap_or("");
            let content = input.get("content").and_then(|c| c.as_str()).unwrap_or("");
            match safe_resolve(vault, path) {
                Some(resolved) => {
                    if let Some(parent) = resolved.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    let existing = fs::read_to_string(&resolved).unwrap_or_default();
                    let new_content = if existing.is_empty() {
                        content.to_string()
                    } else {
                        format!("{}\n{}", existing.trim_end(), content)
                    };
                    match fs::write(&resolved, new_content) {
                        Ok(()) => format!("Appended to {}", path),
                        Err(e) => format!("Error appending to file: {}", e),
                    }
                }
                None => format!("Error: path '{}' is outside the vault or invalid", path),
            }
        }
        "list_directory" => {
            let path = input.get("path").and_then(|p| p.as_str()).unwrap_or(".");
            let dir_path = if path.is_empty() || path == "." {
                vault.to_path_buf()
            } else {
                match safe_resolve(vault, path) {
                    Some(p) => p,
                    None => return format!("Error: path '{}' is outside the vault or invalid", path),
                }
            };
            match fs::read_dir(&dir_path) {
                Ok(entries) => {
                    let mut items: Vec<String> = entries
                        .filter_map(|e| e.ok())
                        .map(|e| {
                            let name = e.file_name().to_string_lossy().to_string();
                            if e.path().is_dir() {
                                format!("{}/", name)
                            } else {
                                name
                            }
                        })
                        .collect();
                    items.sort();
                    items.join("\n")
                }
                Err(e) => format!("Error listing directory: {}", e),
            }
        }
        "create_directory" => {
            let path = input.get("path").and_then(|p| p.as_str()).unwrap_or("");
            match safe_resolve(vault, path) {
                Some(resolved) => match fs::create_dir_all(&resolved) {
                    Ok(()) => format!("Created directory: {}", path),
                    Err(e) => format!("Error creating directory: {}", e),
                },
                None => format!("Error: path '{}' is outside the vault or invalid", path),
            }
        }
        "process_inbox" => {
            match crate::inbox::process(Some(vault.to_path_buf())) {
                Ok(result) => serde_json::to_string_pretty(&result).unwrap_or_else(|e| format!("Serialization error: {}", e)),
                Err(e) => format!("Inbox processing failed: {}", e),
            }
        }
        "get_weekly_summary" => {
            let week_offset = input.get("week_offset")
                .and_then(|v| v.as_i64())
                .unwrap_or(0) as i32;
            match crate::get_weekly_summary(week_offset) {
                Ok(summary) => serde_json::to_string_pretty(&summary)
                    .unwrap_or_else(|e| format!("Serialization error: {}", e)),
                Err(e) => format!("Weekly summary failed: {}", e),
            }
        }
        "fetch_calendar" => {
            let skill_dir = vault.join(".app").join("skills").join("check-calendar");
            let script = skill_dir.join("fetch_calendar.py");
            let py_win = skill_dir.join(".venv").join("Scripts").join("python.exe");
            let py_unix = skill_dir.join(".venv").join("bin").join("python");

            let python = if py_win.exists() {
                py_win
            } else if py_unix.exists() {
                py_unix
            } else {
                return "Calendar venv not found.".to_string();
            };

            #[cfg(target_os = "windows")]
            let output = {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                std::process::Command::new(&python)
                    .arg(&script)
                    .creation_flags(CREATE_NO_WINDOW)
                    .output()
            };

            #[cfg(not(target_os = "windows"))]
            let output = std::process::Command::new(&python).arg(&script).output();

            match output {
                Ok(o) if o.status.success() => {
                    String::from_utf8_lossy(&o.stdout).to_string()
                }
                Ok(o) => format!("Calendar script failed: {}", String::from_utf8_lossy(&o.stderr)),
                Err(e) => format!("Failed to run calendar script: {}", e),
            }
        }
        _ => format!("Unknown tool: {}", name),
    }
}

/* ═══════════════════════════════════════════════════════════════════
 * System prompt builder
 * ═══════════════════════════════════════════════════════════════════ */

fn build_system_prompt(_vault: &Path) -> String {
    let mut prompt = String::new();

    // Current date/time so Claude knows "today" and "tomorrow"
    let now = chrono::Local::now();
    prompt.push_str(&format!(
        "Current date and time: {} ({})\n\n",
        now.format("%Y-%m-%d %H:%M"),
        now.format("%A")
    ));

    // Lean Hum-specific prompt (replaces full CLAUDE.md)
    prompt.push_str(HUM_PROMPT);

    prompt
}

/* ═══════════════════════════════════════════════════════════════════
 * API types
 * ═══════════════════════════════════════════════════════════════════ */

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: Value, // Can be string or array of content blocks
}

#[derive(Debug, Serialize)]
struct ApiRequest {
    model: String,
    max_tokens: u32,
    system: String,
    messages: Vec<ChatMessage>,
    tools: Vec<Value>,
    stream: bool,
}

/* ═══════════════════════════════════════════════════════════════════
 * SSE streaming parser
 * ═══════════════════════════════════════════════════════════════════ */

/// Stream an API response, collecting content blocks.
/// Only emits text deltas to the frontend when `emit_text` is true.
async fn stream_response(
    client: &Client,
    api_key: &str,
    request: &ApiRequest,
    app: &AppHandle,
    emit_text: bool,
) -> Result<(Vec<Value>, String), String> {
    let response = client
        .post(API_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(request)
        .send()
        .await
        .map_err(|e| format!("API request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("API error {}: {}", status, body));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut content_blocks: Vec<Value> = Vec::new();
    let mut current_block_type: Option<String> = None;
    let mut current_tool_name: Option<String> = None;
    let mut current_tool_id: Option<String> = None;
    let mut current_tool_input = String::new();
    let mut stop_reason = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream error: {}", e))?;
        let text = String::from_utf8_lossy(&chunk);
        buffer.push_str(&text);

        while let Some(pos) = buffer.find("\n\n") {
            let event_block = buffer[..pos].to_string();
            buffer = buffer[pos + 2..].to_string();

            for line in event_block.lines() {
                if let Some(data) = line.strip_prefix("data: ") {
                    if data == "[DONE]" {
                        return Ok((content_blocks, stop_reason));
                    }

                    if let Ok(event) = serde_json::from_str::<Value>(data) {
                        let event_type = event.get("type").and_then(|t| t.as_str());

                        match event_type {
                            Some("content_block_start") => {
                                if let Some(block) = event.get("content_block") {
                                    let btype = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                    current_block_type = Some(btype.to_string());

                                    if btype == "tool_use" {
                                        current_tool_name = block.get("name").and_then(|n| n.as_str()).map(|s| s.to_string());
                                        current_tool_id = block.get("id").and_then(|i| i.as_str()).map(|s| s.to_string());
                                        current_tool_input.clear();

                                        // Emit activity
                                        if let Some(ref name) = current_tool_name {
                                            let _ = app.emit("hum:activity", format!("using {}", name));
                                        }
                                    }
                                }
                            }
                            Some("content_block_delta") => {
                                if let Some(delta) = event.get("delta") {
                                    let delta_type = delta.get("type").and_then(|t| t.as_str()).unwrap_or("");

                                    if delta_type == "text_delta" {
                                        if emit_text {
                                            if let Some(text) = delta.get("text").and_then(|t| t.as_str()) {
                                                let _ = app.emit("hum:chunk", text.to_string());
                                            }
                                        }
                                    } else if delta_type == "input_json_delta" {
                                        if let Some(json_part) = delta.get("partial_json").and_then(|j| j.as_str()) {
                                            current_tool_input.push_str(json_part);
                                        }
                                    }
                                }
                            }
                            Some("content_block_stop") => {
                                if current_block_type.as_deref() == Some("tool_use") {
                                    let input: Value = serde_json::from_str(&current_tool_input)
                                        .unwrap_or(json!({}));
                                    content_blocks.push(json!({
                                        "type": "tool_use",
                                        "id": current_tool_id,
                                        "name": current_tool_name,
                                        "input": input,
                                    }));
                                } else if current_block_type.as_deref() == Some("text") {
                                    // Text blocks are already streamed via deltas
                                }
                                current_block_type = None;
                                current_tool_name = None;
                                current_tool_id = None;
                                current_tool_input.clear();
                            }
                            Some("message_delta") => {
                                if let Some(delta) = event.get("delta") {
                                    if let Some(sr) = delta.get("stop_reason").and_then(|s| s.as_str()) {
                                        stop_reason = sr.to_string();
                                    }
                                }
                            }
                            Some("message_stop") => {
                                return Ok((content_blocks, stop_reason));
                            }
                            Some("error") => {
                                let msg = event.get("error")
                                    .and_then(|e| e.get("message"))
                                    .and_then(|m| m.as_str())
                                    .unwrap_or("Unknown API error");
                                return Err(msg.to_string());
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    }

    Ok((content_blocks, stop_reason))
}

/* ═══════════════════════════════════════════════════════════════════
 * Main command — the tool use loop
 * ═══════════════════════════════════════════════════════════════════ */

#[tauri::command]
pub async fn hum_send(
    app: AppHandle,
    messages: Vec<ChatMessage>,
    vault_path: String,
) -> Result<(), String> {
    let api_key = std::env::var("ANTHROPIC_API_KEY")
        .map_err(|_| "ANTHROPIC_API_KEY not set. Add it to .env in the project root.".to_string())?;

    let vault = PathBuf::from(&vault_path);
    let system_prompt = build_system_prompt(&vault);
    let tools = tool_definitions();
    let client = Client::new();

    let mut conversation: Vec<ChatMessage> = messages;
    let mut rounds = 0;

    loop {
        rounds += 1;
        if rounds > MAX_TOOL_ROUNDS {
            let _ = app.emit("hum:error", "Too many tool use rounds — something went wrong.".to_string());
            return Err("Exceeded max tool use rounds".to_string());
        }

        let request = ApiRequest {
            model: MODEL.to_string(),
            max_tokens: MAX_TOKENS,
            system: system_prompt.clone(),
            messages: conversation.clone(),
            tools: tools.clone(),
            stream: true,
        };

        // Always stream text to the frontend
        let (content_blocks, stop_reason) = match stream_response(&client, &api_key, &request, &app, true).await {
            Ok(result) => result,
            Err(e) => {
                let _ = app.emit("hum:error", e.clone());
                return Err(e);
            }
        };

        // If no tool use, this was the final round — we're done
        if stop_reason != "tool_use" || content_blocks.is_empty() {
            let _ = app.emit("hum:done", ());
            return Ok(());
        }

        // Tool use round — clear the intermediate thinking text from the UI
        // so the user only sees activity indicators, not Claude's reasoning
        let _ = app.emit("hum:clear", ());

        // Build the assistant message with all content blocks (text + tool_use)
        // We need to reconstruct the full content array including any text blocks
        let mut assistant_content: Vec<Value> = Vec::new();

        // Collect text that was streamed and any tool_use blocks
        for block in &content_blocks {
            assistant_content.push(block.clone());
        }

        // If there were text deltas but no explicit text block in content_blocks,
        // the text was already streamed. We still need to add it to the conversation
        // for context, but the streaming already handled the UI.

        conversation.push(ChatMessage {
            role: "assistant".to_string(),
            content: json!(assistant_content),
        });

        // Execute each tool and build tool_result messages
        let mut tool_results: Vec<Value> = Vec::new();

        for block in &content_blocks {
            if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                let tool_id = block.get("id").and_then(|i| i.as_str()).unwrap_or("");
                let tool_name = block.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let empty = json!({});
                let tool_input = block.get("input").unwrap_or(&empty);

                // Emit activity for the UI
                let activity_msg = match tool_name {
                    "read_file" => format!("reading {}", tool_input.get("path").and_then(|p| p.as_str()).unwrap_or("file")),
                    "write_file" => format!("writing {}", tool_input.get("path").and_then(|p| p.as_str()).unwrap_or("file")),
                    "append_file" => format!("updating {}", tool_input.get("path").and_then(|p| p.as_str()).unwrap_or("file")),
                    "create_directory" => format!("creating {}", tool_input.get("path").and_then(|p| p.as_str()).unwrap_or("folder")),
                    "list_directory" => format!("scanning {}", tool_input.get("path").and_then(|p| p.as_str()).unwrap_or("vault")),
                    "process_inbox" => "processing inbox".to_string(),
                    "fetch_calendar" => "checking calendar".to_string(),
                    _ => format!("using {}", tool_name),
                };
                let _ = app.emit("hum:activity", activity_msg);

                let result = execute_tool(&vault, tool_name, tool_input);

                tool_results.push(json!({
                    "type": "tool_result",
                    "tool_use_id": tool_id,
                    "content": result,
                }));
            }
        }

        // Add tool results as a user message
        conversation.push(ChatMessage {
            role: "user".to_string(),
            content: json!(tool_results),
        });

        // Loop continues — Claude will process the tool results and either
        // call more tools or give a final text response
    }
}


