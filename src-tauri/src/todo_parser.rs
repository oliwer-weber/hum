// Block-aware todo parser — treats a todo as the checkbox line plus all
// continuation lines (indented content below it). This is the single source
// of truth for parsing todos across the entire app.

use serde::{Deserialize, Serialize};

/// A single todo block: the checkbox line + any indented continuation lines.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoBlock {
    /// The todo headline text (without checkbox prefix, without HTML comment tags)
    pub text: String,
    /// Continuation body lines joined with newlines (empty string if none)
    pub body: String,
    /// Full raw lines including the checkbox prefix and all continuations
    pub raw_lines: Vec<String>,
    /// Whether the todo is checked
    pub checked: bool,
    /// UUID if stamped (from `<!-- id:xxx -->`)
    pub id: Option<String>,
    /// Creation date if stamped (from `<!-- created:YYYY-MM-DD -->`)
    pub created: Option<String>,
    /// Completion date if stamped (from `✅ YYYY-MM-DD`)
    pub completed: Option<String>,
    /// Status tags (#blocked, #waiting, #on-hold)
    pub tags: Vec<String>,
    /// 1-based line number of the checkbox line in the source file
    pub line_number: usize,
    /// Number of lines this block spans
    pub line_count: usize,
}

/// Extract the UUID from an HTML comment like `<!-- id:abc123 -->`
fn extract_id(line: &str) -> Option<String> {
    let start = line.find("<!-- id:")?;
    let after = &line[start + "<!-- id:".len()..];
    // Stop at whitespace or --> (id is a single token)
    let id: String = after.chars()
        .take_while(|c| !c.is_whitespace() && *c != '-')
        .collect();
    let id = id.trim().to_string();
    if id.is_empty() { None } else { Some(id) }
}

/// Extract the creation date from `<!-- created:YYYY-MM-DD -->`
fn extract_created(line: &str) -> Option<String> {
    let start = line.find("<!-- created:")?;
    let after = &line[start + "<!-- created:".len()..];
    let end = after.find("-->")?;
    let date = after[..end].trim().to_string();
    if date.is_empty() { None } else { Some(date) }
}

/// Extract completion date from `✅ YYYY-MM-DD`
fn extract_completed(line: &str) -> Option<String> {
    let start = line.find("✅ ")?;
    let after = &line[start + "✅ ".len()..];
    // Take the next 10 chars (YYYY-MM-DD)
    if after.len() >= 10 {
        let date = &after[..10];
        // Validate it looks like a date
        if date.chars().nth(4) == Some('-') && date.chars().nth(7) == Some('-') {
            return Some(date.to_string());
        }
    }
    None
}

/// Extract status tags from todo text
fn extract_tags(text: &str) -> Vec<String> {
    let mut tags = Vec::new();
    for tag in &["#blocked", "#waiting", "#on-hold"] {
        if text.contains(tag) {
            tags.push(tag.to_string());
        }
    }
    tags
}

/// Clean display text: strip HTML comments and completion stamps
fn clean_text(raw_text: &str) -> String {
    let mut text = raw_text.to_string();

    // Remove <!-- id:... -->
    while let Some(start) = text.find("<!-- id:") {
        if let Some(end) = text[start..].find("-->") {
            text = format!("{}{}", &text[..start], &text[start + end + 3..]);
        } else {
            break;
        }
    }

    // Remove <!-- created:... -->
    while let Some(start) = text.find("<!-- created:") {
        if let Some(end) = text[start..].find("-->") {
            text = format!("{}{}", &text[..start], &text[start + end + 3..]);
        } else {
            break;
        }
    }

    // Remove ✅ YYYY-MM-DD
    if let Some(start) = text.find("✅") {
        // Take everything before the checkmark, trimmed
        text = text[..start].to_string();
    }

    text.trim().to_string()
}

/// Determine if a line is a continuation of the previous todo block.
/// A continuation is any line that is indented (starts with spaces/tab)
/// and is NOT a new checkbox item at the base indent level.
fn is_continuation(line: &str, base_indent: usize) -> bool {
    if line.trim().is_empty() {
        // Blank lines within an indented block are continuations,
        // but we handle them specially — see parse_todo_blocks
        return false; // handled by blank-line logic in parser
    }

    let line_indent = line.len() - line.trim_start().len();

    // If indented more than the checkbox line, it's a continuation
    if line_indent > base_indent {
        return true;
    }

    false
}

/// Parse a string (typically the contents of a todos.md file) into TodoBlocks.
pub fn parse_todo_blocks(content: &str) -> Vec<TodoBlock> {
    let lines: Vec<&str> = content.lines().collect();
    let mut blocks: Vec<TodoBlock> = Vec::new();
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();

        // Detect a checkbox line
        if trimmed.starts_with("- [ ] ") || trimmed.starts_with("- [x] ") || trimmed == "- [ ]" || trimmed == "- [x]" {
            let checked = trimmed.starts_with("- [x]");
            let base_indent = line.len() - line.trim_start().len();
            let checkbox_line = line.to_string();

            // Extract the text after the checkbox prefix
            let prefix = if checked { "- [x] " } else { "- [ ] " };
            let raw_text = if trimmed.len() > prefix.len() {
                trimmed[prefix.len()..].to_string()
            } else {
                // Handle "- [ ]" with no text after
                String::new()
            };

            let id = extract_id(&checkbox_line);
            let created = extract_created(&checkbox_line);
            let completed = extract_completed(&checkbox_line);
            let tags = extract_tags(&raw_text);
            let text = clean_text(&raw_text);

            let line_number = i + 1; // 1-based
            let mut raw_lines = vec![checkbox_line];
            let mut body_lines: Vec<String> = Vec::new();

            // Collect continuation lines
            let mut j = i + 1;
            while j < lines.len() {
                let next = lines[j];
                let next_trimmed = next.trim();

                // A blank line: include it if the line after is still indented (part of block)
                if next_trimmed.is_empty() {
                    // Peek ahead
                    if j + 1 < lines.len() && is_continuation(lines[j + 1], base_indent) {
                        body_lines.push(String::new());
                        raw_lines.push(next.to_string());
                        j += 1;
                        continue;
                    } else {
                        // Blank line followed by non-continuation = end of block
                        break;
                    }
                }

                // New checkbox at same or lower indent = new todo, end of block
                if (next_trimmed.starts_with("- [ ]") || next_trimmed.starts_with("- [x]"))
                    && (next.len() - next.trim_start().len()) <= base_indent
                {
                    break;
                }

                // Indented continuation
                if is_continuation(next, base_indent) {
                    // Strip the base indent + 2 for display, but keep raw
                    let stripped = if next.len() > base_indent + 2 {
                        &next[base_indent + 2..]
                    } else {
                        next.trim_start()
                    };
                    body_lines.push(stripped.to_string());
                    raw_lines.push(next.to_string());
                    j += 1;
                    continue;
                }

                // Non-indented, non-checkbox line = end of block
                break;
            }

            let line_count = raw_lines.len();
            let body = body_lines.join("\n").trim_end().to_string();

            blocks.push(TodoBlock {
                text,
                body,
                raw_lines,
                checked,
                id,
                created,
                completed,
                tags,
                line_number,
                line_count,
            });

            i = j;
        } else {
            i += 1;
        }
    }

    blocks
}

/// Reconstruct raw markdown from a TodoBlock (for writing back to file)
pub fn block_to_markdown(block: &TodoBlock) -> String {
    block.raw_lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_single_line_todo() {
        let content = "- [ ] Fix auth flow <!-- id:abc123 --> <!-- created:2026-04-10 -->\n";
        let blocks = parse_todo_blocks(content);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].text, "Fix auth flow");
        assert_eq!(blocks[0].id, Some("abc123".to_string()));
        assert_eq!(blocks[0].created, Some("2026-04-10".to_string()));
        assert!(!blocks[0].checked);
        assert!(blocks[0].body.is_empty());
    }

    #[test]
    fn test_multiline_todo() {
        let content = "- [ ] Snacka med person A ang X\n  (kom ihåg att bla bla bla)\n  - viktigt punkt 1\n";
        let blocks = parse_todo_blocks(content);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].text, "Snacka med person A ang X");
        assert_eq!(blocks[0].body, "(kom ihåg att bla bla bla)\n- viktigt punkt 1");
        assert_eq!(blocks[0].line_count, 3);
    }

    #[test]
    fn test_two_todos_no_continuation() {
        let content = "- [ ] First todo\n- [ ] Second todo\n";
        let blocks = parse_todo_blocks(content);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].text, "First todo");
        assert_eq!(blocks[1].text, "Second todo");
    }

    #[test]
    fn test_checked_with_completion() {
        let content = "- [x] Done thing ✅ 2026-04-01\n";
        let blocks = parse_todo_blocks(content);
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].checked);
        assert_eq!(blocks[0].text, "Done thing");
        assert_eq!(blocks[0].completed, Some("2026-04-01".to_string()));
    }

    #[test]
    fn test_tags_extracted() {
        let content = "- [ ] Fix thing #blocked <!-- created:2026-04-10 -->\n";
        let blocks = parse_todo_blocks(content);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].tags, vec!["#blocked"]);
    }

    #[test]
    fn test_blank_line_ends_block() {
        let content = "- [ ] First\n  detail\n\n- [ ] Second\n";
        let blocks = parse_todo_blocks(content);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].body, "detail");
        assert!(blocks[1].body.is_empty());
    }

    #[test]
    fn test_no_id_or_created() {
        let content = "- [ ] Plain todo without any tags\n";
        let blocks = parse_todo_blocks(content);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].id, None);
        assert_eq!(blocks[0].created, None);
        assert_eq!(blocks[0].text, "Plain todo without any tags");
    }
}
