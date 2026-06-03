// Id-keyed todo operations — the single place that mutates a todo's markdown.
// Each function is pure: it takes the raw contents of a todos.md file and a
// todo's UUID, and returns the new contents. The Tauri command wrappers in
// lib.rs handle reading/writing files and rebuilding the index; keeping the
// edits pure here makes them straightforward to unit-test.
//
// The markdown file remains the source of truth. These operations do surgical
// line edits by UUID (not line number, which drifts) so any UI surface can act
// on a todo as long as it knows the id.

use once_cell::sync::Lazy;
use regex::Regex;

use crate::todo_parser;

/// The status tags a todo can carry. `Clear` removes any status tag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusChange {
    Blocked,
    Waiting,
    OnHold,
    Clear,
}

impl StatusChange {
    /// Parse the status string sent from the frontend.
    pub fn parse(s: &str) -> Result<StatusChange, String> {
        match s {
            "blocked" => Ok(StatusChange::Blocked),
            "waiting" => Ok(StatusChange::Waiting),
            "on-hold" => Ok(StatusChange::OnHold),
            "" | "clear" | "none" => Ok(StatusChange::Clear),
            other => Err(format!("Unknown status: {}", other)),
        }
    }

    /// The hashtag text (without the leading `#`) this status writes, or None
    /// for `Clear`.
    fn tag(self) -> Option<&'static str> {
        match self {
            StatusChange::Blocked => Some("blocked"),
            StatusChange::Waiting => Some("waiting"),
            StatusChange::OnHold => Some("on-hold"),
            StatusChange::Clear => None,
        }
    }
}

/// Matches a status hashtag plus the single whitespace in front of it, so
/// removal doesn't leave a double space behind.
static STATUS_TAG_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\s*#(?:blocked|waiting|on-hold)\b").unwrap());

/// Locate the (1-based line number, line count) of the block with `id` across
/// the full tree (top-level + nested sub-tasks).
fn find_span(content: &str, id: &str) -> Option<(usize, usize)> {
    let blocks = todo_parser::parse_todo_blocks(content);
    let flat = todo_parser::flatten_blocks(&blocks);
    flat.into_iter()
        .find(|b| b.id.as_deref() == Some(id))
        .map(|b| (b.line_number, b.line_count))
}

/// Re-join lines, restoring a trailing newline if the original had one.
fn join_preserving_trailing(content: &str, lines: &[String]) -> String {
    let result = lines.join("\n");
    if content.ends_with('\n') && !result.ends_with('\n') {
        result + "\n"
    } else {
        result
    }
}

/// Rewrite a checkbox line so it carries exactly the requested status tag (or
/// none). Existing status tags are stripped first; the new tag is inserted
/// after the headline text but before any HTML comments or the ✅ completion
/// stamp, so the line stays tidy and the markers keep parsing.
fn rewrite_status_line(line: &str, change: StatusChange) -> String {
    let stripped = STATUS_TAG_RE.replace_all(line, "").to_string();

    let Some(tag) = change.tag() else {
        return stripped;
    };

    // Insert before the earliest trailing marker (` <!--` or ` ✅`) if present.
    let marker = [" <!--", " ✅"]
        .iter()
        .filter_map(|m| stripped.find(m))
        .min();

    match marker {
        Some(idx) => {
            let left = stripped[..idx].trim_end();
            let right = &stripped[idx..];
            format!("{} #{}{}", left, tag, right)
        }
        None => format!("{} #{}", stripped.trim_end(), tag),
    }
}

/// Set (or clear) a todo's status tag. Only the checkbox line is touched.
pub fn apply_status(content: &str, id: &str, change: StatusChange) -> Result<String, String> {
    let (line_number, _) = find_span(content, id)
        .ok_or_else(|| format!("Todo not found: {}", id))?;

    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
    let idx = line_number - 1;
    if idx >= lines.len() {
        return Err("Todo line out of range".to_string());
    }
    lines[idx] = rewrite_status_line(&lines[idx], change);

    Ok(join_preserving_trailing(content, &lines))
}

/// Delete a todo and everything it owns (continuation body + sub-tasks).
pub fn apply_delete(content: &str, id: &str) -> Result<String, String> {
    let (line_number, line_count) = find_span(content, id)
        .ok_or_else(|| format!("Todo not found: {}", id))?;

    let lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
    let start = line_number - 1;
    let end = (start + line_count).min(lines.len());
    let next: Vec<String> = lines[..start]
        .iter()
        .chain(lines[end..].iter())
        .cloned()
        .collect();

    Ok(join_preserving_trailing(content, &next))
}

/// Build a fresh top-level todo line.
fn new_todo_line(text: &str, id: &str, created: &str) -> String {
    format!(
        "- [ ] {} <!-- id:{} --> <!-- created:{} -->",
        text.trim(),
        id,
        created
    )
}

/// Split a todo into one or more new top-level todos, removing the original.
/// `parts` are the headline texts for the new todos; `new_ids` must supply one
/// UUID per part (generated by the caller so this stays pure/testable).
pub fn apply_split(
    content: &str,
    id: &str,
    parts: &[String],
    new_ids: &[String],
    created: &str,
) -> Result<String, String> {
    if parts.is_empty() {
        return Err("Split needs at least one new todo".to_string());
    }
    if parts.len() != new_ids.len() {
        return Err("Mismatched parts and ids".to_string());
    }

    let (line_number, line_count) = find_span(content, id)
        .ok_or_else(|| format!("Todo not found: {}", id))?;

    let lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
    let start = line_number - 1;
    let end = (start + line_count).min(lines.len());

    let replacement: Vec<String> = parts
        .iter()
        .zip(new_ids.iter())
        .filter(|(p, _)| !p.trim().is_empty())
        .map(|(p, nid)| new_todo_line(p, nid, created))
        .collect();

    if replacement.is_empty() {
        return Err("Split needs at least one non-empty todo".to_string());
    }

    let next: Vec<String> = lines[..start]
        .iter()
        .cloned()
        .chain(replacement.into_iter())
        .chain(lines[end..].iter().cloned())
        .collect();

    Ok(join_preserving_trailing(content, &next))
}

/// Turn a todo's headline into a filesystem-friendly, human-readable slug.
/// Keeps unicode letters/digits (so Swedish å/ä/ö survive), turns runs of
/// anything else into single dashes, trims dashes, and caps the length.
pub fn slugify(text: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in text.trim().chars() {
        if c.is_alphanumeric() {
            for lc in c.to_lowercase() {
                out.push(lc);
            }
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
        if out.chars().count() >= 50 {
            break;
        }
    }
    let slug = out.trim_matches('-').to_string();
    if slug.is_empty() {
        "note".to_string()
    } else {
        slug
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const C: &str =
        "- [ ] Fix auth flow <!-- id:abc --> <!-- created:2026-04-10 -->\n- [ ] Other <!-- id:def -->\n";

    #[test]
    fn status_adds_tag_before_comments() {
        let out = apply_status(C, "abc", StatusChange::Blocked).unwrap();
        assert_eq!(
            out.lines().next().unwrap(),
            "- [ ] Fix auth flow #blocked <!-- id:abc --> <!-- created:2026-04-10 -->"
        );
    }

    #[test]
    fn status_swaps_existing_tag() {
        let with = apply_status(C, "abc", StatusChange::Waiting).unwrap();
        let swapped = apply_status(&with, "abc", StatusChange::Blocked).unwrap();
        let line = swapped.lines().next().unwrap();
        assert!(line.contains("#blocked"));
        assert!(!line.contains("#waiting"));
        // No double spaces left behind by the swap.
        assert!(!line.contains("  "));
    }

    #[test]
    fn status_clear_removes_tag() {
        let with = apply_status(C, "abc", StatusChange::OnHold).unwrap();
        let cleared = apply_status(&with, "abc", StatusChange::Clear).unwrap();
        assert_eq!(
            cleared.lines().next().unwrap(),
            "- [ ] Fix auth flow <!-- id:abc --> <!-- created:2026-04-10 -->"
        );
    }

    #[test]
    fn status_with_no_markers_appends() {
        let c = "- [ ] bare todo\n";
        let out = apply_status(c, "x", StatusChange::Blocked);
        // No id on the line → not found.
        assert!(out.is_err());
    }

    #[test]
    fn delete_removes_block_and_subtasks() {
        let c = "- [ ] parent <!-- id:p -->\n\t- [ ] sub <!-- id:s -->\n- [ ] keep <!-- id:k -->\n";
        let out = apply_delete(c, "p").unwrap();
        assert_eq!(out, "- [ ] keep <!-- id:k -->\n");
    }

    #[test]
    fn split_replaces_with_new_todos() {
        let out = apply_split(
            C,
            "abc",
            &["one".to_string(), "two".to_string()],
            &["id1".to_string(), "id2".to_string()],
            "2026-06-03",
        )
        .unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(
            lines[0],
            "- [ ] one <!-- id:id1 --> <!-- created:2026-06-03 -->"
        );
        assert_eq!(
            lines[1],
            "- [ ] two <!-- id:id2 --> <!-- created:2026-06-03 -->"
        );
        assert_eq!(lines[2], "- [ ] Other <!-- id:def -->");
    }

    #[test]
    fn split_drops_empty_parts() {
        let out = apply_split(
            C,
            "abc",
            &["only".to_string(), "  ".to_string()],
            &["id1".to_string(), "id2".to_string()],
            "2026-06-03",
        )
        .unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 2); // one new + the untouched "Other"
        assert!(lines[0].contains("only"));
    }

    #[test]
    fn slugify_basic_and_unicode() {
        assert_eq!(slugify("Fix auth flow"), "fix-auth-flow");
        assert_eq!(slugify("  Ring kund: VIKTIGT!!  "), "ring-kund-viktigt");
        assert_eq!(slugify("Köp mjölk åt mormor"), "köp-mjölk-åt-mormor");
        assert_eq!(slugify("***"), "note");
    }
}
