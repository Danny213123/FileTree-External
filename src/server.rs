use std::collections::HashMap;
use std::fs;
use std::io::{self as sio, BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::analytics::{exact_duplicates_json, duplicates_full_json, DupeFilter};
use crate::cli::APP_NAME;
use crate::dupes::{
    DupeFilter2, DupeGroupV2, ReprioritizeCriterion, ScanMode, IgnoreList,
    build_candidates_from_nodes, matches_to_groups, groups_to_json,
    scan_exact, scan_filename, scan_audio, reprioritize,
    action_delete, action_move, action_copy,
};
use crate::export::{
    app_config_json, drives_json, push_json_string, scan_result_to_csv, scan_result_to_json,
    special_folders_json,
};
use crate::io::{default_thread_count, open_path, parse_bool, reveal_path, split_patterns};
use crate::model::{AppState, DupesProgress, HttpRequest, ScanOptions};
use crate::scan::{scan_path, scan_path_with_progress};

const INDEX_HTML: &str = include_str!("../frontend/dist/index.html");
const APP_CSS: &[u8] = include_bytes!("../frontend/dist/assets/index.css");
const APP_JS: &[u8] = include_bytes!("../frontend/dist/assets/index.js");

pub(crate) fn run_server(initial_path: PathBuf, port: u16) -> sio::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;

    // Load persisted ignore list from %APPDATA%\FileTree\ignore_list.json
    let ignore_list_path = {
        let base = std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."));
        base.join("FileTree").join("ignore_list.json")
    };
    let ignore_list = IgnoreList::load(&ignore_list_path).unwrap_or_default();

    let state = Arc::new(AppState {
        initial_path,
        last_scan: Mutex::new(None),
        scan_cache: Mutex::new(std::collections::HashMap::new()),
        icon_cache: Mutex::new(std::collections::HashMap::new()),
        dupes_progress: Arc::new(DupesProgress::default()),
        ignore_list: Mutex::new(ignore_list),
        ignore_list_path,
    });

    println!("{} is running at http://127.0.0.1:{port}", APP_NAME);
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

/// Extract a single string value from naive JSON: `"key":"value"` or `"key": "value"`.
fn extract_json_str(json: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let start = json.find(&needle)? + needle.len();
    let rest = json[start..].trim_start().strip_prefix(':')?;
    let rest = rest.trim_start().strip_prefix('"')?;
    let mut result = String::new();
    let mut chars = rest.chars();
    loop {
        match chars.next()? {
            '"' => return Some(result),
            '\\' => match chars.next()? {
                '"' => result.push('"'),
                '\\' => result.push('\\'),
                'n' => result.push('\n'),
                'r' => result.push('\r'),
                't' => result.push('\t'),
                c => result.push(c),
            },
            c => result.push(c),
        }
    }
}

/// Extract a JSON array of strings: `"key":["a","b"]`.
fn extract_json_str_array(json: &str, key: &str) -> Vec<String> {
    let needle = format!("\"{key}\"");
    let Some(start) = json.find(&needle) else { return Vec::new(); };
    let rest = &json[start + needle.len()..];
    let Some(rest) = rest.trim_start().strip_prefix(':') else { return Vec::new(); };
    let Some(arr_start) = rest.find('[') else { return Vec::new(); };
    let rest = &rest[arr_start + 1..];
    let Some(arr_end) = rest.find(']') else { return Vec::new(); };
    let inner = &rest[..arr_end];

    let mut results = Vec::new();
    let mut remaining = inner;
    while !remaining.is_empty() {
        remaining = remaining.trim_start().trim_start_matches(',').trim_start();
        if !remaining.starts_with('"') { break; }
        remaining = &remaining[1..];
        let mut s = String::new();
        let mut chars = remaining.char_indices();
        let mut end_pos = 0;
        loop {
            match chars.next() {
                None => break,
                Some((i, '"')) => { end_pos = i + 1; break; }
                Some((_, '\\')) => {
                    match chars.next() {
                        Some((_, c)) => match c {
                            '"' => s.push('"'),
                            '\\' => s.push('\\'),
                            'n' => s.push('\n'),
                            'r' => s.push('\r'),
                            't' => s.push('\t'),
                            other => s.push(other),
                        },
                        None => break,
                    }
                }
                Some((_, c)) => s.push(c),
            }
        }
        results.push(s);
        remaining = &remaining[end_pos..];
    }
    results
}

fn build_dupe_filter(query: &std::collections::HashMap<String, String>) -> DupeFilter {
    DupeFilter {
        min_size: query.get("minSize").and_then(|v| v.parse().ok()).unwrap_or(1),
        max_size: query.get("maxSize").and_then(|v| v.parse().ok()),
        extensions: query.get("extensions")
            .map(|v| v.split(',').filter(|s| !s.is_empty()).map(|s| s.to_lowercase()).collect())
            .unwrap_or_default(),
        name_pattern: query.get("namePattern").cloned().unwrap_or_default().to_lowercase(),
        name_exact: query.get("nameExact").map(|v| v == "1").unwrap_or(false),
        date_from: query.get("dateFrom").and_then(|v| v.parse().ok()).unwrap_or(0),
        date_to: query.get("dateTo").and_then(|v| v.parse().ok()).unwrap_or(0),
        keep_prefix: query.get("keepPrefix").cloned().unwrap_or_default(),
        search_prefix: query.get("searchPrefix").cloned().unwrap_or_default(),
    }
}

const SCAN_CACHE_TTL: Duration = Duration::from_secs(300); // 5 minutes

/// Evict cache entries whose path starts with `prefix` (case-insensitive, forward-slash normalised).
fn invalidate_scan_cache(cache: &mut HashMap<String, (Arc<crate::model::ScanResult>, Instant)>, path: &str) {
    let norm = path.replace('\\', "/").to_lowercase();
    cache.retain(|k, _| !k.starts_with(&norm));
}

fn handle_client(mut stream: TcpStream, state: Arc<AppState>) -> sio::Result<()> {
    let request = match read_http_request(&stream) {
        Ok(request) => request,
        Err(error) => {
            respond_text(&mut stream, 400, "Bad request", &error.to_string())?;
            return Ok(());
        }
    };

    let (route, query) = split_target(&request.target);

    // Allow POST for bookmarks and settings routes; all others are GET-only.
    let post_routes = ["/api/bookmarks", "/api/settings", "/api/ai-chat", "/api/watch", "/api/delete"];
    if request.method != "GET" && !(request.method == "POST" && post_routes.contains(&route.as_str())) {
        respond_text(
            &mut stream,
            405,
            "Method not allowed",
            "Only GET is supported",
        )?;
        return Ok(());
    }
    match route.as_str() {
        "/" | "/index.html" => respond_bytes(
            &mut stream,
            200,
            "OK",
            "text/html; charset=utf-8",
            INDEX_HTML.as_bytes(),
            &[],
        ),
        "/assets/index.css" => respond_bytes(
            &mut stream,
            200,
            "OK",
            "text/css; charset=utf-8",
            APP_CSS,
            &[],
        ),
        "/assets/index.js" => respond_bytes(
            &mut stream,
            200,
            "OK",
            "application/javascript; charset=utf-8",
            APP_JS,
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
        "/api/special-folders" => {
            let body = special_folders_json();
            respond_json(&mut stream, 200, "OK", &body)
        }
        "/api/scan" => {
            let path = query
                .get("path")
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| state.initial_path.clone());
            let cache_key = path.to_string_lossy().replace('\\', "/").to_lowercase();

            // Return cached result if still fresh (skip when nocache=1)
            let skip_cache = query.get("nocache").map(|v| v == "1").unwrap_or(false);
            if !skip_cache {
                let mut cache = state.scan_cache.lock().expect("scan_cache lock");
                if let Some((result, ts)) = cache.get(&cache_key) {
                    if ts.elapsed() < SCAN_CACHE_TTL {
                        let body = scan_result_to_json(result);
                        return respond_json(&mut stream, 200, "OK", &body);
                    }
                    cache.remove(&cache_key);
                }
            }

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
                max_depth: query.get("maxdepth").or_else(|| query.get("maxDepth")).and_then(|value| value.parse().ok()),
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
                    state.scan_cache.lock().expect("scan_cache lock")
                        .insert(cache_key, (Arc::clone(&result), Instant::now()));
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
        "/api/dupes" => {
            // Full-detail duplicate scan with rich filters. Requires a prior /api/scan.
            let Some(result) = state.last_scan.lock().expect("scan lock poisoned").clone() else {
                return respond_text(&mut stream, 404, "Not found", "No scan has been run yet");
            };
            let filter = build_dupe_filter(&query);
            let limit = query.get("limit").and_then(|v| v.parse().ok()).unwrap_or(500);
            let body = duplicates_full_json(&result, filter, limit);
            respond_json(&mut stream, 200, "OK", &body)
        }
        "/api/dupes-scan" => {
            // Standalone duplicate scan across one or more paths — no prior scan required.
            // Query: paths=C:\Foo,G:\  (comma-separated, percent-encoded)
            let paths_raw = query.get("paths").cloned().unwrap_or_default();
            if paths_raw.is_empty() {
                return respond_text(&mut stream, 400, "Bad request", "Missing paths");
            }
            let thread_count = query.get("threads")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or_else(default_thread_count);
            let include_hidden = query.get("hidden").map(|v| v == "1").unwrap_or(false);

            // Reset progress counters and enter scan phase.
            let prog = Arc::clone(&state.dupes_progress);
            prog.phase.store(1, Ordering::Relaxed);
            prog.files_scanned.store(0, Ordering::Relaxed);
            prog.files_hashing.store(0, Ordering::Relaxed);
            prog.files_hashed.store(0, Ordering::Relaxed);

            // Scan each path, then merge all nodes with re-indexed IDs.
            let mut merged_nodes: Vec<crate::model::NodeRecord> = Vec::new();
            let mut merged_errors: Vec<crate::model::ScanError> = Vec::new();

            for raw_path in paths_raw.split(',').filter(|s| !s.is_empty()) {
                let options = crate::model::ScanOptions {
                    root: std::path::PathBuf::from(raw_path),
                    threads: thread_count,
                    include_hidden,
                    follow_links: false,
                    exclude_patterns: vec![],
                    max_depth: None,
                };
                let cancel = Arc::new(AtomicBool::new(false));
                let prog2 = Arc::clone(&prog);
                match scan_path_with_progress(options, cancel, move |_dirs, _files, partial| {
                    if let Some(snap) = partial {
                        prog2.files_scanned.store(snap.nodes.len() as u64, Ordering::Relaxed);
                    }
                }) {
                    Ok(result) => {
                        prog.files_scanned.fetch_add(result.nodes.len() as u64, Ordering::Relaxed);
                        let offset = merged_nodes.len();
                        for mut node in result.nodes {
                            node.id += offset;
                            if let Some(p) = node.parent { node.parent = Some(p + offset); }
                            node.children = node.children.into_iter().map(|c| c + offset).collect();
                            merged_nodes.push(node);
                        }
                        merged_errors.extend(result.errors);
                    }
                    Err(e) => {
                        merged_errors.push(crate::model::ScanError {
                            path: raw_path.to_string(),
                            message: e.to_string(),
                        });
                    }
                }
            }

            // Count candidate files for hashing (files with duplicate sizes).
            let total_files = merged_nodes.iter().filter(|n| !n.is_dir).count() as u64;
            prog.phase.store(2, Ordering::Relaxed);
            prog.files_scanned.store(total_files, Ordering::Relaxed);
            prog.files_hashing.store(total_files, Ordering::Relaxed);
            prog.files_hashed.store(0, Ordering::Relaxed);

            let merged = crate::model::ScanResult {
                root_path: paths_raw.replace(',', "; "),
                scanned_at_ms: 0,
                elapsed_ms: 0,
                thread_count,
                nodes: merged_nodes,
                errors: merged_errors,
            };
            let filter = build_dupe_filter(&query);
            let limit = query.get("limit").and_then(|v| v.parse().ok()).unwrap_or(1000);
            let body = duplicates_full_json(&merged, filter, limit);
            prog.phase.store(3, Ordering::Relaxed);
            respond_json(&mut stream, 200, "OK", &body)
        }
        "/api/dupes-progress" => {
            let prog = &state.dupes_progress;
            let phase = prog.phase.load(Ordering::Relaxed);
            let phase_str = match phase {
                1 => "scan",
                2 => "hash",
                3 => "done",
                _ => "idle",
            };
            let files_scanned = prog.files_scanned.load(Ordering::Relaxed);
            let files_hashing = prog.files_hashing.load(Ordering::Relaxed);
            let files_hashed  = prog.files_hashed.load(Ordering::Relaxed);
            let mut body = String::from("{\"phase\":");
            body.push('"'); body.push_str(phase_str); body.push('"');
            body.push_str(",\"filesScanned\":"); body.push_str(&files_scanned.to_string());
            body.push_str(",\"filesHashing\":"); body.push_str(&files_hashing.to_string());
            body.push_str(",\"filesHashed\":");  body.push_str(&files_hashed.to_string());
            body.push('}');
            respond_json(&mut stream, 200, "OK", &body)
        }
        // ── dupeguru-style duplicate detection (V2) ────────────────
        "/api/dupes-v2" => {
            let paths_raw = query.get("paths").cloned().unwrap_or_default();
            if paths_raw.is_empty() {
                return respond_text(&mut stream, 400, "Bad request", "Missing paths");
            }
            let mode_str = query.get("mode").map(|s| s.as_str()).unwrap_or("exact");
            let mode = match mode_str {
                "filename" => ScanMode::Filename,
                "audio"    => ScanMode::Audio,
                _          => ScanMode::Exact,
            };
            let min_score: u8 = query.get("minScore").and_then(|v| v.parse().ok()).unwrap_or(80);
            let weighted   = query.get("weighted").map(|v| v == "1").unwrap_or(false);
            let mix_kinds  = query.get("mixKinds").map(|v| v == "1").unwrap_or(false);
            let tags_raw   = query.get("tags").cloned().unwrap_or_else(|| "artist,title".to_string());
            let active_tags: Vec<String> = tags_raw.split(',').filter(|s| !s.is_empty()).map(|s| s.to_lowercase()).collect();
            let sort_by    = query.get("sortBy").cloned();
            let thread_count = query.get("threads").and_then(|v| v.parse().ok()).unwrap_or_else(default_thread_count);
            let include_hidden = query.get("hidden").map(|v| v == "1").unwrap_or(false);

            let filter = DupeFilter2 {
                min_size: query.get("minSize").and_then(|v| v.parse().ok()).unwrap_or(1),
                max_size: query.get("maxSize").and_then(|v| v.parse().ok()),
                extensions: query.get("extensions")
                    .map(|v| v.split(',').filter(|s| !s.is_empty()).map(|s| s.to_lowercase()).collect())
                    .unwrap_or_default(),
            };

            // Scan each path and merge
            let prog = Arc::clone(&state.dupes_progress);
            prog.phase.store(1, Ordering::Relaxed);
            prog.files_scanned.store(0, Ordering::Relaxed);
            prog.files_hashing.store(0, Ordering::Relaxed);
            prog.files_hashed.store(0, Ordering::Relaxed);

            let mut all_nodes: Vec<crate::model::NodeRecord> = Vec::new();
            let mut scan_errors: Vec<String> = Vec::new();

            for raw_path in paths_raw.split(',').filter(|s| !s.is_empty()) {
                let options = ScanOptions {
                    root: PathBuf::from(raw_path),
                    threads: thread_count,
                    include_hidden,
                    follow_links: false,
                    exclude_patterns: vec![],
                    max_depth: None,
                };
                let cancel = Arc::new(AtomicBool::new(false));
                let prog2 = Arc::clone(&prog);
                match scan_path_with_progress(options, cancel, move |_, _, partial| {
                    if let Some(snap) = partial {
                        prog2.files_scanned.store(snap.nodes.len() as u64, Ordering::Relaxed);
                    }
                }) {
                    Ok(result) => {
                        let offset = all_nodes.len();
                        for mut node in result.nodes {
                            node.id += offset;
                            if let Some(p) = node.parent { node.parent = Some(p + offset); }
                            node.children = node.children.into_iter().map(|c| c + offset).collect();
                            all_nodes.push(node);
                        }
                        for e in result.errors {
                            scan_errors.push(format!("{}: {}", e.path, e.message));
                        }
                    }
                    Err(e) => scan_errors.push(format!("{raw_path}: {e}")),
                }
            }

            prog.phase.store(2, Ordering::Relaxed);

            let candidates = build_candidates_from_nodes(&all_nodes, &filter);

            let ignore = state.ignore_list.lock().expect("ignore lock poisoned");
            let raw_matches = match mode {
                ScanMode::Exact    => scan_exact(&candidates),
                ScanMode::Filename => scan_filename(&candidates, min_score, weighted, mix_kinds),
                ScanMode::Audio    => {
                    let tag_refs: Vec<&str> = active_tags.iter().map(|s| s.as_str()).collect();
                    scan_audio(&candidates, &tag_refs, min_score)
                }
            };
            let ignored_count = ignore.pair_count();
            let mut groups = matches_to_groups(raw_matches, &candidates, mode, &ignore);
            drop(ignore);

            if let Some(ref crit_str) = sort_by {
                if let Some(crit) = ReprioritizeCriterion::from_str(crit_str) {
                    reprioritize(&mut groups, crit);
                }
            }

            prog.phase.store(3, Ordering::Relaxed);
            let body = groups_to_json(&groups, mode, &scan_errors, ignored_count);
            respond_json(&mut stream, 200, "OK", &body)
        }

        "/api/dupes-action" => {
            // POST JSON: { "action": "delete"|"move"|"copy", "paths": [...], "permanent": bool, "dest": "..." }
            let body_str = String::from_utf8_lossy(&request.body);
            let action   = extract_json_str(&body_str, "action").unwrap_or_default();
            let permanent = body_str.contains("\"permanent\":true");
            let dest_str = extract_json_str(&body_str, "dest").unwrap_or_default();
            let paths: Vec<PathBuf> = extract_json_str_array(&body_str, "paths")
                .into_iter().map(PathBuf::from).collect();

            let errors = match action.as_str() {
                "delete" => action_delete(&paths, permanent),
                "move" => {
                    let pairs: Vec<(PathBuf, PathBuf)> = paths.iter().map(|src| {
                        let file_name = src.file_name().unwrap_or_default();
                        (src.clone(), PathBuf::from(&dest_str).join(file_name))
                    }).collect();
                    let refs: Vec<(PathBuf, PathBuf)> = pairs.clone();
                    action_move(&refs)
                }
                "copy" => {
                    let pairs: Vec<(PathBuf, PathBuf)> = paths.iter().map(|src| {
                        let file_name = src.file_name().unwrap_or_default();
                        (src.clone(), PathBuf::from(&dest_str).join(file_name))
                    }).collect();
                    let refs: Vec<(PathBuf, PathBuf)> = pairs.clone();
                    action_copy(&refs)
                }
                _ => vec!["Unknown action".to_string()],
            };

            let ok = errors.is_empty();
            let mut resp = String::from("{\"ok\":");
            resp.push_str(if ok { "true" } else { "false" });
            resp.push_str(",\"errors\":[");
            for (i, e) in errors.iter().enumerate() {
                if i > 0 { resp.push(','); }
                push_json_string(&mut resp, e);
            }
            resp.push_str("]}");
            respond_json(&mut stream, 200, "OK", &resp)
        }

        "/api/dupes-make-ref" => {
            // POST JSON: { "paths": ["C:\\a","D:\\b",...], "refPath": "D:\\b" }
            // Returns the group with files reordered so refPath is first.
            let body_str = String::from_utf8_lossy(&request.body);
            let ref_path_str = extract_json_str(&body_str, "refPath").unwrap_or_default();
            let all_paths = extract_json_str_array(&body_str, "paths");

            // Build a synthetic single-group and reprioritize to put refPath first
            let files: Vec<crate::dupes::DupeFileV2> = all_paths.iter().map(|p| {
                let path = PathBuf::from(p);
                let meta = std::fs::metadata(&path);
                crate::dupes::DupeFileV2 {
                    name: path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string(),
                    size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                    modified: meta.as_ref().ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                    is_ref: p == &ref_path_str,
                    path,
                }
            }).collect();

            // Put the chosen ref first
            let mut ordered = files.clone();
            ordered.sort_by_key(|f| if f.path.to_string_lossy() == ref_path_str { 0usize } else { 1 });
            for (i, f) in ordered.iter_mut().enumerate() { f.is_ref = i == 0; }

            let ref_size = ordered.first().map(|f| f.size).unwrap_or(0);
            let group = DupeGroupV2 {
                files: ordered,
                score: 100,
                waste: ref_size.saturating_mul(files.len().saturating_sub(1) as u64),
            };

            let body = groups_to_json(&[group], ScanMode::Exact, &[], 0);
            respond_json(&mut stream, 200, "OK", &body)
        }

        "/api/dupes-ignore" => {
            if request.method == "DELETE" {
                let mut list = state.ignore_list.lock().expect("ignore lock poisoned");
                list.clear();
                let _ = list.save(&state.ignore_list_path);
                drop(list);
                respond_json(&mut stream, 200, "OK", "{\"ok\":true}")
            } else {
                // POST: { "a": "path1", "b": "path2" }
                let body_str = String::from_utf8_lossy(&request.body);
                let a = extract_json_str(&body_str, "a").unwrap_or_default();
                let b = extract_json_str(&body_str, "b").unwrap_or_default();
                if a.is_empty() || b.is_empty() {
                    return respond_text(&mut stream, 400, "Bad request", "Missing a or b");
                }
                let mut list = state.ignore_list.lock().expect("ignore lock poisoned");
                list.add(std::path::Path::new(&a), std::path::Path::new(&b));
                let count = list.pair_count();
                let _ = list.save(&state.ignore_list_path);
                drop(list);
                let body = format!("{{\"ok\":true,\"count\":{count}}}");
                respond_json(&mut stream, 200, "OK", &body)
            }
        }

        "/api/file-icon" => {
            // Returns the Windows shell icon for a given extension as a 20×20 BMP.
            // Query: ?ext=pdf  (no leading dot)
            // Cached per-process in AppState.icon_cache (Arc<Mutex<HashMap<…>>>).
            let ext = query.get("ext").cloned().unwrap_or_default();
            serve_file_icon(&mut stream, &ext, &state)
        }
        "/api/thumbnail" => {
            let Some(path) = query.get("path") else {
                return respond_text(&mut stream, 400, "Bad request", "Missing path");
            };
            serve_thumbnail(&mut stream, path)
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
                Ok(_) => {
                    // Invalidate cache for the parent directory
                    if let Some(parent) = path_buf.parent() {
                        invalidate_scan_cache(
                            &mut state.scan_cache.lock().expect("scan_cache lock"),
                            &parent.to_string_lossy(),
                        );
                    }
                    respond_json(&mut stream, 200, "OK", "{\"ok\":true}")
                }
                Err(error) => {
                    let mut body = String::from("{\"error\":");
                    push_json_string(&mut body, &error.to_string());
                    body.push('}');
                    respond_json(&mut stream, 400, "Bad request", &body)
                }
            }
        }
        "/api/mkdir" => {
            let Some(path) = query.get("path") else {
                return respond_text(&mut stream, 400, "Bad request", "Missing path");
            };
            let path_buf = PathBuf::from(path);
            match fs::create_dir(&path_buf) {
                Ok(_) => {
                    if let Some(parent) = path_buf.parent() {
                        invalidate_scan_cache(
                            &mut state.scan_cache.lock().expect("scan_cache lock"),
                            &parent.to_string_lossy(),
                        );
                    }
                    respond_json(&mut stream, 200, "OK", "{\"ok\":true}")
                }
                Err(error) => {
                    let mut body = String::from("{\"error\":");
                    push_json_string(&mut body, &error.to_string());
                    body.push('}');
                    respond_json(&mut stream, 400, "Bad request", &body)
                }
            }
        }
        "/api/move" => {
            let (Some(src), Some(dst)) = (query.get("src"), query.get("dst")) else {
                return respond_text(&mut stream, 400, "Bad request", "Missing src or dst");
            };
            match fs::rename(src, dst) {
                Ok(_) => {
                    // Invalidate cache for both source and destination parents
                    let mut cache = state.scan_cache.lock().expect("scan_cache lock");
                    if let Some(p) = Path::new(src).parent() {
                        invalidate_scan_cache(&mut cache, &p.to_string_lossy());
                    }
                    if let Some(p) = Path::new(dst).parent() {
                        invalidate_scan_cache(&mut cache, &p.to_string_lossy());
                    }
                    respond_json(&mut stream, 200, "OK", "{\"ok\":true}")
                }
                Err(error) => {
                    let mut body = String::from("{\"error\":");
                    push_json_string(&mut body, &error.to_string());
                    body.push('}');
                    respond_json(&mut stream, 400, "Bad request", &body)
                }
            }
        }
        "/api/bookmarks" => {
            if request.method == "POST" {
                // Save bookmarks: body is a JSON array of path strings.
                // Write to file, keeping one backup copy.
                match save_bookmarks(&request.body) {
                    Ok(_) => respond_json(&mut stream, 200, "OK", "{\"ok\":true}"),
                    Err(error) => {
                        let mut body = String::from("{\"error\":");
                        push_json_string(&mut body, &error.to_string());
                        body.push('}');
                        respond_json(&mut stream, 500, "Internal server error", &body)
                    }
                }
            } else {
                // GET: return saved bookmarks as JSON array.
                let body = load_bookmarks_json();
                respond_json(&mut stream, 200, "OK", &body)
            }
        }
        "/api/shell-context-menu" => {
            let Some(path) = query.get("path") else {
                return respond_text(&mut stream, 400, "Bad request", "Missing path");
            };
            let x: i32 = query.get("x").and_then(|v| v.parse().ok()).unwrap_or(0);
            let y: i32 = query.get("y").and_then(|v| v.parse().ok()).unwrap_or(0);
            #[cfg(windows)]
            crate::desktop::post_shell_context_menu(path.clone(), x, y);
            #[cfg(not(windows))]
            let _ = (path, x, y);
            respond_json(&mut stream, 200, "OK", "{\"ok\":true}")
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
        "/api/scan-stream" => {
            let path = query
                .get("path")
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| state.initial_path.clone());
            let cache_key = path.to_string_lossy().replace('\\', "/").to_lowercase();

            // If result is cached and fresh, return it as a single NDJSON chunk
            {
                let mut cache = state.scan_cache.lock().expect("scan_cache lock");
                if let Some((result, ts)) = cache.get(&cache_key) {
                    if ts.elapsed() < SCAN_CACHE_TTL {
                        let result = Arc::clone(result);
                        drop(cache);
                        write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson; charset=utf-8\r\nTransfer-Encoding: chunked\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
                        )?;
                        let mut line = scan_result_to_json(&result);
                        line.push('\n');
                        write_chunk(&mut stream, line.as_bytes())?;
                        return write_final_chunk(&mut stream);
                    }
                    cache.remove(&cache_key);
                }
            }

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
                max_depth: query.get("maxdepth").or_else(|| query.get("maxDepth")).and_then(|value| value.parse().ok()),
                threads: query
                    .get("threads")
                    .and_then(|value| value.parse().ok())
                    .unwrap_or_else(default_thread_count),
            };

            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson; charset=utf-8\r\nTransfer-Encoding: chunked\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
            )?;

            let cancel = Arc::new(AtomicBool::new(false));
            let s = &mut stream;
            let scan_result = scan_path_with_progress(options, cancel, |_, _, partial| {
                if let Some(snap) = partial {
                    let mut line = scan_result_to_json(&snap);
                    line.push('\n');
                    let _ = write_chunk(s, line.as_bytes());
                }
            });
            match scan_result {
                Ok(result) => {
                    let result = Arc::new(result);
                    *state.last_scan.lock().expect("scan lock poisoned") =
                        Some(Arc::clone(&result));
                    state.scan_cache.lock().expect("scan_cache lock")
                        .insert(cache_key, (Arc::clone(&result), Instant::now()));
                    let mut line = scan_result_to_json(&result);
                    line.push('\n');
                    write_chunk(&mut stream, line.as_bytes())?;
                }
                Err(error) => {
                    let mut body = String::from("{\"error\":");
                    push_json_string(&mut body, &error.to_string());
                    body.push_str("}\n");
                    write_chunk(&mut stream, body.as_bytes())?;
                }
            }
            write_final_chunk(&mut stream)
        }
        "/api/exit" => {
            respond_json(&mut stream, 200, "OK", "{\"ok\":true}")?;
            std::process::exit(0);
        }
        "/api/settings" => {
            if request.method == "POST" {
                match save_settings_json(&request.body) {
                    Ok(_) => respond_json(&mut stream, 200, "OK", "{\"ok\":true}"),
                    Err(error) => {
                        let mut body = String::from("{\"error\":");
                        push_json_string(&mut body, &error.to_string());
                        body.push('}');
                        respond_json(&mut stream, 500, "Internal server error", &body)
                    }
                }
            } else {
                let body = load_settings_json();
                respond_json(&mut stream, 200, "OK", &body)
            }
        }
        "/api/fs-events" => {
            // Real-time filesystem watch via ReadDirectoryChangesW SSE stream.
            // GET /api/fs-events?path=<root>
            // Streams SSE events; each carries the absolute path of the directory
            // where a change was detected. Replaces the old polling /api/watch.
            let root = query.get("path").cloned().unwrap_or_default();
            if root.is_empty() {
                respond_text(&mut stream, 400, "Bad Request", "path required")
            } else {
                stream_fs_events(stream, root)
            }
        }
        "/api/ai-models" => {
            // Proxy GET http://localhost:11434/api/tags → return model names list
            let body = ollama_list_models();
            respond_json(&mut stream, 200, "OK", &body)
        }
        "/api/ai-chat" => {
            // Proxy POST to Ollama with streaming response.
            // Request body: {"model":"...", "messages":[...]}
            // Response: NDJSON stream (Transfer-Encoding: chunked)
            let ollama_port: u16 = query
                .get("port")
                .and_then(|v| v.parse().ok())
                .unwrap_or(11434);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson; charset=utf-8\r\nTransfer-Encoding: chunked\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
            )?;
            ollama_stream_chat(&mut stream, &request.body, ollama_port)?;
            write_final_chunk(&mut stream)
        }
        _ => respond_text(&mut stream, 404, "Not found", "Not found"),
    }
}

fn write_chunk(stream: &mut TcpStream, data: &[u8]) -> sio::Result<()> {
    write!(stream, "{:X}\r\n", data.len())?;
    stream.write_all(data)?;
    stream.write_all(b"\r\n")?;
    stream.flush()
}

fn write_final_chunk(stream: &mut TcpStream) -> sio::Result<()> {
    stream.write_all(b"0\r\n\r\n")?;
    stream.flush()
}

/// Returns the path to %APPDATA%\FileTree\bookmarks.json (Windows) or
/// ~/.config/filetree/bookmarks.json (non-Windows).
fn bookmarks_path() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("FileTree")
            .join("bookmarks.json")
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".config")
            .join("filetree")
            .join("bookmarks.json")
    }
}

fn load_bookmarks_json() -> String {
    let path = bookmarks_path();
    fs::read_to_string(&path).unwrap_or_else(|_| "[]".to_string())
}

/// Writes bookmark JSON to disk with a .bak backup of the previous file.
fn save_bookmarks(body: &[u8]) -> sio::Result<()> {
    let path = bookmarks_path();
    // Ensure the parent directory exists.
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // Rotate: current → .bak
    if path.exists() {
        let bak = path.with_extension("json.bak");
        let _ = fs::copy(&path, &bak);
    }
    // Atomic-ish write via temp file then rename.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body)?;
    fs::rename(&tmp, &path)
}

fn read_http_request(stream: &TcpStream) -> sio::Result<HttpRequest> {
    use std::io::Read;
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

    let mut content_length: usize = 0;
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if let Some(val) = lower.strip_prefix("content-length:") {
            content_length = val.trim().parse().unwrap_or(0);
        }
    }

    let mut body = vec![0u8; content_length.min(4 * 1024 * 1024)];
    if !body.is_empty() {
        reader.read_exact(&mut body)?;
    }

    Ok(HttpRequest {
        method,
        target,
        body,
    })
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

fn serve_file_icon(stream: &mut TcpStream, ext: &str, state: &AppState) -> sio::Result<()> {
    if ext.is_empty() {
        return respond_text(stream, 400, "Bad Request", "Missing ext");
    }
    let key = ext.to_ascii_lowercase();

    // Hold the lock for the entire render to prevent concurrent threads from all
    // calling SHGetFileInfoW for the same extension simultaneously (some would
    // get null icon handles and return None, causing spurious 404s).
    let mut cache = state.icon_cache.lock().expect("icon_cache poisoned");
    if let Some(png) = cache.get(&key) {
        return respond_bytes(stream, 200, "OK", "image/png", png,
            &[("Cache-Control", "public, max-age=86400")]);
    }

    #[cfg(windows)]
    {
        if let Some(png) = render_shell_icon_png(&key) {
            let result = respond_bytes(stream, 200, "OK", "image/png", &png,
                &[("Cache-Control", "public, max-age=86400")]);
            cache.insert(key, png);
            return result;
        }
    }

    respond_text(stream, 404, "Not Found", "No icon")
}

/// Extract the Windows shell icon for an extension and encode it as a 16×16 RGBA PNG.
#[cfg(windows)]
#[allow(non_snake_case, non_camel_case_types)]
fn render_shell_icon_png(ext: &str) -> Option<Vec<u8>> {
    use std::ffi::c_void;

    const SHGFI_ICON: u32             = 0x0000_0100;
    const SHGFI_SMALLICON: u32        = 0x0000_0001;
    const SHGFI_USEFILEATTRIBUTES: u32= 0x0000_0010;
    const FILE_ATTRIBUTE_NORMAL: u32  = 0x0000_0080;
    const DIB_RGB_COLORS: u32         = 0;
    const DI_NORMAL: u32              = 0x0003;
    const SZ: i32                     = 16;

    #[repr(C)] struct ShFileInfoW {
        hIcon: isize, iIcon: i32, dwAttributes: u32,
        szDisplayName: [u16; 260], szTypeName: [u16; 80],
    }
    #[repr(C)] struct BitmapInfoHeader {
        biSize: u32, biWidth: i32, biHeight: i32, biPlanes: u16,
        biBitCount: u16, biCompression: u32, biSizeImage: u32,
        biXPelsPerMeter: i32, biYPelsPerMeter: i32, biClrUsed: u32, biClrImportant: u32,
    }
    #[repr(C)] struct BitmapInfo { bmiHeader: BitmapInfoHeader, bmiColors: [u32; 1] }

    #[link(name = "Shell32")] unsafe extern "system" {
        fn SHGetFileInfoW(p: *const u16, attr: u32, sfi: *mut ShFileInfoW,
                          cb: u32, flags: u32) -> usize;
    }
    #[link(name = "Gdi32")] unsafe extern "system" {
        fn CreateCompatibleDC(hdc: isize) -> isize;
        fn CreateDIBSection(hdc: isize, bmi: *const BitmapInfo, usage: u32,
                            bits: *mut *mut c_void, section: *mut c_void, offset: u32) -> isize;
        fn SelectObject(hdc: isize, obj: isize) -> isize;
        fn GetDIBits(hdc: isize, hbm: isize, start: u32, lines: u32,
                     bits: *mut c_void, bmi: *mut BitmapInfo, usage: u32) -> i32;
        fn DeleteDC(hdc: isize) -> i32;
        fn DeleteObject(h: isize) -> i32;
    }
    #[link(name = "User32")] unsafe extern "system" {
        fn DrawIconEx(hdc: isize, x: i32, y: i32, hIcon: isize,
                      cx: i32, cy: i32, step: u32, hbr: isize, flags: u32) -> i32;
        fn DestroyIcon(h: isize) -> i32;
    }

    let wide: Vec<u16> = format!(".{ext}").encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        let mut sfi: ShFileInfoW = std::mem::zeroed();
        if SHGetFileInfoW(wide.as_ptr(), FILE_ATTRIBUTE_NORMAL, &mut sfi,
                          std::mem::size_of::<ShFileInfoW>() as u32,
                          SHGFI_ICON | SHGFI_SMALLICON | SHGFI_USEFILEATTRIBUTES) == 0
            || sfi.hIcon == 0 { return None; }

        let hdc = CreateCompatibleDC(0);
        if hdc == 0 { DestroyIcon(sfi.hIcon); return None; }

        // Top-down 32bpp DIB (biHeight negative = top-down, no flip needed)
        let bmi = BitmapInfo {
            bmiHeader: BitmapInfoHeader {
                biSize: std::mem::size_of::<BitmapInfoHeader>() as u32,
                biWidth: SZ, biHeight: -SZ,
                biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0,
                biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
            },
            bmiColors: [0],
        };
        let mut bits_ptr: *mut c_void = std::ptr::null_mut();
        let hbm = CreateDIBSection(hdc, &bmi, DIB_RGB_COLORS, &mut bits_ptr,
                                   std::ptr::null_mut(), 0);
        if hbm == 0 { DeleteDC(hdc); DestroyIcon(sfi.hIcon); return None; }

        SelectObject(hdc, hbm);
        DrawIconEx(hdc, 0, 0, sfi.hIcon, SZ, SZ, 0, 0, DI_NORMAL);

        // Pixel buffer: GetDIBits fills it as BGRA (top-down because biHeight < 0)
        let n = (SZ * SZ) as usize;
        let mut bgra = vec![0u8; n * 4];
        let mut bmi2 = bmi;
        GetDIBits(hdc, hbm, 0, SZ as u32, bgra.as_mut_ptr() as *mut c_void,
                  &mut bmi2, DIB_RGB_COLORS);

        DeleteObject(hbm);
        DeleteDC(hdc);
        DestroyIcon(sfi.hIcon);

        // GDI may leave alpha=0 for fully-opaque pixels rendered by older icon formats.
        // Heuristic: if any pixel has RGB != 0 but A == 0, assume fully opaque icon
        // and set all non-black pixels to A=255.
        let any_alpha = bgra.chunks_exact(4).any(|p| p[3] > 0);
        if !any_alpha {
            for p in bgra.chunks_exact_mut(4) {
                if p[0] | p[1] | p[2] != 0 { p[3] = 255; }
            }
        }

        // Convert BGRA → RGBA for PNG encoding
        let mut rgba = vec![0u8; n * 4];
        for (i, chunk) in bgra.chunks_exact(4).enumerate() {
            let base = i * 4;
            rgba[base]     = chunk[2]; // R
            rgba[base + 1] = chunk[1]; // G
            rgba[base + 2] = chunk[0]; // B
            rgba[base + 3] = chunk[3]; // A
        }

        Some(encode_rgba_png(SZ as u32, SZ as u32, &rgba))
    }
}

// ── Minimal PNG encoder (no external crates) ──────────────────
// Encodes RGBA pixel data as a valid PNG using uncompressed DEFLATE store blocks.

fn encode_rgba_png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(128 + rgba.len());
    // PNG signature
    out.extend_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);
    // IHDR
    let mut ihdr = [0u8; 13];
    ihdr[0..4].copy_from_slice(&width.to_be_bytes());
    ihdr[4..8].copy_from_slice(&height.to_be_bytes());
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // colour type = RGBA
    png_chunk(&mut out, b"IHDR", &ihdr);
    // Raw scanlines: filter byte 0 (None) + row pixels
    let stride = width as usize * 4;
    let mut raw = Vec::with_capacity(height as usize * (1 + stride));
    for row in 0..height as usize {
        raw.push(0); // filter = None
        raw.extend_from_slice(&rgba[row * stride..(row + 1) * stride]);
    }
    // IDAT: zlib-wrapped uncompressed DEFLATE
    let idat = deflate_store_zlib(&raw);
    png_chunk(&mut out, b"IDAT", &idat);
    png_chunk(&mut out, b"IEND", &[]);
    out
}

fn png_chunk(out: &mut Vec<u8>, tag: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(tag);
    out.extend_from_slice(data);
    let crc = png_crc32(tag, data);
    out.extend_from_slice(&crc.to_be_bytes());
}

fn png_crc32(tag: &[u8], data: &[u8]) -> u32 {
    // Standard CRC-32 (ISO 3309 polynomial)
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    let t = TABLE.get_or_init(|| {
        let mut tbl = [0u32; 256];
        for n in 0..256usize {
            let mut c = n as u32;
            for _ in 0..8 { c = if c & 1 != 0 { 0xedb88320 ^ (c >> 1) } else { c >> 1 }; }
            tbl[n] = c;
        }
        tbl
    });
    let mut c = !0u32;
    for &b in tag.iter().chain(data.iter()) { c = t[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8); }
    !c
}

// zlib (RFC 1950) wrapper around uncompressed DEFLATE store blocks (RFC 1951).
fn deflate_store_zlib(data: &[u8]) -> Vec<u8> {
    // CMF=0x78 (deflate, 32K window), FLG=0x01 → (0x78*256+0x01)%31 == 0
    let mut out = vec![0x78u8, 0x01];
    let mut offset = 0;
    loop {
        let end = (offset + 65535).min(data.len());
        let block = &data[offset..end];
        let bfinal = if end == data.len() { 1u8 } else { 0u8 };
        let len = block.len() as u16;
        out.push(bfinal);                               // BFINAL | BTYPE=00
        out.extend_from_slice(&len.to_le_bytes());      // LEN
        out.extend_from_slice(&(!len).to_le_bytes());   // NLEN
        out.extend_from_slice(block);
        offset = end;
        if offset >= data.len() { break; }
    }
    if data.is_empty() {
        // Empty store block
        out.extend_from_slice(&[0x01, 0x00, 0x00, 0xff, 0xff]);
    }
    // Adler-32 checksum (big-endian)
    let (mut s1, mut s2) = (1u32, 0u32);
    for &b in data { s1 = (s1 + b as u32) % 65521; s2 = (s2 + s1) % 65521; }
    out.extend_from_slice(&((s2 << 16) | s1).to_be_bytes());
    out
}

fn serve_thumbnail(stream: &mut TcpStream, path: &str) -> sio::Result<()> {
    let p = std::path::Path::new(path);
    let ext = p.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let is_video = matches!(ext.as_str(), "mp4"|"mkv"|"mov"|"avi"|"wmv"|"webm"|"m4v");
    let content_type = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png"          => "image/png",
        "gif"          => "image/gif",
        "webp"         => "image/webp",
        "bmp"          => "image/bmp",
        "svg"          => "image/svg+xml",
        "mp4" | "m4v"  => "video/mp4",
        "mkv"          => "video/x-matroska",
        "mov"          => "video/quicktime",
        "avi"          => "video/x-msvideo",
        "wmv"          => "video/x-ms-wmv",
        "webm"         => "video/webm",
        _ => return respond_text(stream, 404, "Not Found", "Unsupported type"),
    };

    if is_video {
        // Stream video with chunked encoding so the browser can seek without
        // loading the entire file into the server's memory.
        let file_size = match fs::metadata(p) {
            Ok(m) => m.len(),
            Err(_) => return respond_text(stream, 404, "Not Found", "File not readable"),
        };
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {file_size}\r\n\
             Accept-Ranges: bytes\r\nCache-Control: private, max-age=60\r\nConnection: close\r\n\r\n"
        )?;
        let mut f = match fs::File::open(p) {
            Ok(f) => f,
            Err(_) => return Ok(()),
        };
        let mut buf = [0u8; 65536];
        loop {
            use std::io::Read;
            let n = f.read(&mut buf)?;
            if n == 0 { break; }
            stream.write_all(&buf[..n])?;
        }
        return stream.flush();
    }

    let data = match fs::read(p) {
        Ok(d) => d,
        Err(_) => return respond_text(stream, 404, "Not Found", "File not readable"),
    };
    respond_bytes(stream, 200, "OK", content_type, &data, &[("Cache-Control", "private, max-age=60")])
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

// ── Settings persistence ────────────────────────────────────

fn settings_path() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("FileTree")
            .join("settings.json")
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".config")
            .join("filetree")
            .join("settings.json")
    }
}

fn load_settings_json() -> String {
    fs::read_to_string(settings_path()).unwrap_or_else(|_| "{}".to_string())
}

fn save_settings_json(body: &[u8]) -> sio::Result<()> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body)?;
    fs::rename(&tmp, &path)
}

// ── Smart watch (lightweight mtime token) ───────────────────
//
// We do NOT use ReadDirectoryChangesW here because the server runs on an
// arbitrary thread and managing an overlapped handle across threads needs
// significant FFI plumbing. Instead we use a fast heuristic: hash the
// mtime + size of each immediate child of the watched directory. When the
// Accepts a JSON body of the form:
//   [{"path":"C:\\foo","mtime":1234567890}, ...]
// Stats each directory and returns a JSON array of paths whose mtime changed.
// O(#dirs) stat calls only — no BFS, no reading file contents.
fn watch_changed_dirs(body: &[u8]) -> String {
    // Minimal JSON parse: extract all "path" and "mtime" string/number pairs.
    // Format is a flat array of objects [{path, mtime}, ...].
    let body = std::str::from_utf8(body).unwrap_or("");
    let entries = parse_watch_body(body);
    let mut changed = Vec::new();
    for (path, cached_mtime) in &entries {
        let Ok(meta) = fs::metadata(path) else { continue };
        if !meta.is_dir() { continue }
        let current_mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if current_mtime != *cached_mtime {
            changed.push(path.as_str());
        }
    }
    let mut out = String::from("{\"changed\":[");
    for (i, p) in changed.iter().enumerate() {
        if i > 0 { out.push(','); }
        push_json_string(&mut out, p);
    }
    out.push_str("]}");
    out
}

// Very small hand-rolled parser for [{path:str, mtime:u64}, ...].
// Only handles the exact shape we write on the frontend; no general JSON needed.
fn parse_watch_body(body: &str) -> Vec<(String, u64)> {
    let mut result = Vec::new();
    let bytes = body.as_bytes();
    let mut i = 0;
    // Skip to first '['
    while i < bytes.len() && bytes[i] != b'[' { i += 1; }
    while i < bytes.len() {
        // Find next "path" key
        let Some(p) = find_str(body, "\"path\"", i) else { break };
        let Some(path_val) = extract_string(body, p + 6) else { break };
        // Find "mtime" after the path key
        let Some(m) = find_str(body, "\"mtime\"", p) else { break };
        let mtime_val = extract_number(body, m + 7);
        i = m + 7;
        result.push((path_val, mtime_val));
    }
    result
}

fn find_str(haystack: &str, needle: &str, from: usize) -> Option<usize> {
    haystack[from..].find(needle).map(|pos| from + pos)
}

// Extract the string value after a colon (skips whitespace and quotes).
fn extract_string(s: &str, from: usize) -> Option<String> {
    let bytes = s.as_bytes();
    let mut i = from;
    while i < bytes.len() && bytes[i] != b'"' { i += 1; }
    if i >= bytes.len() { return None; }
    i += 1; // skip opening quote
    let mut out = String::new();
    while i < bytes.len() && bytes[i] != b'"' {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            i += 1;
            match bytes[i] {
                b'"'  => out.push('"'),
                b'\\' => out.push('\\'),
                b'n'  => out.push('\n'),
                b'r'  => out.push('\r'),
                b't'  => out.push('\t'),
                c     => { out.push('\\'); out.push(c as char); }
            }
        } else {
            out.push(bytes[i] as char);
        }
        i += 1;
    }
    Some(out)
}

// Extract a u64 number value after a colon (skips whitespace and colon).
fn extract_number(s: &str, from: usize) -> u64 {
    let bytes = s.as_bytes();
    let mut i = from;
    while i < bytes.len() && (bytes[i] == b':' || bytes[i] == b' ' || bytes[i] == b'\t') { i += 1; }
    let mut n: u64 = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        n = n.saturating_mul(10).saturating_add((bytes[i] - b'0') as u64);
        i += 1;
    }
    n
}

// ── Real-time filesystem event stream ───────────────────────
//
// GET /api/fs-events?path=<root>
//
// Streams Server-Sent Events. Each event carries one JSON string: the
// absolute path of the directory where a change was detected.  The
// frontend debounces and rescans only the affected directories.
//
// Uses ReadDirectoryChangesW (Windows) so latency is < 100 ms rather
// than the 5-second poll that the old /api/watch endpoint used.
// A 500 ms overlapped-wait timeout lets us send SSE keep-alives and
// detect client disconnect without blocking forever.
//
// Non-Windows: falls back to a 1-second mtime poll on the root dir.

pub(crate) fn stream_fs_events(mut stream: TcpStream, root: String) -> sio::Result<()> {
    // SSE headers — no Content-Length, connection stays open
    stream.write_all(
        b"HTTP/1.1 200 OK\r\n\
          Content-Type: text/event-stream\r\n\
          Cache-Control: no-cache\r\n\
          Connection: keep-alive\r\n\
          \r\n",
    )?;
    stream.flush()?;

    #[cfg(windows)]
    {
        stream_fs_events_win32(stream, &root)
    }
    #[cfg(not(windows))]
    {
        stream_fs_events_poll(stream, &root)
    }
}

// ── Windows implementation via ReadDirectoryChangesW ────────

#[cfg(windows)]
fn stream_fs_events_win32(mut stream: TcpStream, root: &str) -> sio::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    type HANDLE = *mut std::ffi::c_void;
    const INVALID_HANDLE_VALUE: HANDLE = usize::MAX as isize as *mut _;
    const OPEN_EXISTING: u32 = 3;
    const FILE_LIST_DIRECTORY: u32 = 0x0001;
    const FILE_SHARE_READ: u32 = 1;
    const FILE_SHARE_WRITE: u32 = 2;
    const FILE_SHARE_DELETE: u32 = 4;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
    // Watch: file name | dir name | attributes | size | last write | creation
    const NOTIFY_FILTER: u32 = 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x40;
    const WAIT_OBJECT_0: u32 = 0;
    const WAIT_TIMEOUT: u32 = 258;

    #[repr(C)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        h_event: HANDLE,
    }

    #[allow(clashing_extern_declarations)]
    unsafe extern "system" {
        fn CreateFileW(
            name: *const u16, access: u32, share: u32,
            sa: *mut std::ffi::c_void, disposition: u32,
            flags: u32, tmpl: *mut std::ffi::c_void,
        ) -> HANDLE;
        fn ReadDirectoryChangesW(
            dir: HANDLE, buf: *mut std::ffi::c_void, buf_len: u32,
            subtree: i32, filter: u32, bytes_ret: *mut u32,
            overlapped: *mut Overlapped, completion: *mut std::ffi::c_void,
        ) -> i32;
        fn GetOverlappedResult(
            handle: HANDLE, overlapped: *mut Overlapped,
            transferred: *mut u32, wait: i32,
        ) -> i32;
        fn CreateEventW(
            attrs: *mut std::ffi::c_void, manual_reset: i32,
            initial: i32, name: *const u16,
        ) -> HANDLE;
        fn ResetEvent(event: HANDLE) -> i32;
        fn CancelIo(handle: HANDLE) -> i32;
        fn CloseHandle(handle: HANDLE) -> i32;
        fn WaitForSingleObject(handle: HANDLE, ms: u32) -> u32;
    }

    // Encode path as null-terminated UTF-16
    let path_wide: Vec<u16> = std::ffi::OsStr::new(root)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    eprintln!("[fs-events] watching: {root}");
    let dir = unsafe {
        CreateFileW(
            path_wide.as_ptr(),
            FILE_LIST_DIRECTORY,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
            std::ptr::null_mut(),
        )
    };
    if dir == INVALID_HANDLE_VALUE {
        eprintln!("[fs-events] CreateFileW failed for: {root}");
        return Ok(());
    }
    eprintln!("[fs-events] handle opened OK");

    let event = unsafe {
        CreateEventW(std::ptr::null_mut(), 1, 0, std::ptr::null())
    };
    if event.is_null() {
        unsafe { CloseHandle(dir); }
        return Ok(());
    }

    let mut ov: Overlapped = unsafe { std::mem::zeroed() };
    ov.h_event = event;

    let mut buf = vec![0u8; 65536];
    let root_trimmed = root.trim_end_matches(['/', '\\']);

    'outer: loop {
        // Issue an async ReadDirectoryChangesW
        let mut dummy_bytes = 0u32;
        unsafe {
            ReadDirectoryChangesW(
                dir,
                buf.as_mut_ptr() as *mut _,
                buf.len() as u32,
                1, // watch subtree
                NOTIFY_FILTER,
                &mut dummy_bytes,
                &mut ov,
                std::ptr::null_mut(),
            )
        };

        // Wait up to 500 ms — allows keep-alives and disconnect detection
        loop {
            let wait = unsafe { WaitForSingleObject(event, 500) };
            match wait {
                WAIT_OBJECT_0 => {
                    eprintln!("[fs-events] change detected");
                    // Change detected — harvest the buffer
                    let mut transferred = 0u32;
                    let ok = unsafe {
                        GetOverlappedResult(dir, &mut ov, &mut transferred, 0)
                    };
                    unsafe { ResetEvent(event); }

                    if ok == 0 || transferred == 0 {
                        // Buffer overflow or handle closed — restart the call
                        break;
                    }

                    // Parse FILE_NOTIFY_INFORMATION records
                    // Layout: [u32 next_offset][u32 action][u32 name_len_bytes][u16... name]
                    let mut changed_dirs: Vec<String> = Vec::new();
                    let mut off = 0usize;
                    loop {
                        if off + 12 > transferred as usize { break; }
                        let next = u32::from_le_bytes(buf[off..off+4].try_into().unwrap()) as usize;
                        let name_bytes = u32::from_le_bytes(buf[off+8..off+12].try_into().unwrap()) as usize;
                        let name_start = off + 12;
                        let name_end = name_start + name_bytes;
                        if name_end <= buf.len() {
                            let u16s: Vec<u16> = buf[name_start..name_end]
                                .chunks(2)
                                .map(|c| u16::from_le_bytes([c[0], c.get(1).copied().unwrap_or(0)]))
                                .collect();
                            let rel = String::from_utf16_lossy(&u16s);
                            // Build absolute path; get parent directory of the changed item
                            let abs = format!("{}\\{}", root_trimmed, rel.replace('/', "\\"));
                            let dir_path = match abs.rfind('\\') {
                                Some(p) => abs[..p].to_string(),
                                None => abs,
                            };
                            if !changed_dirs.contains(&dir_path) {
                                changed_dirs.push(dir_path);
                            }
                        }
                        if next == 0 { break; }
                        off += next;
                    }

                    // Emit one SSE event per changed directory
                    for dir_path in &changed_dirs {
                        let mut event_line = String::from("data: \"");
                        for ch in dir_path.chars() {
                            match ch {
                                '"' => event_line.push_str("\\\""),
                                '\\' => event_line.push_str("\\\\"),
                                c => event_line.push(c),
                            }
                        }
                        event_line.push_str("\"\n\n");
                        if stream.write_all(event_line.as_bytes()).is_err() {
                            break 'outer;
                        }
                    }
                    if !changed_dirs.is_empty() {
                        stream.flush().ok();
                    }
                    break; // re-issue ReadDirectoryChangesW
                }
                WAIT_TIMEOUT => {
                    // Send a comment keep-alive so the browser doesn't time out
                    if stream.write_all(b": ka\n\n").is_err() {
                        break 'outer;
                    }
                    stream.flush().ok();
                    // Keep waiting (the overlapped I/O is still pending)
                }
                _ => break 'outer,
            }
        }
    }

    unsafe {
        CancelIo(dir);
        CloseHandle(dir);
        CloseHandle(event);
    }
    Ok(())
}

// ── Non-Windows fallback: 1-second mtime poll on root ───────

#[cfg(not(windows))]
fn stream_fs_events_poll(mut stream: TcpStream, root: &str) -> sio::Result<()> {
    let mut last_mtime = fs::metadata(root)
        .and_then(|m| m.modified())
        .ok();

    loop {
        std::thread::sleep(Duration::from_secs(1));
        // Keep-alive every second
        if stream.write_all(b": ka\n\n").is_err() { break; }
        stream.flush().ok();

        let cur_mtime = fs::metadata(root).and_then(|m| m.modified()).ok();
        if cur_mtime != last_mtime {
            last_mtime = cur_mtime;
            let mut line = String::from("data: \"");
            for ch in root.chars() {
                if ch == '"' { line.push_str("\\\""); }
                else if ch == '\\' { line.push_str("\\\\"); }
                else { line.push(ch); }
            }
            line.push_str("\"\n\n");
            if stream.write_all(line.as_bytes()).is_err() { break; }
            stream.flush().ok();
        }
    }
    Ok(())
}

// ── Ollama proxy ────────────────────────────────────────────

fn ollama_list_models() -> String {
    use std::io::{BufRead, Read, Write};
    use std::net::TcpStream;
    let Ok(mut conn) = TcpStream::connect("127.0.0.1:11434") else {
        return "{\"models\":[]}".to_string();
    };
    let _ = conn.set_read_timeout(Some(std::time::Duration::from_secs(4)));
    let req = b"GET /api/tags HTTP/1.1\r\nHost: localhost:11434\r\nConnection: close\r\n\r\n";
    if conn.write_all(req).is_err() {
        return "{\"models\":[]}".to_string();
    }
    let mut reader = BufReader::new(&conn);
    // Skip HTTP headers
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
    }
    let mut body = String::new();
    let _ = reader.read_to_string(&mut body);
    if body.is_empty() {
        "{\"models\":[]}".to_string()
    } else {
        body
    }
}

fn ollama_stream_chat(stream: &mut TcpStream, body: &[u8], port: u16) -> sio::Result<()> {
    use std::io::{BufRead, Read, Write};
    let addr = format!("127.0.0.1:{port}");
    let Ok(mut conn) = std::net::TcpStream::connect(&addr) else {
        let msg = b"{\"error\":\"Ollama not running\"}\n";
        return write_chunk(stream, msg);
    };
    let _ = conn.set_read_timeout(Some(std::time::Duration::from_secs(120)));
    let header = format!(
        "POST /api/chat HTTP/1.1\r\nHost: localhost:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    conn.write_all(header.as_bytes())?;
    conn.write_all(body)?;
    conn.flush()?;

    let mut reader = BufReader::new(&conn);
    // Skip HTTP response headers
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return Ok(());
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
    }
    // Stream body lines back to the browser as chunked NDJSON
    let mut buf = Vec::with_capacity(4096);
    let mut tmp = [0u8; 4096];
    loop {
        match reader.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                // Forward each complete newline-terminated JSON line
                while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                    let line_bytes = buf.drain(..=pos).collect::<Vec<_>>();
                    if !line_bytes.iter().all(|&b| b == b'\r' || b == b'\n') {
                        let _ = write_chunk(stream, &line_bytes);
                    }
                }
            }
            Err(_) => break,
        }
    }
    // Flush any remaining bytes
    if !buf.is_empty() {
        let _ = write_chunk(stream, &buf);
    }
    Ok(())
}
