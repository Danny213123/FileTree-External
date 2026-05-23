use std::collections::HashMap;
use std::fs;
use std::io::{self as sio, BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;

use crate::analytics::exact_duplicates_json;
use crate::export::{
    app_config_json, drives_json, push_json_string, scan_result_to_csv, scan_result_to_json,
};
use crate::io::{default_thread_count, open_path, parse_bool, reveal_path, split_patterns};
use crate::model::{AppState, HttpRequest, ScanOptions};
use crate::scan::scan_path;

const INDEX_HTML: &str = include_str!("../web/index.html");
const APP_CSS: &str = include_str!("../web/styles.css");
const APP_JS: &str = include_str!("../web/app.js");

pub(crate) fn run_server(initial_path: PathBuf, port: u16) -> sio::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    let state = Arc::new(AppState {
        initial_path,
        last_scan: Mutex::new(None),
    });

    println!("{} is running at http://127.0.0.1:{port}", crate::APP_NAME);
    println!("Press Ctrl+C to stop.");

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let state = Arc::clone(&state);
                thread::spawn(move || {
                    if let Err(error) = handle_client(stream, state) {
                        eprintln!("request failed: {error}");
                    }
                });
            }
            Err(error) => eprintln!("connection failed: {error}"),
        }
    }

    Ok(())
}

fn handle_client(mut stream: TcpStream, state: Arc<AppState>) -> sio::Result<()> {
    let request = match read_http_request(&stream) {
        Ok(request) => request,
        Err(error) => {
            respond_text(&mut stream, 400, "Bad request", &error.to_string())?;
            return Ok(());
        }
    };

    if request.method != "GET" {
        respond_text(
            &mut stream,
            405,
            "Method not allowed",
            "Only GET is supported",
        )?;
        return Ok(());
    }

    let (route, query) = split_target(&request.target);
    match route.as_str() {
        "/" | "/index.html" => respond_bytes(
            &mut stream,
            200,
            "OK",
            "text/html; charset=utf-8",
            INDEX_HTML.as_bytes(),
            &[],
        ),
        "/styles.css" => respond_bytes(
            &mut stream,
            200,
            "OK",
            "text/css; charset=utf-8",
            APP_CSS.as_bytes(),
            &[],
        ),
        "/app.js" => respond_bytes(
            &mut stream,
            200,
            "OK",
            "application/javascript; charset=utf-8",
            APP_JS.as_bytes(),
            &[],
        ),
        "/api/config" => {
            let body = app_config_json(&state);
            respond_json(&mut stream, 200, "OK", &body)
        }
        "/api/drives" => {
            let body = drives_json();
            respond_json(&mut stream, 200, "OK", &body)
        }
        "/api/scan" => {
            let path = query
                .get("path")
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| state.initial_path.clone());
            let options = ScanOptions {
                root: path,
                include_hidden: query
                    .get("hidden")
                    .map(|value| parse_bool(value))
                    .unwrap_or(true),
                follow_links: query
                    .get("follow")
                    .map(|value| parse_bool(value))
                    .unwrap_or(false),
                exclude_patterns: query
                    .get("exclude")
                    .map(|value| split_patterns(value))
                    .unwrap_or_default(),
                max_depth: query.get("maxDepth").and_then(|value| value.parse().ok()),
                threads: query
                    .get("threads")
                    .and_then(|value| value.parse().ok())
                    .unwrap_or_else(default_thread_count),
            };

            match scan_path(options) {
                Ok(result) => {
                    let result = Arc::new(result);
                    *state.last_scan.lock().expect("scan lock poisoned") =
                        Some(Arc::clone(&result));
                    let body = scan_result_to_json(&result);
                    respond_json(&mut stream, 200, "OK", &body)
                }
                Err(error) => {
                    let mut body = String::from("{\"error\":");
                    push_json_string(&mut body, &error.to_string());
                    body.push('}');
                    respond_json(&mut stream, 400, "Bad request", &body)
                }
            }
        }
        "/api/export.csv" => {
            let Some(result) = state.last_scan.lock().expect("scan lock poisoned").clone() else {
                return respond_text(&mut stream, 404, "Not found", "No scan has been run yet");
            };
            let body = scan_result_to_csv(&result);
            respond_bytes(
                &mut stream,
                200,
                "OK",
                "text/csv; charset=utf-8",
                body.as_bytes(),
                &[(
                    "Content-Disposition",
                    "attachment; filename=\"filetree-scan.csv\"",
                )],
            )
        }
        "/api/export.json" => {
            let Some(result) = state.last_scan.lock().expect("scan lock poisoned").clone() else {
                return respond_text(&mut stream, 404, "Not found", "No scan has been run yet");
            };
            let body = scan_result_to_json(&result);
            respond_bytes(
                &mut stream,
                200,
                "OK",
                "application/json; charset=utf-8",
                body.as_bytes(),
                &[(
                    "Content-Disposition",
                    "attachment; filename=\"filetree-scan.json\"",
                )],
            )
        }
        "/api/duplicates" => {
            let Some(result) = state.last_scan.lock().expect("scan lock poisoned").clone() else {
                return respond_text(&mut stream, 404, "Not found", "No scan has been run yet");
            };
            let min_size = query
                .get("minSize")
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(1024 * 1024);
            let limit = query
                .get("limit")
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(100);
            let body = exact_duplicates_json(&result, min_size, limit);
            respond_json(&mut stream, 200, "OK", &body)
        }
        "/api/reveal" => {
            let Some(path) = query.get("path") else {
                return respond_text(&mut stream, 400, "Bad request", "Missing path");
            };
            reveal_path(path)?;
            respond_json(&mut stream, 200, "OK", "{\"ok\":true}")
        }
        "/api/open" => {
            let Some(path) = query.get("path") else {
                return respond_text(&mut stream, 400, "Bad request", "Missing path");
            };
            open_path(path)?;
            respond_json(&mut stream, 200, "OK", "{\"ok\":true}")
        }
        "/api/delete" => {
            let Some(path) = query.get("path") else {
                return respond_text(&mut stream, 400, "Bad request", "Missing path");
            };
            let path_buf = PathBuf::from(path);
            let delete_result = if path_buf.is_dir() {
                fs::remove_dir_all(&path_buf)
            } else {
                fs::remove_file(&path_buf)
            };
            match delete_result {
                Ok(_) => respond_json(&mut stream, 200, "OK", "{\"ok\":true}"),
                Err(error) => {
                    let mut body = String::from("{\"error\":");
                    push_json_string(&mut body, &error.to_string());
                    body.push('}');
                    respond_json(&mut stream, 400, "Bad request", &body)
                }
            }
        }
        "/api/properties" => {
            let Some(path) = query.get("path") else {
                return respond_text(&mut stream, 400, "Bad request", "Missing path");
            };
            let p = path.clone();
            thread::spawn(move || {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                let script = format!(
                    "(New-Object -ComObject Shell.Application).NameSpace((Split-Path '{}')).ParseName((Split-Path '{}' -Leaf)).InvokeVerb('Properties')",
                    p.replace("'", "''"),
                    p.replace("'", "''")
                );
                let _ = Command::new("powershell")
                    .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn();
            });
            respond_json(&mut stream, 200, "OK", "{\"ok\":true}")
        }
        _ => respond_text(&mut stream, 404, "Not found", "Not found"),
    }
}

fn read_http_request(stream: &TcpStream) -> sio::Result<HttpRequest> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut first_line = String::new();
    reader.read_line(&mut first_line)?;
    let mut parts = first_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| sio::Error::new(sio::ErrorKind::InvalidData, "missing method"))?
        .to_string();
    let target = parts
        .next()
        .ok_or_else(|| sio::Error::new(sio::ErrorKind::InvalidData, "missing target"))?
        .to_string();

    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
    }

    Ok(HttpRequest { method, target })
}

fn respond_text(stream: &mut TcpStream, status: u16, reason: &str, body: &str) -> sio::Result<()> {
    respond_bytes(
        stream,
        status,
        reason,
        "text/plain; charset=utf-8",
        body.as_bytes(),
        &[],
    )
}

fn respond_json(stream: &mut TcpStream, status: u16, reason: &str, body: &str) -> sio::Result<()> {
    respond_bytes(
        stream,
        status,
        reason,
        "application/json; charset=utf-8",
        body.as_bytes(),
        &[],
    )
}

fn respond_bytes(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    content_type: &str,
    body: &[u8],
    extra_headers: &[(&str, &str)],
) -> sio::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n",
        body.len()
    )?;
    for (name, value) in extra_headers {
        write!(stream, "{name}: {value}\r\n")?;
    }
    stream.write_all(b"\r\n")?;
    stream.write_all(body)?;
    stream.flush()
}

fn split_target(target: &str) -> (String, HashMap<String, String>) {
    let (route, query_string) = target.split_once('?').unwrap_or((target, ""));
    let mut query = HashMap::new();
    for pair in query_string.split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        query.insert(percent_decode(key), percent_decode(value));
    }
    (route.to_string(), query)
}

fn percent_decode(value: &str) -> String {
    let mut output = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                output.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hi = hex_value(bytes[index + 1]);
                let lo = hex_value(bytes[index + 2]);
                if let (Some(hi), Some(lo)) = (hi, lo) {
                    output.push((hi << 4) | lo);
                    index += 3;
                } else {
                    output.push(bytes[index]);
                    index += 1;
                }
            }
            byte => {
                output.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}
