use minijinja::value::{Serde, Value, ValueKind};
use minijinja::{AutoEscape, Environment, Output, State, UndefinedBehavior};
use serde_json::{Map, Value as JsonValue};

pub use minijinja::Error as RenderError;

pub fn render_tex(source: &str, data: &Map<String, JsonValue>) -> Result<String, RenderError> {
    let mut env = Environment::new();
    env.set_auto_escape_callback(|_| AutoEscape::Custom("tex".into()));
    env.set_undefined_behavior(UndefinedBehavior::Lenient);
    env.set_formatter(format_tex_value);
    // MiniJinja stringifies null and booleans as None/True/False before its built-in safe filter.
    env.add_filter("safe", |value: Value| {
        Value::from_safe_string(match value.kind() {
            ValueKind::None | ValueKind::Undefined => String::new(),
            ValueKind::Bool => value.is_true().to_string(),
            _ => value.to_string(),
        })
    });
    env.render_str(&strip_template_loads(source), Value::from(Serde(data)))
}

fn format_tex_value(
    out: &mut Output,
    _state: &mut State,
    value: &Value,
) -> Result<(), RenderError> {
    if value.is_none() || value.is_undefined() {
        return Ok(());
    }
    if value.kind() == ValueKind::Bool {
        out.write_str(if value.is_true() { "true" } else { "false" })?;
        return Ok(());
    }
    if value.is_safe() {
        out.write_str(&value.to_string())?;
    } else {
        out.write_str(&escape_tex(&value.to_string()))?;
    }
    Ok(())
}

fn escape_tex(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        escaped.push_str(match ch {
            '\\' => "\\textbackslash{}",
            '{' => "\\{",
            '}' => "\\}",
            '$' => "\\$",
            '&' => "\\&",
            '%' => "\\%",
            '#' => "\\#",
            '_' => "\\_",
            '^' => "\\textasciicircum{}",
            '~' => "\\textasciitilde{}",
            _ => {
                escaped.push(ch);
                continue;
            }
        });
    }
    escaped
}

pub fn strip_template_loads(source: &str) -> String {
    let mut output = String::with_capacity(source.len());
    let mut cursor = 0;
    let mut raw = false;
    let mut raw_body_start = 0;

    while let Some(start) = next_markup(source, cursor, raw) {
        if raw {
            let candidate = source[start + 2..]
                .trim_start_matches(|ch: char| ch.is_whitespace() || ch == '-' || ch == '+');
            if candidate.starts_with("endraw")
                && let Some(end) = find_tag_end(source, start + 2, b'%')
                && statement_name(&source[start + 2..end - 2]) == "endraw"
            {
                output.push_str(&source[raw_body_start..end]);
                cursor = end;
                raw = false;
                continue;
            }
            cursor = start + 2;
            continue;
        }

        output.push_str(&source[cursor..start]);
        let kind = source.as_bytes()[start + 1];
        let end = match kind {
            b'#' => source[start + 2..].find("#}").map(|n| start + 2 + n + 2),
            b'{' => find_tag_end(source, start + 2, b'}'),
            b'%' => find_tag_end(source, start + 2, b'%'),
            _ => None,
        };
        let Some(end) = end else {
            output.push_str(&source[start..]);
            return output;
        };

        if kind == b'%' {
            let name = statement_name(&source[start + 2..end - 2]);
            if name == "raw" {
                raw = true;
                raw_body_start = end;
            }
            if !matches!(name, "include" | "import" | "from") {
                output.push_str(&source[start..end]);
            }
        } else {
            output.push_str(&source[start..end]);
        }
        cursor = end;
    }
    output.push_str(&source[if raw { raw_body_start } else { cursor }..]);
    output
}

fn next_markup(source: &str, mut cursor: usize, raw: bool) -> Option<usize> {
    while let Some(offset) = source[cursor..].find('{') {
        let start = cursor + offset;
        match source.as_bytes().get(start + 1) {
            Some(b'%') => return Some(start),
            Some(b'{' | b'#') if !raw => return Some(start),
            _ => cursor = start + 1,
        }
    }
    None
}

fn find_tag_end(source: &str, start: usize, marker: u8) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut cursor = start;
    let mut quote = None;
    while cursor + 1 < bytes.len() {
        match (quote, bytes[cursor]) {
            (Some(_), b'\\') => cursor += 2,
            (Some(open), ch) if ch == open => {
                quote = None;
                cursor += 1;
            }
            (None, b'\'' | b'"') => {
                quote = Some(bytes[cursor]);
                cursor += 1;
            }
            (None, ch) if ch == marker && bytes[cursor + 1] == b'}' => {
                return Some(cursor + 2);
            }
            _ => cursor += 1,
        }
    }
    None
}

fn statement_name(tag: &str) -> &str {
    let tag = tag.trim_start_matches(|ch: char| ch.is_whitespace() || ch == '-' || ch == '+');
    tag.split(|ch: char| ch.is_whitespace() || ch == '-' || ch == '+')
        .next()
        .unwrap_or("")
}
