use crate::v2::{ScanQuery, ScanRequest, V2Store};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;

const MAX_REQUEST_BYTES: usize = 1024 * 1024;

pub(crate) fn run_v2_server(port: u16) -> io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    let store = V2Store::open_default().map_err(io::Error::other)?;
    let token = std::env::var("FILETREE_AUTH_TOKEN")
        .ok()
        .filter(|value| !value.is_empty());
    println!("FileTree v2 headless API: http://127.0.0.1:{port}/api/v2/version");
    if token.is_some() {
        println!("Mutation requests require X-FileTree-Token.");
    } else {
        println!("Set FILETREE_AUTH_TOKEN to authenticate scan start/cancel requests.");
    }
    for stream in listener.incoming() {
        match stream {
            Ok(mut stream) => {
                if let Err(error) = handle(&mut stream, &store, token.as_deref()) {
                    eprintln!("FileTree v2 request failed: {error}");
                }
            }
            Err(error) => eprintln!("FileTree v2 accept failed: {error}"),
        }
    }
    Ok(())
}

fn handle(
    stream: &mut TcpStream,
    store: &std::sync::Arc<V2Store>,
    token: Option<&str>,
) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let request = read_request(stream)?;
    let (path, query) = split_query(&request.target);
    if request.method == "GET" && path == "/api/v2/version" {
        return json(
            stream,
            200,
            &serde_json::json!({"version": env!("CARGO_PKG_VERSION")}),
        );
    }
    if request.method == "POST" && path == "/api/v2/scans" {
        if let Err(error) = require_token(&request.headers, token) {
            return error_json(stream, 401, error);
        }
        let scan: ScanRequest = serde_json::from_slice(&request.body)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
        return match store.start_scan(scan, |_| {}) {
            Ok(handle) => json(stream, 202, &handle),
            Err(error) => error_json(stream, 400, &error),
        };
    }
    if let Some(tail) = path.strip_prefix("/api/v2/scans/") {
        let mut parts = tail.split('/');
        let scan_id = parts.next().unwrap_or_default();
        let child = parts.next();
        if request.method == "GET" && child.is_none() {
            return match store.scan_status(scan_id) {
                Some(handle) => json(stream, 200, &handle),
                None => error_json(stream, 404, "Unknown scan"),
            };
        }
        if request.method == "DELETE" && child.is_none() {
            if let Err(error) = require_token(&request.headers, token) {
                return error_json(stream, 401, error);
            }
            return json(
                stream,
                200,
                &serde_json::json!({"cancelled": store.cancel_scan(scan_id)}),
            );
        }
        if request.method == "GET" && child == Some("nodes") {
            let parent_id = query.get("parentId").and_then(|value| value.parse().ok());
            let query = ScanQuery {
                scan_id: scan_id.to_string(),
                parent_id,
                offset: number(&query, "offset", 0),
                limit: number(&query, "limit", 500),
                search: query.get("search").cloned().unwrap_or_default(),
                sort: query
                    .get("sort")
                    .cloned()
                    .unwrap_or_else(|| "size".to_string()),
                direction: query
                    .get("direction")
                    .cloned()
                    .unwrap_or_else(|| "desc".to_string()),
                directories_only: query
                    .get("directoriesOnly")
                    .is_some_and(|value| value == "true" || value == "1"),
                files_only: query
                    .get("filesOnly")
                    .is_some_and(|value| value == "true" || value == "1"),
                regex: query
                    .get("regex")
                    .is_some_and(|value| value == "true" || value == "1"),
                min_size: query.get("minSize").and_then(|value| value.parse().ok()),
                max_size: query.get("maxSize").and_then(|value| value.parse().ok()),
                modified_after: query
                    .get("modifiedAfter")
                    .and_then(|value| value.parse().ok()),
                modified_before: query
                    .get("modifiedBefore")
                    .and_then(|value| value.parse().ok()),
                ext: query.get("ext").cloned().unwrap_or_default(),
                category: query.get("category").cloned().unwrap_or_default(),
            };
            return match store.query_nodes(query) {
                Ok(page) => json(stream, 200, &page),
                Err(error) => error_json(stream, 400, &error),
            };
        }
    }
    error_json(stream, 404, "Unknown v2 endpoint")
}

struct Request {
    method: String,
    target: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> io::Result<Request> {
    let mut bytes = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "incomplete request",
            ));
        }
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.len() > MAX_REQUEST_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request too large",
            ));
        }
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let header = String::from_utf8_lossy(&bytes[..header_end]);
    let mut lines = header.split("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split_whitespace();
    let method = request_line.next().unwrap_or_default().to_string();
    let target = request_line.next().unwrap_or_default().to_string();
    let mut headers = HashMap::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
    }
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0usize);
    if header_end + content_length > MAX_REQUEST_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "request too large",
        ));
    }
    while bytes.len() < header_end + content_length {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
    Ok(Request {
        method,
        target,
        headers,
        body: bytes[header_end..bytes.len().min(header_end + content_length)].to_vec(),
    })
}

fn require_token<'a>(
    headers: &HashMap<String, String>,
    expected: Option<&'a str>,
) -> Result<(), &'a str> {
    let Some(expected) = expected else {
        return Err("FILETREE_AUTH_TOKEN is required for mutations");
    };
    if headers
        .get("x-filetree-token")
        .is_some_and(|actual| actual == expected)
    {
        Ok(())
    } else {
        Err("invalid X-FileTree-Token")
    }
}

fn split_query(target: &str) -> (&str, HashMap<String, String>) {
    let (path, raw) = target.split_once('?').unwrap_or((target, ""));
    let query = raw
        .split('&')
        .filter_map(|part| part.split_once('='))
        .map(|(key, value)| (key.to_string(), percent_decode(value)))
        .collect();
    (path, query)
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(hex) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                out.push(hex);
                index += 3;
                continue;
            }
        }
        out.push(if bytes[index] == b'+' {
            b' '
        } else {
            bytes[index]
        });
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn number(query: &HashMap<String, String>, key: &str, fallback: usize) -> usize {
    query
        .get(key)
        .and_then(|value| value.parse().ok())
        .unwrap_or(fallback)
}

fn json<T: serde::Serialize>(stream: &mut TcpStream, status: u16, value: &T) -> io::Result<()> {
    let body = serde_json::to_vec(value).map_err(io::Error::other)?;
    let reason = if status == 200 {
        "OK"
    } else if status == 202 {
        "Accepted"
    } else {
        "Error"
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(&body)
}

fn error_json(stream: &mut TcpStream, status: u16, error: &str) -> io::Result<()> {
    json(stream, status, &serde_json::json!({"error": error}))
}
