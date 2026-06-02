//! Tiny, dependency-free JSON value parser.
//!
//! The crate hand-writes its JSON output (see `export.rs`) and never pulled in
//! serde. The snapshot/diff feature (`diff.rs`) needs to read its own JSON
//! artifacts back, so this provides a small, correct recursive-descent parser
//! over the subset of JSON we emit (objects, arrays, strings with escapes,
//! numbers, bool, null). It is intentionally lenient enough for our files and
//! returns `None` on anything malformed rather than panicking.

#[derive(Debug, Clone)]
pub(crate) enum JsonValue {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Array(Vec<JsonValue>),
    Object(Vec<(String, JsonValue)>),
}

impl JsonValue {
    /// Look up a key on an object value (linear scan — our objects are small).
    pub(crate) fn get(&self, key: &str) -> Option<&JsonValue> {
        match self {
            JsonValue::Object(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub(crate) fn as_str(&self) -> Option<&str> {
        match self {
            JsonValue::Str(s) => Some(s.as_str()),
            _ => None,
        }
    }

    pub(crate) fn as_f64(&self) -> Option<f64> {
        match self {
            JsonValue::Num(n) => Some(*n),
            _ => None,
        }
    }

    pub(crate) fn as_u64(&self) -> Option<u64> {
        self.as_f64().map(|n| if n < 0.0 { 0 } else { n as u64 })
    }

    pub(crate) fn as_bool(&self) -> Option<bool> {
        match self {
            JsonValue::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub(crate) fn as_array(&self) -> Option<&[JsonValue]> {
        match self {
            JsonValue::Array(items) => Some(items.as_slice()),
            _ => None,
        }
    }
}

/// Parse a complete JSON document. Returns `None` on malformed input.
pub(crate) fn parse(input: &str) -> Option<JsonValue> {
    let bytes = input.as_bytes();
    let mut pos = 0usize;
    skip_ws(bytes, &mut pos);
    let value = parse_value(bytes, &mut pos)?;
    skip_ws(bytes, &mut pos);
    // Trailing non-whitespace is tolerated (we only care about the leading doc).
    Some(value)
}

fn skip_ws(b: &[u8], pos: &mut usize) {
    while *pos < b.len() {
        match b[*pos] {
            b' ' | b'\t' | b'\n' | b'\r' => *pos += 1,
            _ => break,
        }
    }
}

fn parse_value(b: &[u8], pos: &mut usize) -> Option<JsonValue> {
    skip_ws(b, pos);
    match b.get(*pos)? {
        b'{' => parse_object(b, pos),
        b'[' => parse_array(b, pos),
        b'"' => parse_string(b, pos).map(JsonValue::Str),
        b't' | b'f' => parse_bool(b, pos),
        b'n' => parse_null(b, pos),
        _ => parse_number(b, pos),
    }
}

fn parse_object(b: &[u8], pos: &mut usize) -> Option<JsonValue> {
    *pos += 1; // consume '{'
    let mut entries = Vec::new();
    skip_ws(b, pos);
    if b.get(*pos) == Some(&b'}') {
        *pos += 1;
        return Some(JsonValue::Object(entries));
    }
    loop {
        skip_ws(b, pos);
        let key = parse_string(b, pos)?;
        skip_ws(b, pos);
        if b.get(*pos) != Some(&b':') {
            return None;
        }
        *pos += 1;
        let value = parse_value(b, pos)?;
        entries.push((key, value));
        skip_ws(b, pos);
        match b.get(*pos)? {
            b',' => {
                *pos += 1;
                continue;
            }
            b'}' => {
                *pos += 1;
                return Some(JsonValue::Object(entries));
            }
            _ => return None,
        }
    }
}

fn parse_array(b: &[u8], pos: &mut usize) -> Option<JsonValue> {
    *pos += 1; // consume '['
    let mut items = Vec::new();
    skip_ws(b, pos);
    if b.get(*pos) == Some(&b']') {
        *pos += 1;
        return Some(JsonValue::Array(items));
    }
    loop {
        let value = parse_value(b, pos)?;
        items.push(value);
        skip_ws(b, pos);
        match b.get(*pos)? {
            b',' => {
                *pos += 1;
                continue;
            }
            b']' => {
                *pos += 1;
                return Some(JsonValue::Array(items));
            }
            _ => return None,
        }
    }
}

fn parse_string(b: &[u8], pos: &mut usize) -> Option<String> {
    if b.get(*pos) != Some(&b'"') {
        return None;
    }
    *pos += 1; // consume opening quote
    let mut out = String::new();
    while *pos < b.len() {
        let c = b[*pos];
        *pos += 1;
        match c {
            b'"' => return Some(out),
            b'\\' => {
                let esc = *b.get(*pos)?;
                *pos += 1;
                match esc {
                    b'"' => out.push('"'),
                    b'\\' => out.push('\\'),
                    b'/' => out.push('/'),
                    b'b' => out.push('\u{0008}'),
                    b'f' => out.push('\u{000C}'),
                    b'n' => out.push('\n'),
                    b'r' => out.push('\r'),
                    b't' => out.push('\t'),
                    b'u' => {
                        let cp = parse_hex4(b, pos)?;
                        if (0xD800..=0xDBFF).contains(&cp) {
                            // High surrogate — expect a following low surrogate.
                            if b.get(*pos) == Some(&b'\\') && b.get(*pos + 1) == Some(&b'u') {
                                *pos += 2;
                                let lo = parse_hex4(b, pos)?;
                                let combined =
                                    0x10000 + (((cp - 0xD800) as u32) << 10) + (lo - 0xDC00) as u32;
                                out.push(char::from_u32(combined).unwrap_or('\u{FFFD}'));
                            } else {
                                out.push('\u{FFFD}');
                            }
                        } else {
                            out.push(char::from_u32(cp as u32).unwrap_or('\u{FFFD}'));
                        }
                    }
                    _ => return None,
                }
            }
            // Multi-byte UTF-8: copy the raw bytes through unchanged.
            _ if c >= 0x80 => {
                let start = *pos - 1;
                while *pos < b.len() && b[*pos] >= 0x80 && b[*pos] < 0xC0 {
                    *pos += 1;
                }
                out.push_str(std::str::from_utf8(&b[start..*pos]).ok()?);
            }
            _ => out.push(c as char),
        }
    }
    None
}

fn parse_hex4(b: &[u8], pos: &mut usize) -> Option<u16> {
    let mut value: u16 = 0;
    for _ in 0..4 {
        let d = *b.get(*pos)?;
        *pos += 1;
        let nibble = match d {
            b'0'..=b'9' => d - b'0',
            b'a'..=b'f' => d - b'a' + 10,
            b'A'..=b'F' => d - b'A' + 10,
            _ => return None,
        };
        value = (value << 4) | nibble as u16;
    }
    Some(value)
}

fn parse_bool(b: &[u8], pos: &mut usize) -> Option<JsonValue> {
    if b[*pos..].starts_with(b"true") {
        *pos += 4;
        Some(JsonValue::Bool(true))
    } else if b[*pos..].starts_with(b"false") {
        *pos += 5;
        Some(JsonValue::Bool(false))
    } else {
        None
    }
}

fn parse_null(b: &[u8], pos: &mut usize) -> Option<JsonValue> {
    if b[*pos..].starts_with(b"null") {
        *pos += 4;
        Some(JsonValue::Null)
    } else {
        None
    }
}

fn parse_number(b: &[u8], pos: &mut usize) -> Option<JsonValue> {
    let start = *pos;
    while *pos < b.len() {
        match b[*pos] {
            b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E' => *pos += 1,
            _ => break,
        }
    }
    if *pos == start {
        return None;
    }
    let slice = std::str::from_utf8(&b[start..*pos]).ok()?;
    slice.parse::<f64>().ok().map(JsonValue::Num)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_object_with_array() {
        let v = parse(r#"{"a":1,"b":"x\ny","c":[1,2,3],"d":true,"e":null}"#).unwrap();
        assert_eq!(v.get("a").and_then(|n| n.as_u64()), Some(1));
        assert_eq!(v.get("b").and_then(|s| s.as_str()), Some("x\ny"));
        assert_eq!(v.get("c").and_then(|a| a.as_array()).map(|a| a.len()), Some(3));
        assert_eq!(v.get("d").and_then(|x| x.as_bool()), Some(true));
        assert!(matches!(v.get("e"), Some(JsonValue::Null)));
    }

    #[test]
    fn handles_escaped_paths() {
        let v = parse(r#"{"p":"C:\\Users\\a b\\f.txt"}"#).unwrap();
        assert_eq!(v.get("p").and_then(|s| s.as_str()), Some("C:\\Users\\a b\\f.txt"));
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse("{not json").is_none());
    }
}
