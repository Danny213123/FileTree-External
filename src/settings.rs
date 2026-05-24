#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

// Maximum nesting depth accepted by the parser. JSON for settings should
// never exceed 5; this cap prevents stack overflow on adversarial input
// (Threat T-02-01, Research Pitfall #5).
const MAX_DEPTH: usize = 64;

// --- Public types ---

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Settings {
    pub(crate) schema_version: u32,
    pub(crate) last_path: String,
    pub(crate) dark_mode: bool,
    pub(crate) show_hidden: bool,
    pub(crate) follow_symlinks: bool,
    pub(crate) columns: Vec<u32>,
    pub(crate) window: WindowGeometry,
    pub(crate) active_tab: String,
    // Unknown top-level keys are captured here for forward-compatible
    // round-trip (CONTEXT D-02).
    pub(crate) unknown: BTreeMap<String, RawJsonValue>,
    // Set when schema_version > 1 is read from disk; NOT written to disk
    // (Pitfall #10). Prevents accidental overwrite of future-version files.
    pub(crate) loaded_from_future: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: 1,
            last_path: String::new(),
            dark_mode: false,
            show_hidden: false,
            follow_symlinks: false,
            columns: Vec::new(),
            window: WindowGeometry::default(),
            active_tab: "details".to_string(),
            unknown: BTreeMap::new(),
            loaded_from_future: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WindowGeometry {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) w: i32,
    pub(crate) h: i32,
    pub(crate) unknown: BTreeMap<String, RawJsonValue>,
}

impl Default for WindowGeometry {
    fn default() -> Self {
        Self {
            x: 64,
            y: 32,
            w: 1280,
            h: 800,
            unknown: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum RawJsonValue {
    Object(BTreeMap<String, RawJsonValue>),
    Array(Vec<RawJsonValue>),
    Str(String),
    Int(i64),
    Float(f64),
    Bool(bool),
    Null,
}

#[derive(Debug)]
pub(crate) enum ParseError {
    Unexpected(usize),
    DepthExceeded,
    TrailingGarbage,
    InvalidEscape,
    InvalidUnicode,
    InvalidNumber,
    IoError(io::Error),
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unexpected(pos) => write!(f, "unexpected character at byte {pos}"),
            Self::DepthExceeded => write!(f, "nesting depth exceeds {MAX_DEPTH}"),
            Self::TrailingGarbage => write!(f, "trailing non-whitespace after top-level value"),
            Self::InvalidEscape => write!(f, "invalid JSON escape sequence"),
            Self::InvalidUnicode => write!(f, "invalid unicode escape"),
            Self::InvalidNumber => write!(f, "invalid number literal"),
            Self::IoError(error) => write!(f, "I/O error: {error}"),
        }
    }
}

impl From<io::Error> for ParseError {
    fn from(error: io::Error) -> Self {
        Self::IoError(error)
    }
}

pub(crate) struct SettingsStore {
    pub(crate) path: PathBuf,
}

impl SettingsStore {
    /// Resolves `%APPDATA%\FileTree\settings.json`, creating the directory if
    /// needed. Returns an error only if the directory cannot be created or the
    /// AppData path cannot be resolved.
    pub(crate) fn default() -> io::Result<Self> {
        #[cfg(windows)]
        let appdata = crate::desktop::ffi::known_folder_roaming_appdata()?;
        #[cfg(not(windows))]
        let appdata = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| io::Error::other("HOME not set"))?;

        let dir = appdata.join("FileTree");
        fs::create_dir_all(&dir)?;
        Ok(Self {
            path: dir.join("settings.json"),
        })
    }

    /// Loads settings from disk, falling back to defaults on any read or parse
    /// error. On a parse error with an existing file, renames the broken file
    /// to `settings.json.broken-<unix_ts>` for debugging.
    pub(crate) fn load_or_default(&self) -> Settings {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(_) => return Settings::default(),
        };
        match parse_settings_json(&text) {
            Ok(settings) => settings,
            Err(_error) => {
                #[cfg(debug_assertions)]
                eprintln!("settings parse failed: {_error}");
                // Rename the broken file so the user can inspect it.
                let ts = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let broken = self
                    .path
                    .with_file_name(format!("settings.json.broken-{ts}"));
                let _ = fs::rename(&self.path, broken);
                Settings::default()
            }
        }
    }

    /// Serializes `settings` to JSON and atomically writes to disk.
    /// On failure, logs to stderr in debug builds; never panics.
    pub(crate) fn save(&self, settings: &Settings) -> io::Result<()> {
        let mut body = String::with_capacity(1024);
        push_settings_json(&mut body, settings);
        atomic_write_settings(&self.path, body.as_bytes())
    }
}

// --- Writer ---

/// Serializes `settings` into `output` as a JSON object.
/// Reuses `crate::export::push_json_string` for all string escaping (CONTEXT D-01).
pub(crate) fn push_settings_json(output: &mut String, settings: &Settings) {
    output.push('{');
    // schema_version is always first (Pitfall #10, CONTEXT D-01).
    // Emit verbatim — do NOT substitute a hardcoded 1.
    output.push_str("\"schema_version\":");
    output.push_str(&settings.schema_version.to_string());

    output.push_str(",\"last_path\":");
    crate::export::push_json_string(output, &settings.last_path);

    output.push_str(",\"dark_mode\":");
    output.push_str(if settings.dark_mode { "true" } else { "false" });

    output.push_str(",\"show_hidden\":");
    output.push_str(if settings.show_hidden {
        "true"
    } else {
        "false"
    });

    output.push_str(",\"follow_symlinks\":");
    output.push_str(if settings.follow_symlinks {
        "true"
    } else {
        "false"
    });

    output.push_str(",\"columns\":[");
    for (index, &col) in settings.columns.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push_str(&col.to_string());
    }
    output.push(']');

    output.push_str(",\"window\":{");
    output.push_str("\"x\":");
    output.push_str(&settings.window.x.to_string());
    output.push_str(",\"y\":");
    output.push_str(&settings.window.y.to_string());
    output.push_str(",\"w\":");
    output.push_str(&settings.window.w.to_string());
    output.push_str(",\"h\":");
    output.push_str(&settings.window.h.to_string());
    for (key, raw) in &settings.window.unknown {
        output.push(',');
        crate::export::push_json_string(output, key);
        output.push(':');
        push_raw_json_value(output, raw);
    }
    output.push('}');

    output.push_str(",\"active_tab\":");
    crate::export::push_json_string(output, &settings.active_tab);

    // Emit unknown top-level keys verbatim (CONTEXT D-02 forward-compat round-trip).
    for (key, raw) in &settings.unknown {
        output.push(',');
        crate::export::push_json_string(output, key);
        output.push(':');
        push_raw_json_value(output, raw);
    }

    output.push('}');
}

fn push_raw_json_value(output: &mut String, raw: &RawJsonValue) {
    match raw {
        RawJsonValue::Object(map) => {
            output.push('{');
            for (index, (key, value)) in map.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                crate::export::push_json_string(output, key);
                output.push(':');
                push_raw_json_value(output, value);
            }
            output.push('}');
        }
        RawJsonValue::Array(items) => {
            output.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                push_raw_json_value(output, item);
            }
            output.push(']');
        }
        RawJsonValue::Str(s) => crate::export::push_json_string(output, s),
        RawJsonValue::Int(n) => output.push_str(&n.to_string()),
        RawJsonValue::Float(f) => {
            output.push_str(&format!("{f}"));
        }
        RawJsonValue::Bool(b) => output.push_str(if *b { "true" } else { "false" }),
        RawJsonValue::Null => output.push_str("null"),
    }
}

// --- Parser ---

/// Parses a `settings.json` text into a `Settings` struct.
/// Unknown keys are captured for round-trip. Rejects malformed JSON with a
/// typed `ParseError` rather than panicking.
pub(crate) fn parse_settings_json(text: &str) -> Result<Settings, ParseError> {
    let bytes = text.as_bytes();
    let mut pos = 0usize;
    skip_whitespace(bytes, &mut pos);
    let mut settings = Settings::default();
    parse_top_object(bytes, &mut pos, &mut settings)?;
    skip_whitespace(bytes, &mut pos);
    if pos < bytes.len() {
        return Err(ParseError::TrailingGarbage);
    }
    Ok(settings)
}

fn skip_whitespace(bytes: &[u8], pos: &mut usize) {
    while *pos < bytes.len() && matches!(bytes[*pos], b' ' | b'\t' | b'\n' | b'\r') {
        *pos += 1;
    }
}

fn expect_byte(bytes: &[u8], pos: &mut usize, expected: u8) -> Result<(), ParseError> {
    if *pos >= bytes.len() || bytes[*pos] != expected {
        return Err(ParseError::Unexpected(*pos));
    }
    *pos += 1;
    Ok(())
}

fn parse_top_object(
    bytes: &[u8],
    pos: &mut usize,
    settings: &mut Settings,
) -> Result<(), ParseError> {
    expect_byte(bytes, pos, b'{')?;
    skip_whitespace(bytes, pos);
    if *pos < bytes.len() && bytes[*pos] == b'}' {
        *pos += 1;
        return Ok(());
    }
    loop {
        skip_whitespace(bytes, pos);
        let key = parse_string(bytes, pos)?;
        skip_whitespace(bytes, pos);
        expect_byte(bytes, pos, b':')?;
        skip_whitespace(bytes, pos);

        match key.as_str() {
            "schema_version" => {
                let v = parse_value(bytes, pos, 1)?;
                if let RawJsonValue::Int(n) = v {
                    settings.schema_version = n as u32;
                    // Pitfall #10: mark future-version files; do NOT save
                    // unless user explicitly changes a setting.
                    if n > 1 {
                        settings.loaded_from_future = true;
                    }
                }
            }
            "last_path" => {
                let v = parse_value(bytes, pos, 1)?;
                if let RawJsonValue::Str(s) = v {
                    settings.last_path = s;
                }
            }
            "dark_mode" => {
                let v = parse_value(bytes, pos, 1)?;
                if let RawJsonValue::Bool(b) = v {
                    settings.dark_mode = b;
                }
            }
            "show_hidden" => {
                let v = parse_value(bytes, pos, 1)?;
                if let RawJsonValue::Bool(b) = v {
                    settings.show_hidden = b;
                }
            }
            "follow_symlinks" => {
                let v = parse_value(bytes, pos, 1)?;
                if let RawJsonValue::Bool(b) = v {
                    settings.follow_symlinks = b;
                }
            }
            "columns" => {
                let v = parse_value(bytes, pos, 1)?;
                if let RawJsonValue::Array(items) = v {
                    settings.columns = items
                        .into_iter()
                        .filter_map(|item| {
                            if let RawJsonValue::Int(n) = item {
                                Some(n as u32)
                            } else {
                                None
                            }
                        })
                        .collect();
                }
            }
            "window" => {
                parse_window_object(bytes, pos, &mut settings.window)?;
            }
            "active_tab" => {
                let v = parse_value(bytes, pos, 1)?;
                if let RawJsonValue::Str(s) = v {
                    settings.active_tab = s;
                }
            }
            _ => {
                let raw = parse_value(bytes, pos, 1)?;
                settings.unknown.insert(key, raw);
            }
        }

        skip_whitespace(bytes, pos);
        if *pos >= bytes.len() {
            break;
        }
        match bytes[*pos] {
            b',' => {
                *pos += 1;
                skip_whitespace(bytes, pos);
                // Reject trailing comma.
                if *pos < bytes.len() && bytes[*pos] == b'}' {
                    return Err(ParseError::Unexpected(*pos));
                }
            }
            b'}' => {
                *pos += 1;
                return Ok(());
            }
            _ => return Err(ParseError::Unexpected(*pos)),
        }
    }
    Err(ParseError::Unexpected(*pos))
}

fn parse_window_object(
    bytes: &[u8],
    pos: &mut usize,
    window: &mut WindowGeometry,
) -> Result<(), ParseError> {
    expect_byte(bytes, pos, b'{')?;
    skip_whitespace(bytes, pos);
    if *pos < bytes.len() && bytes[*pos] == b'}' {
        *pos += 1;
        return Ok(());
    }
    loop {
        skip_whitespace(bytes, pos);
        let key = parse_string(bytes, pos)?;
        skip_whitespace(bytes, pos);
        expect_byte(bytes, pos, b':')?;
        skip_whitespace(bytes, pos);

        match key.as_str() {
            "x" => {
                if let RawJsonValue::Int(n) = parse_value(bytes, pos, 2)? {
                    window.x = n as i32;
                }
            }
            "y" => {
                if let RawJsonValue::Int(n) = parse_value(bytes, pos, 2)? {
                    window.y = n as i32;
                }
            }
            "w" => {
                if let RawJsonValue::Int(n) = parse_value(bytes, pos, 2)? {
                    window.w = n as i32;
                }
            }
            "h" => {
                if let RawJsonValue::Int(n) = parse_value(bytes, pos, 2)? {
                    window.h = n as i32;
                }
            }
            _ => {
                let raw = parse_value(bytes, pos, 2)?;
                window.unknown.insert(key, raw);
            }
        }

        skip_whitespace(bytes, pos);
        if *pos >= bytes.len() {
            break;
        }
        match bytes[*pos] {
            b',' => {
                *pos += 1;
                skip_whitespace(bytes, pos);
                if *pos < bytes.len() && bytes[*pos] == b'}' {
                    return Err(ParseError::Unexpected(*pos));
                }
            }
            b'}' => {
                *pos += 1;
                return Ok(());
            }
            _ => return Err(ParseError::Unexpected(*pos)),
        }
    }
    Err(ParseError::Unexpected(*pos))
}

/// Recursive-descent value parser. `depth` starts at 1 from top-level callers.
fn parse_value(bytes: &[u8], pos: &mut usize, depth: usize) -> Result<RawJsonValue, ParseError> {
    if depth > MAX_DEPTH {
        return Err(ParseError::DepthExceeded);
    }
    if *pos >= bytes.len() {
        return Err(ParseError::Unexpected(*pos));
    }
    match bytes[*pos] {
        b'"' => Ok(RawJsonValue::Str(parse_string(bytes, pos)?)),
        b'{' => {
            *pos += 1;
            let mut map = BTreeMap::new();
            skip_whitespace(bytes, pos);
            if *pos < bytes.len() && bytes[*pos] == b'}' {
                *pos += 1;
                return Ok(RawJsonValue::Object(map));
            }
            loop {
                skip_whitespace(bytes, pos);
                let key = parse_string(bytes, pos)?;
                skip_whitespace(bytes, pos);
                expect_byte(bytes, pos, b':')?;
                skip_whitespace(bytes, pos);
                let value = parse_value(bytes, pos, depth + 1)?;
                map.insert(key, value);
                skip_whitespace(bytes, pos);
                if *pos >= bytes.len() {
                    return Err(ParseError::Unexpected(*pos));
                }
                match bytes[*pos] {
                    b',' => {
                        *pos += 1;
                        skip_whitespace(bytes, pos);
                        if *pos < bytes.len() && bytes[*pos] == b'}' {
                            return Err(ParseError::Unexpected(*pos));
                        }
                    }
                    b'}' => {
                        *pos += 1;
                        return Ok(RawJsonValue::Object(map));
                    }
                    _ => return Err(ParseError::Unexpected(*pos)),
                }
            }
        }
        b'[' => {
            *pos += 1;
            let mut items = Vec::new();
            skip_whitespace(bytes, pos);
            if *pos < bytes.len() && bytes[*pos] == b']' {
                *pos += 1;
                return Ok(RawJsonValue::Array(items));
            }
            loop {
                skip_whitespace(bytes, pos);
                let value = parse_value(bytes, pos, depth + 1)?;
                items.push(value);
                skip_whitespace(bytes, pos);
                if *pos >= bytes.len() {
                    return Err(ParseError::Unexpected(*pos));
                }
                match bytes[*pos] {
                    b',' => {
                        *pos += 1;
                        skip_whitespace(bytes, pos);
                        if *pos < bytes.len() && bytes[*pos] == b']' {
                            return Err(ParseError::Unexpected(*pos));
                        }
                    }
                    b']' => {
                        *pos += 1;
                        return Ok(RawJsonValue::Array(items));
                    }
                    _ => return Err(ParseError::Unexpected(*pos)),
                }
            }
        }
        b't' => {
            if bytes.get(*pos..*pos + 4) == Some(b"true") {
                *pos += 4;
                Ok(RawJsonValue::Bool(true))
            } else {
                Err(ParseError::Unexpected(*pos))
            }
        }
        b'f' => {
            if bytes.get(*pos..*pos + 5) == Some(b"false") {
                *pos += 5;
                Ok(RawJsonValue::Bool(false))
            } else {
                Err(ParseError::Unexpected(*pos))
            }
        }
        b'n' => {
            if bytes.get(*pos..*pos + 4) == Some(b"null") {
                *pos += 4;
                Ok(RawJsonValue::Null)
            } else {
                Err(ParseError::Unexpected(*pos))
            }
        }
        b'-' | b'0'..=b'9' => parse_number(bytes, pos),
        _ => Err(ParseError::Unexpected(*pos)),
    }
}

/// Parses a JSON string, handling all seven escape sequences and surrogate
/// pairs (Pitfall #6: non-BMP code points encoded as surrogate pairs in JSON).
fn parse_string(bytes: &[u8], pos: &mut usize) -> Result<String, ParseError> {
    expect_byte(bytes, pos, b'"')?;
    let mut result = String::new();
    loop {
        if *pos >= bytes.len() {
            return Err(ParseError::Unexpected(*pos));
        }
        match bytes[*pos] {
            b'"' => {
                *pos += 1;
                return Ok(result);
            }
            b'\\' => {
                *pos += 1;
                if *pos >= bytes.len() {
                    return Err(ParseError::InvalidEscape);
                }
                match bytes[*pos] {
                    b'"' => {
                        result.push('"');
                        *pos += 1;
                    }
                    b'\\' => {
                        result.push('\\');
                        *pos += 1;
                    }
                    b'/' => {
                        result.push('/');
                        *pos += 1;
                    }
                    b'b' => {
                        result.push('\x08');
                        *pos += 1;
                    }
                    b'f' => {
                        result.push('\x0c');
                        *pos += 1;
                    }
                    b'n' => {
                        result.push('\n');
                        *pos += 1;
                    }
                    b'r' => {
                        result.push('\r');
                        *pos += 1;
                    }
                    b't' => {
                        result.push('\t');
                        *pos += 1;
                    }
                    b'u' => {
                        *pos += 1;
                        let code = parse_four_hex(bytes, pos)?;
                        // Surrogate-pair detection (Pitfall #6, 0xD800..=0xDFFF).
                        // High surrogate must be followed by a low surrogate \uXXXX.
                        if (0xD800..=0xDBFF).contains(&code) {
                            if bytes.get(*pos..*pos + 2) != Some(b"\\u") {
                                return Err(ParseError::InvalidUnicode);
                            }
                            *pos += 2;
                            let low = parse_four_hex(bytes, pos)?;
                            if !(0xDC00..=0xDFFF).contains(&low) {
                                return Err(ParseError::InvalidUnicode);
                            }
                            let scalar =
                                (((code - 0xD800) as u32) << 10 | (low - 0xDC00) as u32) + 0x10000;
                            let ch = char::from_u32(scalar).ok_or(ParseError::InvalidUnicode)?;
                            result.push(ch);
                        } else if (0xDC00..=0xDFFF).contains(&code) {
                            // Lone low surrogate — invalid.
                            return Err(ParseError::InvalidUnicode);
                        } else {
                            let ch =
                                char::from_u32(code as u32).ok_or(ParseError::InvalidUnicode)?;
                            result.push(ch);
                        }
                    }
                    _ => return Err(ParseError::InvalidEscape),
                }
            }
            _ => {
                // Raw UTF-8 byte — consume the full multi-byte sequence.
                let ch_start = *pos;
                *pos += 1;
                while *pos < bytes.len() && (bytes[*pos] & 0xC0) == 0x80 {
                    *pos += 1;
                }
                let s = std::str::from_utf8(&bytes[ch_start..*pos])
                    .map_err(|_| ParseError::InvalidUnicode)?;
                result.push_str(s);
            }
        }
    }
}

fn parse_four_hex(bytes: &[u8], pos: &mut usize) -> Result<u16, ParseError> {
    if *pos + 4 > bytes.len() {
        return Err(ParseError::InvalidUnicode);
    }
    let hex = &bytes[*pos..*pos + 4];
    let mut value = 0u16;
    for &byte in hex {
        let digit = match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            b'A'..=b'F' => byte - b'A' + 10,
            _ => return Err(ParseError::InvalidUnicode),
        };
        value = value * 16 + digit as u16;
    }
    *pos += 4;
    Ok(value)
}

/// Parses a JSON number. Uses `Int(i64)` for integers, `Float(f64)` for
/// values containing `.`, `e`, or `E` (CONTEXT D-01 i64+f64 distinction).
fn parse_number(bytes: &[u8], pos: &mut usize) -> Result<RawJsonValue, ParseError> {
    let start = *pos;
    if *pos < bytes.len() && bytes[*pos] == b'-' {
        *pos += 1;
    }
    while *pos < bytes.len() && bytes[*pos].is_ascii_digit() {
        *pos += 1;
    }
    let mut is_float = false;
    if *pos < bytes.len() && bytes[*pos] == b'.' {
        is_float = true;
        *pos += 1;
        while *pos < bytes.len() && bytes[*pos].is_ascii_digit() {
            *pos += 1;
        }
    }
    if *pos < bytes.len() && matches!(bytes[*pos], b'e' | b'E') {
        is_float = true;
        *pos += 1;
        if *pos < bytes.len() && matches!(bytes[*pos], b'+' | b'-') {
            *pos += 1;
        }
        while *pos < bytes.len() && bytes[*pos].is_ascii_digit() {
            *pos += 1;
        }
    }
    let lexeme = std::str::from_utf8(&bytes[start..*pos]).map_err(|_| ParseError::InvalidNumber)?;
    if is_float {
        let f: f64 = lexeme.parse().map_err(|_| ParseError::InvalidNumber)?;
        Ok(RawJsonValue::Float(f))
    } else if let Ok(n) = lexeme.parse::<i64>() {
        Ok(RawJsonValue::Int(n))
    } else {
        // Too large for i64 — fall back to float.
        let f: f64 = lexeme.parse().map_err(|_| ParseError::InvalidNumber)?;
        Ok(RawJsonValue::Float(f))
    }
}

// --- Atomic write ---

/// Writes `body` to `final_path` atomically using a `.tmp` sibling and
/// `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`.
/// On same-volume NTFS, MoveFileExW rename is atomic — no torn writes are
/// visible to readers (RESEARCH Pattern 1, Threat T-02-06 accepted for
/// personal-use scope).
#[cfg(windows)]
fn atomic_write_settings(final_path: &Path, body: &[u8]) -> io::Result<()> {
    let mut tmp_path = final_path.to_path_buf();
    let tmp_name = format!(
        "{}.tmp",
        final_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("settings.json"),
    );
    tmp_path.set_file_name(tmp_name);

    {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp_path)?;
        file.write_all(body)?;
        // sync_all() flushes file data through the OS cache before rename.
        file.sync_all()?;
    } // handle dropped (closed) before MoveFileExW rename

    let src = crate::io::wide(&tmp_path.to_string_lossy());
    let dst = crate::io::wide(&final_path.to_string_lossy());
    if let Err(error) = crate::desktop::ffi::atomic_rename(src.as_ptr(), dst.as_ptr()) {
        // Clean up the orphaned temp file before returning the error.
        let _ = fs::remove_file(&tmp_path);
        return Err(error);
    }
    Ok(())
}

/// Non-Windows fallback: plain write (no atomicity guarantee; used by
/// `serve` / `scan` modes which do not persist settings on non-Windows).
#[cfg(not(windows))]
fn atomic_write_settings(final_path: &Path, body: &[u8]) -> io::Result<()> {
    fs::write(final_path, body)
}

// --- Tests ---

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_empty_object() {
        let result = parse_settings_json("{}").unwrap();
        let expected = Settings::default();
        assert_eq!(result.schema_version, expected.schema_version);
        assert_eq!(result.last_path, expected.last_path);
        assert_eq!(result.dark_mode, expected.dark_mode);
        assert!(result.unknown.is_empty());
        assert!(!result.loaded_from_future);
    }

    #[test]
    fn round_trip_all_known_fields() {
        let original = Settings {
            schema_version: 1,
            last_path: "C:\\Users".to_string(),
            dark_mode: true,
            show_hidden: false,
            follow_symlinks: true,
            columns: vec![100, 200, 300],
            window: WindowGeometry {
                x: 64,
                y: 32,
                w: 1280,
                h: 800,
                unknown: BTreeMap::new(),
            },
            active_tab: "details".to_string(),
            unknown: BTreeMap::new(),
            loaded_from_future: false,
        };
        let mut buf = String::new();
        push_settings_json(&mut buf, &original);
        let parsed = parse_settings_json(&buf).unwrap();
        assert_eq!(parsed.schema_version, original.schema_version);
        assert_eq!(parsed.last_path, original.last_path);
        assert_eq!(parsed.dark_mode, original.dark_mode);
        assert_eq!(parsed.show_hidden, original.show_hidden);
        assert_eq!(parsed.follow_symlinks, original.follow_symlinks);
        assert_eq!(parsed.columns, original.columns);
        assert_eq!(parsed.window.x, original.window.x);
        assert_eq!(parsed.window.y, original.window.y);
        assert_eq!(parsed.window.w, original.window.w);
        assert_eq!(parsed.window.h, original.window.h);
        assert_eq!(parsed.active_tab, original.active_tab);
    }

    #[test]
    fn unknown_keys_preserved_top_level() {
        let json = r#"{"schema_version":1,"future_only":42,"dark_mode":true}"#;
        let parsed = parse_settings_json(json).unwrap();
        let mut buf = String::new();
        push_settings_json(&mut buf, &parsed);
        let reparsed = parse_settings_json(&buf).unwrap();
        assert!(reparsed.dark_mode);
        assert_eq!(
            reparsed.unknown.get("future_only"),
            Some(&RawJsonValue::Int(42))
        );
    }

    #[test]
    fn unknown_keys_preserved_nested_window() {
        let json = r#"{"window":{"x":0,"y":0,"w":800,"h":600,"future_window_key":"v2"}}"#;
        let parsed = parse_settings_json(json).unwrap();
        let mut buf = String::new();
        push_settings_json(&mut buf, &parsed);
        let reparsed = parse_settings_json(&buf).unwrap();
        assert_eq!(
            reparsed.window.unknown.get("future_window_key"),
            Some(&RawJsonValue::Str("v2".to_string()))
        );
    }

    #[test]
    fn escape_seven_round_trip() {
        // The seven standard JSON escape sequences.
        let value = "\\\n\t\"\x08\x0c\r";
        let settings = Settings {
            last_path: value.to_string(),
            ..Settings::default()
        };
        let mut buf = String::new();
        push_settings_json(&mut buf, &settings);
        let parsed = parse_settings_json(&buf).unwrap();
        assert_eq!(parsed.last_path, value);
    }

    #[test]
    fn surrogate_pair_round_trip() {
        // U+1F4A9 PILE OF POO is a surrogate pair in UTF-16/JSON encoding.
        let poop = "\u{1F4A9}";
        // Input with literal emoji (UTF-8 encoded, parser handles raw UTF-8).
        let json = format!(r#"{{"last_path":"{poop}"}}"#);
        let parsed = parse_settings_json(&json).unwrap();
        assert_eq!(parsed.last_path, poop);
        // Re-emit and re-parse to confirm idempotent round-trip.
        let mut buf = String::new();
        push_settings_json(&mut buf, &parsed);
        let reparsed = parse_settings_json(&buf).unwrap();
        assert_eq!(reparsed.last_path, poop);
    }

    #[test]
    fn reject_depth_over_64() {
        // 65 levels of nesting exceeds MAX_DEPTH = 64.
        let json = "{\"k\":".repeat(65) + "null" + &"}".repeat(65);
        let result = parse_settings_json(&json);
        assert!(
            matches!(result, Err(ParseError::DepthExceeded)),
            "expected DepthExceeded, got: {:?}",
            result
        );
    }

    #[test]
    fn reject_trailing_comma() {
        let json = r#"{"dark_mode":true,}"#;
        let result = parse_settings_json(json);
        assert!(result.is_err(), "expected parse error for trailing comma");
    }

    #[test]
    fn schema_version_2_loads_defaults_marks_future() {
        let json = r#"{"schema_version":2,"new_v2_field":"x"}"#;
        let parsed = parse_settings_json(json).unwrap();
        assert!(
            parsed.loaded_from_future,
            "loaded_from_future should be true"
        );
        assert_eq!(
            parsed.schema_version, 2,
            "schema_version should be preserved verbatim"
        );
        assert!(!parsed.dark_mode);
        assert_eq!(parsed.last_path, "");
        assert_eq!(
            parsed.unknown.get("new_v2_field"),
            Some(&RawJsonValue::Str("x".to_string()))
        );
    }

    #[cfg(windows)]
    #[test]
    fn atomic_write_replaces_existing() {
        use std::env;
        let mut dir = env::temp_dir();
        dir.push("filetree_atomic_write_test");
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("settings.json");
        fs::write(&path, b"old").unwrap();
        atomic_write_settings(&path, b"new").unwrap();
        let content = fs::read(&path).unwrap();
        assert_eq!(content, b"new");
        assert!(
            !dir.join("settings.json.tmp").exists(),
            "stale .tmp must not remain"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn integer_and_float_distinguished() {
        let json = r#"{"window":{"x":-10,"y":5,"w":1280,"h":720}}"#;
        let parsed = parse_settings_json(json).unwrap();
        assert_eq!(parsed.window.x, -10);
        assert_eq!(parsed.window.y, 5);
        // Verify float in unknown-key context.
        let float_json = r#"{"future_only":1.5}"#;
        let parsed2 = parse_settings_json(float_json).unwrap();
        assert_eq!(
            parsed2.unknown.get("future_only"),
            Some(&RawJsonValue::Float(1.5))
        );
        // Verify negative integer is Int, not Float.
        let int_json = r#"{"future_only":-10}"#;
        let parsed3 = parse_settings_json(int_json).unwrap();
        assert_eq!(
            parsed3.unknown.get("future_only"),
            Some(&RawJsonValue::Int(-10))
        );
    }

    #[test]
    fn settings_default_round_trip() {
        let original = Settings::default();
        let mut buf = String::new();
        push_settings_json(&mut buf, &original);
        let parsed = parse_settings_json(&buf).unwrap();
        assert_eq!(parsed.schema_version, original.schema_version);
        assert_eq!(parsed.last_path, original.last_path);
        assert_eq!(parsed.dark_mode, original.dark_mode);
        assert_eq!(parsed.show_hidden, original.show_hidden);
        assert_eq!(parsed.follow_symlinks, original.follow_symlinks);
        assert_eq!(parsed.columns, original.columns);
        assert_eq!(parsed.window.x, original.window.x);
        assert_eq!(parsed.window.y, original.window.y);
        assert_eq!(parsed.window.w, original.window.w);
        assert_eq!(parsed.window.h, original.window.h);
        assert!(!parsed.loaded_from_future);
    }

    // Phase 02.1 — active_tab persistence (Plan 02.1-02, D-13)

    #[test]
    fn active_tab_default() {
        let s = Settings::default();
        assert_eq!(s.active_tab, "details");
    }

    #[test]
    fn active_tab_roundtrip() {
        let s = Settings {
            active_tab: "errors".to_string(),
            ..Settings::default()
        };
        let mut buf = String::new();
        push_settings_json(&mut buf, &s);
        // Writer-block sanity check: the literal key/value must appear in output.
        assert!(
            buf.contains("\"active_tab\":\"errors\""),
            "serialized JSON missing active_tab writer block: {buf}",
        );
        let parsed = parse_settings_json(&buf).unwrap();
        assert_eq!(parsed.active_tab, "errors");
        // All other fields round-trip unchanged.
        assert_eq!(parsed.schema_version, s.schema_version);
        assert_eq!(parsed.last_path, s.last_path);
        assert_eq!(parsed.dark_mode, s.dark_mode);
        assert_eq!(parsed.show_hidden, s.show_hidden);
        assert_eq!(parsed.follow_symlinks, s.follow_symlinks);
        assert_eq!(parsed.columns, s.columns);
        assert_eq!(parsed.window.x, s.window.x);
        assert_eq!(parsed.window.y, s.window.y);
        assert_eq!(parsed.window.w, s.window.w);
        assert_eq!(parsed.window.h, s.window.h);
    }

    #[test]
    fn backward_compat_no_active_tab() {
        // Old settings.json (pre-Phase-02.1) has no active_tab key.
        let json = r#"{"schema_version":1,"dark_mode":true}"#;
        let parsed = parse_settings_json(json).unwrap();
        assert_eq!(parsed.active_tab, "details");
        assert!(parsed.dark_mode);
    }
}
