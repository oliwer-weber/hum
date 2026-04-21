// Native ICS calendar fetch + parse. Returns the weekly event set for the
// Focus tab's right-rail calendar. URL comes from prefs; empty URL yields
// an empty event list so the UI renders without a network round-trip.

use std::collections::BTreeMap;
use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime, TimeZone};
use chrono_tz::Tz;
use serde::Serialize;

const STOCKHOLM: Tz = chrono_tz::Europe::Stockholm;

#[derive(Serialize)]
pub struct CalendarEvent {
    pub title: String,
    pub date: String,
    pub day: String,
    pub start: String,
    pub end: Option<String>,
    pub location: Option<String>,
    pub attendees: Option<Vec<String>>,
}

#[derive(Serialize)]
pub struct CalendarData {
    pub week: String,
    pub total_events: usize,
    pub events: Vec<CalendarEvent>,
}

pub async fn fetch_ics(url: &str) -> Result<CalendarData, String> {
    let (monday, sunday) = week_bounds();

    if url.trim().is_empty() {
        return Ok(CalendarData {
            week: format!("{} to {}", monday, sunday),
            total_events: 0,
            events: vec![],
        });
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch calendar: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Calendar HTTP {}", resp.status()));
    }

    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read calendar response: {}", e))?;

    parse(&body, monday, sunday)
}

fn week_bounds() -> (NaiveDate, NaiveDate) {
    let today = chrono::Utc::now().with_timezone(&STOCKHOLM).date_naive();
    let weekday = today.weekday().num_days_from_monday() as i64;
    let monday = today - chrono::Duration::days(weekday);
    let sunday = monday + chrono::Duration::days(6);
    (monday, sunday)
}

// ICS line folding: any line starting with whitespace is a continuation of
// the previous line with the leading space/tab stripped.
fn unfold(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_end_matches('\r');
        if (trimmed.starts_with(' ') || trimmed.starts_with('\t')) && !lines.is_empty() {
            lines.last_mut().unwrap().push_str(&trimmed[1..]);
        } else {
            lines.push(trimmed.to_string());
        }
    }
    lines
}

struct Prop {
    name: String,
    params: BTreeMap<String, String>,
    value: String,
}

fn parse_prop(line: &str) -> Option<Prop> {
    let colon = line.find(':')?;
    let head = &line[..colon];
    let value = &line[colon + 1..];
    let mut parts = head.split(';');
    let name = parts.next()?.to_uppercase();
    let mut params = BTreeMap::new();
    for p in parts {
        if let Some(eq) = p.find('=') {
            params.insert(p[..eq].to_uppercase(), p[eq + 1..].to_string());
        }
    }
    Some(Prop { name, params, value: unescape(value) })
}

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') | Some('N') => out.push('\n'),
                Some(',') => out.push(','),
                Some(';') => out.push(';'),
                Some('\\') => out.push('\\'),
                Some(other) => { out.push('\\'); out.push(other); }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn parse_dt(value: &str, params: &BTreeMap<String, String>) -> Option<DateTime<Tz>> {
    // All-day: YYYYMMDD
    if value.len() == 8 && value.chars().all(|c| c.is_ascii_digit()) {
        let d = NaiveDate::parse_from_str(value, "%Y%m%d").ok()?;
        return STOCKHOLM.from_local_datetime(&d.and_hms_opt(0, 0, 0)?).single();
    }
    // Timed: YYYYMMDDTHHMMSS, optional trailing Z for UTC
    let utc = value.ends_with('Z');
    let core = if utc { &value[..value.len() - 1] } else { value };
    let naive = NaiveDateTime::parse_from_str(core, "%Y%m%dT%H%M%S").ok()?;
    if utc {
        Some(chrono::Utc.from_utc_datetime(&naive).with_timezone(&STOCKHOLM))
    } else if let Some(tzid) = params.get("TZID") {
        let tz: Tz = tzid.parse().unwrap_or(STOCKHOLM);
        tz.from_local_datetime(&naive).single().map(|dt| dt.with_timezone(&STOCKHOLM))
    } else {
        STOCKHOLM.from_local_datetime(&naive).single()
    }
}

fn parse(text: &str, monday: NaiveDate, sunday: NaiveDate) -> Result<CalendarData, String> {
    let week_start = STOCKHOLM
        .from_local_datetime(&monday.and_hms_opt(0, 0, 0).unwrap())
        .single()
        .ok_or_else(|| "Could not resolve week start in Europe/Stockholm".to_string())?;
    let week_end = STOCKHOLM
        .from_local_datetime(&sunday.and_hms_opt(23, 59, 59).unwrap())
        .single()
        .ok_or_else(|| "Could not resolve week end in Europe/Stockholm".to_string())?;

    let lines = unfold(text);
    let mut events: Vec<CalendarEvent> = Vec::new();

    let mut in_event = false;
    let mut title = String::new();
    let mut dtstart: Option<DateTime<Tz>> = None;
    let mut dtend: Option<DateTime<Tz>> = None;
    let mut location: Option<String> = None;
    let mut attendees: Vec<String> = Vec::new();

    for line in &lines {
        if line == "BEGIN:VEVENT" {
            in_event = true;
            title.clear();
            dtstart = None;
            dtend = None;
            location = None;
            attendees.clear();
            continue;
        }
        if line == "END:VEVENT" {
            if let Some(start) = dtstart {
                let in_week = start <= week_end && dtend.map_or(true, |e| e >= week_start);
                if in_week {
                    events.push(CalendarEvent {
                        title: title.clone(),
                        date: start.format("%Y-%m-%d").to_string(),
                        day: start.format("%A").to_string(),
                        start: start.format("%H:%M").to_string(),
                        end: dtend.map(|e| e.format("%H:%M").to_string()),
                        location: location.clone().filter(|s| !s.is_empty()),
                        attendees: if attendees.is_empty() { None } else { Some(attendees.clone()) },
                    });
                }
            }
            in_event = false;
            continue;
        }
        if !in_event { continue; }

        let Some(prop) = parse_prop(line) else { continue; };
        match prop.name.as_str() {
            "SUMMARY" => title = prop.value,
            "DTSTART" => dtstart = parse_dt(&prop.value, &prop.params),
            "DTEND" => dtend = parse_dt(&prop.value, &prop.params),
            "LOCATION" => location = Some(prop.value),
            "ATTENDEE" => {
                let name = prop.params.get("CN")
                    .cloned()
                    .unwrap_or_else(|| prop.value.replace("mailto:", ""));
                attendees.push(name);
            }
            _ => {}
        }
    }

    events.sort_by(|a, b| a.date.cmp(&b.date).then(a.start.cmp(&b.start)));

    Ok(CalendarData {
        week: format!("{} to {}", monday, sunday),
        total_events: events.len(),
        events,
    })
}
