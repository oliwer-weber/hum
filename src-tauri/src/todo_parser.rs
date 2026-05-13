// Block-aware todo parser — treats a todo as the checkbox line plus its prose
// continuation, plus any nested sub-tasks (checkboxes at deeper indent). This
// is the single source of truth for parsing todos across the entire app.

use serde::{Deserialize, Serialize};

/// A single todo block: the checkbox line + indented prose continuation +
/// any nested sub-tasks (recursively).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoBlock {
    /// The todo headline text (without checkbox prefix, without HTML comment tags)
    pub text: String,
    /// Continuation prose joined with newlines (empty if none). Sub-tasks are
    /// NOT included here — they live in `subtasks`.
    pub body: String,
    /// Raw lines owned by THIS block only: the checkbox line plus any prose
    /// body lines collected before the first sub-task appears. Used to write
    /// the block back to disk; sub-task lines come from each sub-task's own
    /// `raw_lines` during tree serialization.
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
    /// Total lines this block occupies in source, INCLUDING all sub-task lines
    pub line_count: usize,
    /// Nested sub-tasks parsed from deeper-indented checkboxes
    #[serde(default)]
    pub subtasks: Vec<TodoBlock>,
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

/// Indent width of a line (count of leading whitespace bytes).
fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// Is this trimmed line the start of a checkbox?
fn is_checkbox_trimmed(trimmed: &str) -> bool {
    trimmed.starts_with("- [ ] ")
        || trimmed.starts_with("- [x] ")
        || trimmed == "- [ ]"
        || trimmed == "- [x]"
}

/// Parse a single TodoBlock starting at `start_idx`. Returns the block plus
/// the index of the first line that does NOT belong to this block.
fn parse_block_at(lines: &[&str], start_idx: usize) -> Option<(TodoBlock, usize)> {
    let line = lines[start_idx];
    let trimmed = line.trim();
    if !is_checkbox_trimmed(trimmed) {
        return None;
    }

    let checked = trimmed.starts_with("- [x]");
    let base_indent = indent_of(line);
    let checkbox_line = line.to_string();

    let prefix = if checked { "- [x] " } else { "- [ ] " };
    let raw_text = if trimmed.len() > prefix.len() {
        trimmed[prefix.len()..].to_string()
    } else {
        String::new()
    };

    let id = extract_id(&checkbox_line);
    let created = extract_created(&checkbox_line);
    let completed = extract_completed(&checkbox_line);
    let tags = extract_tags(&raw_text);
    let text = clean_text(&raw_text);

    let line_number = start_idx + 1; // 1-based
    let mut own_raw_lines: Vec<String> = vec![checkbox_line];
    let mut body_lines: Vec<String> = Vec::new();
    let mut subtasks: Vec<TodoBlock> = Vec::new();
    // Once we've absorbed a sub-task, further prose at our indent ends the
    // block — preserving file order during serialization would otherwise
    // require interleaving own_raw_lines with subtask output.
    let mut in_prose_phase = true;

    let mut j = start_idx + 1;
    while j < lines.len() {
        let next = lines[j];
        let next_trimmed = next.trim();

        // Blank line: keep absorbing while in prose phase and there's still
        // content deeper than our base indent ahead. Otherwise, end the block.
        if next_trimmed.is_empty() {
            if !in_prose_phase {
                break;
            }
            if j + 1 < lines.len() {
                let look = lines[j + 1];
                if !look.trim().is_empty() && indent_of(look) > base_indent {
                    body_lines.push(String::new());
                    own_raw_lines.push(next.to_string());
                    j += 1;
                    continue;
                }
            }
            break;
        }

        let next_indent = indent_of(next);

        // Same or lower indent than our checkbox = out of our scope
        if next_indent <= base_indent {
            break;
        }

        // Deeper checkbox = sub-task, recurse
        if is_checkbox_trimmed(next_trimmed) {
            if let Some((sub, new_end)) = parse_block_at(lines, j) {
                subtasks.push(sub);
                j = new_end;
                in_prose_phase = false;
                continue;
            }
        }

        // Deeper non-checkbox: prose body (only while still in prose phase).
        // Strip leading whitespace and, if present, a `- ` bullet marker so
        // bodies render as clean prose regardless of whether the user wrote
        // an indented bullet or plain indented text.
        if in_prose_phase {
            let trimmed_start = next.trim_start();
            let stripped: String = if let Some(rest) = trimmed_start.strip_prefix("- ") {
                rest.to_string()
            } else if trimmed_start == "-" {
                String::new()
            } else {
                trimmed_start.to_string()
            };
            body_lines.push(stripped);
            own_raw_lines.push(next.to_string());
            j += 1;
        } else {
            // Prose appearing after sub-tasks within our scope. Uncommon —
            // we end the block here rather than try to preserve interleaving.
            break;
        }
    }

    let line_count = j - start_idx;
    let body = body_lines.join("\n").trim_end().to_string();

    Some((
        TodoBlock {
            text,
            body,
            raw_lines: own_raw_lines,
            checked,
            id,
            created,
            completed,
            tags,
            line_number,
            line_count,
            subtasks,
        },
        j,
    ))
}

/// Parse a string (typically the contents of a todos.md file) into a flat list
/// of top-level TodoBlocks. Each block may carry nested sub-tasks in its
/// `subtasks` field.
pub fn parse_todo_blocks(content: &str) -> Vec<TodoBlock> {
    let lines: Vec<&str> = content.lines().collect();
    let mut blocks: Vec<TodoBlock> = Vec::new();
    let mut i = 0;

    while i < lines.len() {
        let trimmed = lines[i].trim();
        if is_checkbox_trimmed(trimmed) {
            if let Some((block, new_end)) = parse_block_at(&lines, i) {
                blocks.push(block);
                i = new_end;
                continue;
            }
        }
        i += 1;
    }

    blocks
}

/// Reconstruct raw markdown from a TodoBlock, recursing into sub-tasks so the
/// emitted lines match the on-disk order: own lines first, then each sub-task's
/// own serialization in turn.
pub fn block_to_markdown(block: &TodoBlock) -> String {
    let mut out: Vec<String> = block.raw_lines.clone();
    for sub in &block.subtasks {
        out.push(block_to_markdown(sub));
    }
    out.join("\n")
}

/// Walk a block tree in document order (parent before children, depth-first).
pub fn walk_blocks<'a>(block: &'a TodoBlock, out: &mut Vec<&'a TodoBlock>) {
    out.push(block);
    for sub in &block.subtasks {
        walk_blocks(sub, out);
    }
}

/// Flatten a forest into all blocks (parents and sub-tasks) in document order.
pub fn flatten_blocks(blocks: &[TodoBlock]) -> Vec<&TodoBlock> {
    let mut out = Vec::new();
    for b in blocks {
        walk_blocks(b, &mut out);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_line_todo() {
        let content = "- [ ] Fix auth flow <!-- id:abc123 --> <!-- created:2026-04-10 -->\n";
        let blocks = parse_todo_blocks(content);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].text, "Fix auth flow");
        assert_eq!(blocks[0].id, Some("abc123".to_string()));
        assert_eq!(blocks[0].created, Some("2026-04-10".to_string()));
        assert!(!blocks[0].checked);
        assert!(blocks[0].body.is_empty());
        assert!(blocks[0].subtasks.is_empty());
        assert_eq!(blocks[0].line_count, 1);
    }

    #[test]
    fn multiline_prose_body() {
        let content = "- [ ] Snacka med person A ang X\n  (kom ihåg att bla bla bla)\n  och ytterligare en rad\n";
        let blocks = parse_todo_blocks(content);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].text, "Snacka med person A ang X");
        assert_eq!(
            blocks[0].body,
            "(kom ihåg att bla bla bla)\noch ytterligare en rad"
        );
        assert_eq!(blocks[0].line_count, 3);
        assert!(blocks[0].subtasks.is_empty());
    }

    #[test]
    fn it_todo_with_tab_indented_body() {
        // The real IT/todos.md case: tab-indented bullet under a completed
        // checkbox. The leading "- " is part of the prose, not a sub-task,
        // because it lacks the [ ]/[x] checkbox marker.
        let content = "- [x] Sätt upp organisationskonton för Supabase och Vercel ✅ 2026-04-08 <!-- id:20cdfc55 -->\n\t- skapde med it@modgroup för båda. (\"mitt lösen\" för supabase och email verification för vercel)\n";
        let blocks = parse_todo_blocks(content);
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].checked);
        assert_eq!(blocks[0].id.as_deref(), Some("20cdfc55"));
        assert_eq!(blocks[0].completed.as_deref(), Some("2026-04-08"));
        assert_eq!(
            blocks[0].body,
            "skapde med it@modgroup för båda. (\"mitt lösen\" för supabase och email verification för vercel)"
        );
        assert!(blocks[0].subtasks.is_empty());
    }

    #[test]
    fn nested_subtasks() {
        let content = "- [ ] parent\n\t- [ ] sub1\n\t- [x] sub2 ✅ 2026-05-01\n";
        let blocks = parse_todo_blocks(content);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].text, "parent");
        assert_eq!(blocks[0].subtasks.len(), 2);
        assert_eq!(blocks[0].subtasks[0].text, "sub1");
        assert!(!blocks[0].subtasks[0].checked);
        assert_eq!(blocks[0].subtasks[1].text, "sub2");
        assert!(blocks[0].subtasks[1].checked);
        assert_eq!(blocks[0].subtasks[1].completed.as_deref(), Some("2026-05-01"));
        assert_eq!(blocks[0].line_count, 3);
    }

    #[test]
    fn body_then_subtasks() {
        let content = "- [ ] parent\n\tprose for parent\n\t- [ ] sub1\n\t\tprose for sub1\n";
        let blocks = parse_todo_blocks(content);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].body, "prose for parent");
        assert_eq!(blocks[0].subtasks.len(), 1);
        assert_eq!(blocks[0].subtasks[0].text, "sub1");
        assert_eq!(blocks[0].subtasks[0].body, "prose for sub1");
        assert_eq!(blocks[0].line_count, 4);
    }

    #[test]
    fn round_trip_preserves_bytes_for_nested_case() {
        let content = "- [ ] parent\n\tprose\n\t- [ ] sub1\n\t- [x] sub2 ✅ 2026-05-01";
        let blocks = parse_todo_blocks(content);
        assert_eq!(blocks.len(), 1);
        let serialized = block_to_markdown(&blocks[0]);
        assert_eq!(serialized, content);
    }

    #[test]
    fn two_top_level_todos() {
        let content = "- [ ] First todo\n- [ ] Second todo\n";
        let blocks = parse_todo_blocks(content);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].text, "First todo");
        assert_eq!(blocks[1].text, "Second todo");
    }

    #[test]
    fn checked_with_completion() {
        let content = "- [x] Done thing ✅ 2026-04-01\n";
        let blocks = parse_todo_blocks(content);
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].checked);
        assert_eq!(blocks[0].text, "Done thing");
        assert_eq!(blocks[0].completed, Some("2026-04-01".to_string()));
    }

    #[test]
    fn tags_extracted() {
        let content = "- [ ] Fix thing #blocked <!-- created:2026-04-10 -->\n";
        let blocks = parse_todo_blocks(content);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].tags, vec!["#blocked"]);
    }

    #[test]
    fn blank_line_ends_block_when_followed_by_sibling() {
        let content = "- [ ] First\n  detail\n\n- [ ] Second\n";
        let blocks = parse_todo_blocks(content);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].body, "detail");
        assert!(blocks[1].body.is_empty());
    }

    #[test]
    fn flatten_walks_in_document_order() {
        let content = "- [ ] parent\n\t- [ ] sub1\n\t- [ ] sub2\n- [ ] other\n";
        let blocks = parse_todo_blocks(content);
        let flat = flatten_blocks(&blocks);
        let texts: Vec<&str> = flat.iter().map(|b| b.text.as_str()).collect();
        assert_eq!(texts, vec!["parent", "sub1", "sub2", "other"]);
    }
}
