// Pure utilities for deriving display metadata from a note's body content.
// No filesystem, no AI, deterministic. Shared by inbox routing and the
// project-list view command.

use chrono::{Datelike, NaiveDate};
use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashSet;

const TITLE_MAX_CHARS: usize = 80;

/// First non-empty, non-todo line of the body (frontmatter stripped), truncated
/// to 80 chars with `…`. Inline markdown is stripped so the result is flat text
/// suitable for popup rows, list titles, breadcrumbs, etc. Returns an empty
/// string only when the body is empty or consists entirely of todos / whitespace.
pub fn derive_title(body: &str) -> String {
    let body = strip_frontmatter(body);
    for raw in body.lines() {
        let line = raw.trim();
        if line.is_empty() || is_todo_line(line) {
            continue;
        }
        let plain = strip_markdown_inline(line);
        if plain.is_empty() {
            continue;
        }
        return truncate(&plain);
    }
    String::new()
}

/// One-line excerpt: the second non-empty, non-todo line after the title, if
/// any. Inline markdown stripped. Trimmed, not truncated (the frontend clips
/// with CSS).
pub fn derive_excerpt(body: &str) -> String {
    let body = strip_frontmatter(body);
    let mut title_seen = false;
    for raw in body.lines() {
        let line = raw.trim();
        if line.is_empty() || is_todo_line(line) {
            continue;
        }
        if !title_seen {
            title_seen = true;
            continue;
        }
        let plain = strip_markdown_inline(line);
        if plain.is_empty() {
            continue;
        }
        return plain;
    }
    String::new()
}

/// Strip the inline markdown patterns that show up in titles/excerpts so the
/// result reads as flat prose. Headings, bold, italic, code spans, highlights,
/// strikethrough, wikilinks (`[[Name|alias]]` → alias), and markdown links
/// (`[text](url)` → text). Run order matters: bold must precede italic so
/// `**x**` is not chewed by the italic pattern.
pub fn strip_markdown_inline(line: &str) -> String {
    let s = HEADING_RE.replace(line, "");
    let s = WIKILINK_RE.replace_all(&s, |caps: &regex::Captures| {
        caps.get(2)
            .or_else(|| caps.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default()
    });
    let s = MD_LINK_RE.replace_all(&s, "$1");
    let s = BOLD_STAR_RE.replace_all(&s, "$1");
    let s = BOLD_USCORE_RE.replace_all(&s, "$1");
    let s = HIGHLIGHT_RE.replace_all(&s, "$1");
    let s = STRIKE_RE.replace_all(&s, "$1");
    let s = CODE_RE.replace_all(&s, "$1");
    let s = ITALIC_STAR_RE.replace_all(&s, "$1");
    let s = ITALIC_USCORE_RE.replace_all(&s, "$1");
    s.trim().to_string()
}

/// Inline `#foo` tags extracted from the body. Preserves first-seen casing but
/// dedupes case-insensitively so `#Design` and `#design` collapse to one.
pub fn extract_tags(body: &str) -> Vec<String> {
    let body = strip_frontmatter(body);
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for cap in TAG_REGEX.captures_iter(body) {
        let tag = cap[1].to_string();
        let key = tag.to_lowercase();
        if seen.insert(key) {
            out.push(tag);
        }
    }
    out
}

/// Temporal group that a note's creation date falls into, relative to `now`.
/// Frontend orders groups: ThisWeek, LastWeek, then Month variants sorted by
/// (year desc, month desc) up to 12 months back, then Older.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Bucket {
    ThisWeek,
    LastWeek,
    Month { year: i32, month: u32 },
    Older,
}

pub fn bucket_of(created: NaiveDate, now: NaiveDate) -> Bucket {
    let now_wk = now.iso_week();
    let created_wk = created.iso_week();

    if created_wk.year() == now_wk.year() && created_wk.week() == now_wk.week() {
        return Bucket::ThisWeek;
    }
    let last_ref = now - chrono::Duration::weeks(1);
    let last_wk = last_ref.iso_week();
    if created_wk.year() == last_wk.year() && created_wk.week() == last_wk.week() {
        return Bucket::LastWeek;
    }

    let cutoff = now - chrono::Duration::days(365);
    if created >= cutoff {
        Bucket::Month {
            year: created.year(),
            month: created.month(),
        }
    } else {
        Bucket::Older
    }
}

// ── internals ─────────────────────────────────────────

static TAG_REGEX: Lazy<Regex> = Lazy::new(|| {
    // `#tag` at start of string or after whitespace. Tag must start with a
    // letter so `#123` isn't captured (common in markdown headings like `#`
    // not-a-tag). Allows letters, digits, `_`, `-`.
    Regex::new(r"(?:^|\s)#([A-Za-z][A-Za-z0-9_-]*)").unwrap()
});

static HEADING_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^#{1,6}\s+").unwrap());
static WIKILINK_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\[\[([^\]\|]+?)(?:\|([^\]]+?))?\]\]").unwrap());
static MD_LINK_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\[([^\]]+)\]\([^\)]+\)").unwrap());
static BOLD_STAR_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\*\*([^*]+?)\*\*").unwrap());
static BOLD_USCORE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"__([^_]+?)__").unwrap());
static HIGHLIGHT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"==([^=]+?)==").unwrap());
static STRIKE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"~~([^~]+?)~~").unwrap());
static CODE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"`([^`]+?)`").unwrap());
static ITALIC_STAR_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\*([^*\n]+?)\*").unwrap());
static ITALIC_USCORE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"_([^_\n]+?)_").unwrap());

fn strip_frontmatter(content: &str) -> &str {
    if content.starts_with("---") {
        if let Some(end) = content[3..].find("\n---") {
            let after = &content[3 + end + 4..];
            return after.trim_start_matches('\n').trim_start_matches('\r');
        }
    }
    content
}

fn is_todo_line(line: &str) -> bool {
    let t = line.trim_start();
    let mut chars = t.chars();
    match chars.next() {
        Some('-') | Some('*') | Some('+') => (),
        _ => return false,
    }
    let rest: String = chars.collect();
    let r = rest.trim_start();
    r.starts_with("[ ]") || r.starts_with("[x]") || r.starts_with("[X]")
}

fn truncate(s: &str) -> String {
    let mut count = 0usize;
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if count >= TITLE_MAX_CHARS {
            out.push('…');
            return out;
        }
        out.push(c);
        count += 1;
    }
    out
}

// ── tests ─────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_from_first_prose_line() {
        let body = "had a thought about the MSI packaging\nsecond line ignored";
        assert_eq!(derive_title(body), "had a thought about the MSI packaging");
    }

    #[test]
    fn title_skips_leading_blank_lines() {
        let body = "\n\n   \nfinally the title\n";
        assert_eq!(derive_title(body), "finally the title");
    }

    #[test]
    fn title_skips_leading_todos() {
        let body = "- [ ] ship the build\n- [x] write changelog\nactual note starts here";
        assert_eq!(derive_title(body), "actual note starts here");
    }

    #[test]
    fn title_truncates_with_ellipsis() {
        let long = "a".repeat(100);
        let t = derive_title(&long);
        assert!(t.ends_with('…'));
        assert_eq!(t.chars().count(), TITLE_MAX_CHARS + 1);
    }

    #[test]
    fn title_handles_frontmatter() {
        let body = "---\ntype: note\ncreated: 2026-04-23T14:32\n---\nthis is the real title";
        assert_eq!(derive_title(body), "this is the real title");
    }

    #[test]
    fn title_empty_when_only_todos() {
        let body = "- [ ] do this\n- [ ] and this\n";
        assert_eq!(derive_title(body), "");
    }

    #[test]
    fn excerpt_is_second_prose_line() {
        let body = "title line\nexcerpt line\nthird line";
        assert_eq!(derive_excerpt(body), "excerpt line");
    }

    #[test]
    fn excerpt_skips_todos_between_title_and_excerpt() {
        let body = "title\n- [ ] todo in middle\nreal excerpt";
        assert_eq!(derive_excerpt(body), "real excerpt");
    }

    #[test]
    fn tags_basic() {
        let body = "had a #design thought about #bug handling";
        assert_eq!(extract_tags(body), vec!["design", "bug"]);
    }

    #[test]
    fn tags_dedupe_case_insensitive() {
        let body = "#Design first, then #design again";
        assert_eq!(extract_tags(body), vec!["Design"]);
    }

    #[test]
    fn tags_skip_number_only_and_bare_hash() {
        let body = "# heading\n#123 not-a-tag\n#real-tag";
        assert_eq!(extract_tags(body), vec!["real-tag"]);
    }

    #[test]
    fn tags_at_start_of_line() {
        let body = "#idea at the start\nmore text";
        assert_eq!(extract_tags(body), vec!["idea"]);
    }

    #[test]
    fn bucket_this_week_and_last_week() {
        let now = NaiveDate::from_ymd_opt(2026, 4, 23).unwrap(); // Thursday
        let monday = NaiveDate::from_ymd_opt(2026, 4, 20).unwrap();
        let prev_monday = NaiveDate::from_ymd_opt(2026, 4, 13).unwrap();
        assert_eq!(bucket_of(monday, now), Bucket::ThisWeek);
        assert_eq!(bucket_of(prev_monday, now), Bucket::LastWeek);
    }

    #[test]
    fn bucket_earlier_month() {
        let now = NaiveDate::from_ymd_opt(2026, 4, 23).unwrap();
        let march = NaiveDate::from_ymd_opt(2026, 3, 2).unwrap();
        assert_eq!(
            bucket_of(march, now),
            Bucket::Month { year: 2026, month: 3 }
        );
    }

    #[test]
    fn title_strips_bold_and_italic() {
        assert_eq!(derive_title("**Big idea**"), "Big idea");
        assert_eq!(derive_title("*soft thought*"), "soft thought");
        assert_eq!(derive_title("__bold__ then plain"), "bold then plain");
    }

    #[test]
    fn title_strips_headings_and_code() {
        assert_eq!(derive_title("## My heading"), "My heading");
        assert_eq!(derive_title("a `snippet` inside"), "a snippet inside");
    }

    #[test]
    fn title_strips_links_and_wikilinks() {
        assert_eq!(derive_title("see [the docs](https://x.com)"), "see the docs");
        assert_eq!(derive_title("ref to [[Other Note]]"), "ref to Other Note");
        assert_eq!(derive_title("ref to [[Other Note|alias]]"), "ref to alias");
    }

    #[test]
    fn title_strips_highlights_and_strikethrough() {
        assert_eq!(derive_title("==important== bit"), "important bit");
        assert_eq!(derive_title("~~old~~ new"), "old new");
    }

    #[test]
    fn excerpt_strips_inline_markdown() {
        let body = "title\n**bold** excerpt with `code`";
        assert_eq!(derive_excerpt(body), "bold excerpt with code");
    }

    #[test]
    fn bucket_older_than_a_year() {
        let now = NaiveDate::from_ymd_opt(2026, 4, 23).unwrap();
        let ancient = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();
        assert_eq!(bucket_of(ancient, now), Bucket::Older);
    }
}
