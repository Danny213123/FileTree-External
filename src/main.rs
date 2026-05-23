#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod io;
mod model;
use crate::io::{
    current_dir_or_dot, default_thread_count, display_name, epoch_ms_to_utc, extension_for,
    first_positional_arg, has_flag, is_hidden_entry, metadata_modified_ms, now_ms, open_path,
    option_value, parse_bool, path_to_string, platform_allocated_size, reveal_path, should_exclude,
    should_recurse, split_patterns,
};
use crate::model::*;

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::env;
use std::fs::{self, File, Metadata};
use std::io::{self as sio, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const APP_NAME: &str = "FileTree";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const INDEX_HTML: &str = include_str!("../web/index.html");
const APP_CSS: &str = include_str!("../web/styles.css");
const APP_JS: &str = include_str!("../web/app.js");

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print_usage();
        return;
    }

    if args.is_empty() {
        let result = run_desktop(current_dir_or_dot());
        if let Err(error) = result {
            eprintln!("{}: {}", APP_NAME, error);
            std::process::exit(1);
        }
        return;
    }

    let result = match args[0].as_str() {
        "desktop" | "gui" => {
            let initial_path = option_value(&args, "--path")
                .map(PathBuf::from)
                .or_else(|| first_positional_arg(&args[1..]).map(PathBuf::from))
                .unwrap_or_else(current_dir_or_dot);
            run_desktop(initial_path)
        }
        "serve" => {
            let initial_path = option_value(&args, "--path")
                .map(PathBuf::from)
                .unwrap_or_else(current_dir_or_dot);
            let port = option_value(&args, "--port")
                .and_then(|value| value.parse::<u16>().ok())
                .unwrap_or(7878);
            run_server(initial_path, port)
        }
        "scan" => run_scan_command(&args[1..]),
        _ => {
            print_usage();
            Ok(())
        }
    };

    if let Err(error) = result {
        eprintln!("{}: {}", APP_NAME, error);
        std::process::exit(1);
    }
}

fn print_usage() {
    println!(
        "{APP_NAME} {APP_VERSION}

Usage:
  filetree
  filetree desktop [--path PATH]
  filetree serve [--path PATH] [--port PORT]
  filetree scan PATH [--format json|csv] [--out FILE] [--threads N] [--exclude PATTERNS]

Examples:
  filetree desktop --path D:\\Data
  filetree serve --path C:\\ --port 7878
  filetree scan D:\\Data --format csv --out report.csv
"
    );
}

fn run_desktop(initial_path: PathBuf) -> sio::Result<()> {
    #[cfg(windows)]
    {
        desktop::run(initial_path)
    }

    #[cfg(not(windows))]
    {
        let _ = initial_path;
        Err(sio::Error::new(
            sio::ErrorKind::Unsupported,
            "the native desktop app is currently implemented for Windows",
        ))
    }
}

fn run_scan_command(args: &[String]) -> sio::Result<()> {
    let path = option_value(args, "--path")
        .map(PathBuf::from)
        .or_else(|| first_positional_arg(args).map(PathBuf::from))
        .unwrap_or_else(current_dir_or_dot);
    let format = option_value(args, "--format").unwrap_or_else(|| "json".to_string());
    let out = option_value(args, "--out");
    let options = ScanOptions {
        root: path,
        include_hidden: !has_flag(args, "--no-hidden"),
        follow_links: has_flag(args, "--follow-links"),
        exclude_patterns: option_value(args, "--exclude")
            .map(|value| split_patterns(&value))
            .unwrap_or_default(),
        max_depth: option_value(args, "--max-depth").and_then(|value| value.parse().ok()),
        threads: option_value(args, "--threads")
            .and_then(|value| value.parse().ok())
            .unwrap_or_else(default_thread_count),
    };

    let result = scan_path(options)?;
    let body = match format.as_str() {
        "csv" => scan_result_to_csv(&result),
        "json" => scan_result_to_json(&result),
        other => {
            return Err(sio::Error::new(
                sio::ErrorKind::InvalidInput,
                format!("unsupported format '{other}'"),
            ));
        }
    };

    if let Some(out) = out {
        fs::write(out, body)?;
    } else {
        println!("{body}");
    }

    Ok(())
}

fn run_server(initial_path: PathBuf, port: u16) -> sio::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    let state = Arc::new(AppState {
        initial_path,
        last_scan: Mutex::new(None),
    });

    println!("{APP_NAME} is running at http://127.0.0.1:{port}");
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

fn scan_path(options: ScanOptions) -> sio::Result<ScanResult> {
    scan_path_with_progress(options, Arc::new(AtomicBool::new(false)), |_, _, _| {})
}

fn scan_path_with_progress<F>(
    options: ScanOptions,
    cancel: Arc<AtomicBool>,
    mut progress: F,
) -> sio::Result<ScanResult>
where
    F: FnMut(usize, u128, Option<ScanResult>),
{
    if !options.root.exists() {
        return Err(sio::Error::new(
            sio::ErrorKind::NotFound,
            format!("path does not exist: {}", options.root.display()),
        ));
    }

    let started = Instant::now();
    let scanned_at_ms = now_ms();
    let root_metadata = fs::symlink_metadata(&options.root)?;
    let root_is_link = root_metadata.file_type().is_symlink();
    let root_is_dir = root_metadata.is_dir();
    let root_hidden = is_hidden_entry(&options.root, &root_metadata);
    let root_node = NodeRecord {
        id: 0,
        parent: None,
        name: display_name(&options.root),
        path: path_to_string(&options.root),
        is_dir: root_is_dir,
        is_link: root_is_link,
        hidden: root_hidden,
        readonly: root_metadata.permissions().readonly(),
        size: if root_is_dir { 0 } else { root_metadata.len() },
        allocated: if root_is_dir {
            0
        } else {
            platform_allocated_size(&options.root, &root_metadata)
        },
        files: if root_is_dir { 0 } else { 1 },
        folders: 0,
        modified_ms: metadata_modified_ms(&root_metadata),
        depth: 0,
        errors: 0,
        children: Vec::new(),
        extension: if root_is_dir {
            String::new()
        } else {
            extension_for(&options.root)
        },
    };

    let queue = if root_is_dir {
        VecDeque::from([0usize])
    } else {
        VecDeque::new()
    };
    let done = queue.is_empty();
    let thread_count = options.threads.clamp(1, 64);
    let shared = Arc::new(WorkerShared {
        options,
        nodes: Mutex::new(vec![root_node]),
        errors: Mutex::new(Vec::new()),
        queue: Mutex::new(QueueState {
            dirs: queue,
            active: 0,
            done,
        }),
        queue_ready: Condvar::new(),
        cancel,
    });

    let mut handles = Vec::with_capacity(thread_count);
    for _ in 0..thread_count {
        let shared = Arc::clone(&shared);
        handles.push(thread::spawn(move || worker_loop(shared)));
    }

    let mut last_progress_nodes = 0usize;
    loop {
        thread::sleep(Duration::from_millis(1500));
        let scan_done = {
            let queue = shared.queue.lock().expect("queue lock poisoned");
            queue.done
        };
        let node_count = shared.nodes.lock().expect("nodes lock poisoned").len();
        if node_count != last_progress_nodes || scan_done {
            let partial = if !scan_done {
                Some(snapshot_scan_result(
                    &shared,
                    scanned_at_ms,
                    started.elapsed().as_millis(),
                    thread_count,
                ))
            } else {
                None
            };
            progress(node_count, started.elapsed().as_millis(), partial);
            last_progress_nodes = node_count;
        }
        if scan_done {
            break;
        }
    }

    for handle in handles {
        let _ = handle.join();
    }

    Ok(snapshot_scan_result(
        &shared,
        scanned_at_ms,
        started.elapsed().as_millis(),
        thread_count,
    ))
}

fn snapshot_scan_result(
    shared: &WorkerShared,
    scanned_at_ms: u128,
    elapsed_ms: u128,
    thread_count: usize,
) -> ScanResult {
    // Clone nodes and errors while holding their locks, then drop locks
    // immediately so worker threads are not blocked during aggregation.
    let mut nodes = shared.nodes.lock().expect("nodes lock poisoned").clone();
    let errors = shared.errors.lock().expect("errors lock poisoned").clone();

    // Aggregation is O(n log n) and must not hold any shared lock.
    aggregate_nodes(&mut nodes);

    ScanResult {
        root_path: nodes
            .first()
            .map(|node| node.path.clone())
            .unwrap_or_default(),
        scanned_at_ms,
        elapsed_ms,
        thread_count,
        nodes,
        errors,
    }
}

struct ActiveGuard {
    shared: Arc<WorkerShared>,
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        let mut queue = self.shared.queue.lock().expect("queue lock poisoned");
        queue.active = queue.active.saturating_sub(1);
        if queue.dirs.is_empty() && queue.active == 0 {
            queue.done = true;
            self.shared.queue_ready.notify_all();
        }
    }
}

fn worker_loop(shared: Arc<WorkerShared>) {
    loop {
        if shared.cancel.load(Ordering::Relaxed) {
            let mut queue = shared.queue.lock().expect("queue lock poisoned");
            queue.done = true;
            shared.queue_ready.notify_all();
            return;
        }

        let job_id = {
            let mut queue = shared.queue.lock().expect("queue lock poisoned");
            loop {
                if shared.cancel.load(Ordering::Relaxed) {
                    queue.done = true;
                    shared.queue_ready.notify_all();
                    break None;
                }
                if let Some(id) = queue.dirs.pop_front() {
                    queue.active += 1;
                    break Some(id);
                }
                if queue.done {
                    break None;
                }
                queue = shared
                    .queue_ready
                    .wait(queue)
                    .expect("queue lock poisoned after wait");
            }
        };

        let Some(dir_id) = job_id else {
            return;
        };

        {
            let _guard = ActiveGuard {
                shared: Arc::clone(&shared),
            };
            scan_directory_job(&shared, dir_id);
        }
    }
}

fn scan_directory_job(shared: &Arc<WorkerShared>, dir_id: usize) {
    if shared.cancel.load(Ordering::Relaxed) {
        return;
    }

    let (dir_path, dir_depth) = {
        let nodes = shared.nodes.lock().expect("nodes lock poisoned");
        let Some(node) = nodes.get(dir_id) else {
            return;
        };
        (PathBuf::from(&node.path), node.depth)
    };

    let entries = match fs::read_dir(&dir_path) {
        Ok(entries) => entries,
        Err(error) => {
            add_scan_error(shared, dir_id, &dir_path, error.to_string());
            return;
        }
    };

    let mut dirs_to_scan = Vec::new();
    for entry in entries {
        if shared.cancel.load(Ordering::Relaxed) {
            break;
        }

        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                add_scan_error(shared, dir_id, &dir_path, error.to_string());
                continue;
            }
        };

        let entry_path = entry.path();
        let metadata = match metadata_for_entry(&entry_path, shared.options.follow_links) {
            Ok(metadata) => metadata,
            Err(error) => {
                add_scan_error(shared, dir_id, &entry_path, error.to_string());
                continue;
            }
        };

        let is_link = fs::symlink_metadata(&entry_path)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false);
        let is_dir = metadata.is_dir();
        let hidden = is_hidden_entry(&entry_path, &metadata);
        if hidden && !shared.options.include_hidden {
            continue;
        }

        let name = display_name(&entry_path);
        let path_string = path_to_string(&entry_path);
        if should_exclude(&shared.options.exclude_patterns, &name, &path_string) {
            continue;
        }

        let depth = dir_depth + 1;
        let is_file_like = !is_dir;
        let size = if is_file_like { metadata.len() } else { 0 };
        let allocated = if is_file_like {
            platform_allocated_size(&entry_path, &metadata)
        } else {
            0
        };
        let node = NodeRecord {
            id: 0,
            parent: Some(dir_id),
            name,
            path: path_string,
            is_dir,
            is_link,
            hidden,
            readonly: metadata.permissions().readonly(),
            size,
            allocated,
            files: if is_file_like { 1 } else { 0 },
            folders: 0,
            modified_ms: metadata_modified_ms(&metadata),
            depth,
            errors: 0,
            children: Vec::new(),
            extension: if is_file_like {
                extension_for(&entry_path)
            } else {
                String::new()
            },
        };

        let child_id = add_node(shared, node);
        if is_dir && should_recurse(depth, shared.options.max_depth) {
            dirs_to_scan.push(child_id);
        } else if is_dir && shared.options.max_depth.is_some() {
            add_scan_error(
                shared,
                child_id,
                &entry_path,
                "depth limit reached".to_string(),
            );
        }
    }

    if !dirs_to_scan.is_empty() {
        let mut queue = shared.queue.lock().expect("queue lock poisoned");
        for id in dirs_to_scan {
            queue.dirs.push_back(id);
        }
        shared.queue_ready.notify_all();
    }
}

fn metadata_for_entry(path: &Path, follow_links: bool) -> sio::Result<Metadata> {
    let symlink_metadata = fs::symlink_metadata(path)?;
    if follow_links && symlink_metadata.file_type().is_symlink() {
        fs::metadata(path)
    } else {
        Ok(symlink_metadata)
    }
}

fn add_node(shared: &WorkerShared, mut node: NodeRecord) -> usize {
    let mut nodes = shared.nodes.lock().expect("nodes lock poisoned");
    let id = nodes.len();
    node.id = id;
    if let Some(parent) = node.parent
        && let Some(parent_node) = nodes.get_mut(parent)
    {
        parent_node.children.push(id);
    }
    nodes.push(node);
    id
}

fn add_scan_error(shared: &WorkerShared, node_id: usize, path: &Path, message: String) {
    {
        let mut nodes = shared.nodes.lock().expect("nodes lock poisoned");
        if let Some(node) = nodes.get_mut(node_id) {
            node.errors += 1;
        }
    }
    shared
        .errors
        .lock()
        .expect("errors lock poisoned")
        .push(ScanError {
            path: path_to_string(path),
            message,
        });
}

fn aggregate_nodes(nodes: &mut [NodeRecord]) {
    let mut order: Vec<usize> = (0..nodes.len()).collect();
    order.sort_by(|left, right| nodes[*right].depth.cmp(&nodes[*left].depth));

    for id in order {
        if !nodes[id].is_dir {
            continue;
        }

        let children = nodes[id].children.clone();
        let mut size = 0u64;
        let mut allocated = 0u64;
        let mut files = 0u64;
        let mut folders = 0u64;
        let mut errors = nodes[id].errors;
        let mut modified_ms = nodes[id].modified_ms;

        for child in children {
            size = size.saturating_add(nodes[child].size);
            allocated = allocated.saturating_add(nodes[child].allocated);
            files = files.saturating_add(nodes[child].files);
            errors = errors.saturating_add(nodes[child].errors);
            modified_ms = modified_ms.max(nodes[child].modified_ms);
            if nodes[child].is_dir {
                folders = folders
                    .saturating_add(1)
                    .saturating_add(nodes[child].folders);
            }
        }

        nodes[id].size = size;
        nodes[id].allocated = allocated;
        nodes[id].files = files;
        nodes[id].folders = folders;
        nodes[id].errors = errors;
        nodes[id].modified_ms = modified_ms;
    }

    let sizes: Vec<u64> = nodes.iter().map(|node| node.size).collect();
    let names: Vec<String> = nodes.iter().map(|node| node.name.to_lowercase()).collect();
    for node in nodes.iter_mut() {
        node.children.sort_by(|left, right| {
            sizes[*right]
                .cmp(&sizes[*left])
                .then_with(|| names[*left].cmp(&names[*right]))
        });
    }
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

fn scan_result_to_json(result: &ScanResult) -> String {
    let top_files = top_file_ids(&result.nodes, 100);
    let largest_dirs = largest_dir_ids(&result.nodes, 100);
    let extension_stats = extension_stats(&result.nodes, 80);
    let age_stats = age_stats(&result.nodes, result.scanned_at_ms);
    let duplicate_candidates = duplicate_candidates(&result.nodes, 100);

    let mut output = String::with_capacity(result.nodes.len().saturating_mul(260));
    output.push('{');
    output.push_str("\"app\":");
    push_json_string(&mut output, APP_NAME);
    output.push_str(",\"version\":");
    push_json_string(&mut output, APP_VERSION);
    output.push_str(",\"rootPath\":");
    push_json_string(&mut output, &result.root_path);
    output.push_str(",\"scannedAt\":");
    output.push_str(&result.scanned_at_ms.to_string());
    output.push_str(",\"elapsedMs\":");
    output.push_str(&result.elapsed_ms.to_string());
    output.push_str(",\"threadCount\":");
    output.push_str(&result.thread_count.to_string());
    output.push_str(",\"nodeCount\":");
    output.push_str(&result.nodes.len().to_string());
    output.push_str(",\"errorCount\":");
    output.push_str(&result.errors.len().to_string());

    output.push_str(",\"nodes\":[");
    for (index, node) in result.nodes.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push('{');
        output.push_str("\"id\":");
        output.push_str(&node.id.to_string());
        output.push_str(",\"parent\":");
        match node.parent {
            Some(parent) => output.push_str(&parent.to_string()),
            None => output.push_str("null"),
        }
        output.push_str(",\"name\":");
        push_json_string(&mut output, &node.name);
        output.push_str(",\"path\":");
        push_json_string(&mut output, &node.path);
        output.push_str(",\"dir\":");
        output.push_str(if node.is_dir { "true" } else { "false" });
        output.push_str(",\"link\":");
        output.push_str(if node.is_link { "true" } else { "false" });
        output.push_str(",\"hidden\":");
        output.push_str(if node.hidden { "true" } else { "false" });
        output.push_str(",\"readonly\":");
        output.push_str(if node.readonly { "true" } else { "false" });
        output.push_str(",\"size\":");
        output.push_str(&node.size.to_string());
        output.push_str(",\"allocated\":");
        output.push_str(&node.allocated.to_string());
        output.push_str(",\"files\":");
        output.push_str(&node.files.to_string());
        output.push_str(",\"folders\":");
        output.push_str(&node.folders.to_string());
        output.push_str(",\"modified\":");
        output.push_str(&node.modified_ms.to_string());
        output.push_str(",\"depth\":");
        output.push_str(&node.depth.to_string());
        output.push_str(",\"errors\":");
        output.push_str(&node.errors.to_string());
        output.push_str(",\"extension\":");
        push_json_string(&mut output, &node.extension);
        output.push_str(",\"children\":[");
        for (child_index, child) in node.children.iter().enumerate() {
            if child_index > 0 {
                output.push(',');
            }
            output.push_str(&child.to_string());
        }
        output.push_str("]}");
    }
    output.push(']');

    output.push_str(",\"topFiles\":");
    push_id_array(&mut output, &top_files);
    output.push_str(",\"largestDirs\":");
    push_id_array(&mut output, &largest_dirs);

    output.push_str(",\"extensionStats\":[");
    for (index, stat) in extension_stats.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push('{');
        output.push_str("\"ext\":");
        push_json_string(&mut output, &stat.ext);
        output.push_str(",\"bytes\":");
        output.push_str(&stat.bytes.to_string());
        output.push_str(",\"allocated\":");
        output.push_str(&stat.allocated.to_string());
        output.push_str(",\"files\":");
        output.push_str(&stat.files.to_string());
        output.push('}');
    }
    output.push(']');

    output.push_str(",\"ageStats\":[");
    for (index, stat) in age_stats.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push('{');
        output.push_str("\"label\":");
        push_json_string(&mut output, stat.label);
        output.push_str(",\"bytes\":");
        output.push_str(&stat.bytes.to_string());
        output.push_str(",\"files\":");
        output.push_str(&stat.files.to_string());
        output.push('}');
    }
    output.push(']');

    output.push_str(",\"duplicateCandidates\":[");
    for (index, group) in duplicate_candidates.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push('{');
        output.push_str("\"name\":");
        push_json_string(&mut output, &group.name);
        output.push_str(",\"size\":");
        output.push_str(&group.size.to_string());
        output.push_str(",\"waste\":");
        output.push_str(&group.waste.to_string());
        output.push_str(",\"ids\":");
        push_id_array(&mut output, &group.ids);
        output.push('}');
    }
    output.push(']');

    output.push_str(",\"scanErrors\":[");
    for (index, error) in result.errors.iter().take(500).enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push('{');
        output.push_str("\"path\":");
        push_json_string(&mut output, &error.path);
        output.push_str(",\"message\":");
        push_json_string(&mut output, &error.message);
        output.push('}');
    }
    output.push(']');

    output.push('}');
    output
}

fn scan_result_to_csv(result: &ScanResult) -> String {
    let mut output = String::from(
        "Path,Name,Type,Size,Allocated,Files,Folders,PercentOfParent,ModifiedUtc,Hidden,Readonly,Link,Errors\n",
    );
    for node in &result.nodes {
        let parent_size = node
            .parent
            .and_then(|parent| result.nodes.get(parent))
            .map(|parent| parent.size)
            .unwrap_or(node.size);
        let percent = if parent_size > 0 {
            (node.size as f64 / parent_size as f64) * 100.0
        } else {
            0.0
        };
        push_csv_field(&mut output, &node.path);
        output.push(',');
        push_csv_field(&mut output, &node.name);
        output.push(',');
        output.push_str(if node.is_dir { "Directory" } else { "File" });
        output.push(',');
        output.push_str(&node.size.to_string());
        output.push(',');
        output.push_str(&node.allocated.to_string());
        output.push(',');
        output.push_str(&node.files.to_string());
        output.push(',');
        output.push_str(&node.folders.to_string());
        output.push(',');
        output.push_str(&format!("{percent:.4}"));
        output.push(',');
        push_csv_field(&mut output, &epoch_ms_to_utc(node.modified_ms));
        output.push(',');
        output.push_str(if node.hidden { "true" } else { "false" });
        output.push(',');
        output.push_str(if node.readonly { "true" } else { "false" });
        output.push(',');
        output.push_str(if node.is_link { "true" } else { "false" });
        output.push(',');
        output.push_str(&node.errors.to_string());
        output.push('\n');
    }
    output
}

fn app_config_json(state: &AppState) -> String {
    let mut output = String::from("{\"initialPath\":");
    push_json_string(&mut output, &path_to_string(&state.initial_path));
    output.push_str(",\"defaultThreads\":");
    output.push_str(&default_thread_count().to_string());
    output.push('}');
    output
}

fn drives_json() -> String {
    let mut roots = Vec::new();

    #[cfg(windows)]
    {
        for letter in b'A'..=b'Z' {
            let root = format!("{}:\\", letter as char);
            if Path::new(&root).exists() {
                roots.push(root);
            }
        }
    }

    #[cfg(not(windows))]
    {
        roots.push("/".to_string());
        if let Some(home) = env::var_os("HOME") {
            roots.push(PathBuf::from(home).display().to_string());
        }
    }

    if let Some(profile) = env::var_os("USERPROFILE") {
        let profile = PathBuf::from(profile).display().to_string();
        if !roots.iter().any(|root| root == &profile) {
            roots.push(profile);
        }
    }

    let mut output = String::from("{\"roots\":[");
    for (index, root) in roots.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        push_json_string(&mut output, root);
    }
    output.push_str("]}");
    output
}

fn exact_duplicates_json(result: &ScanResult, min_size: u64, limit: usize) -> String {
    let mut by_size: HashMap<u64, Vec<usize>> = HashMap::new();
    for node in &result.nodes {
        if !node.is_dir && node.size >= min_size && node.size > 0 {
            by_size.entry(node.size).or_default().push(node.id);
        }
    }

    let mut groups = Vec::<(u64, u64, Vec<usize>)>::new();
    let mut hash_errors = Vec::<ScanError>::new();
    for (size, ids) in by_size.into_iter().filter(|(_, ids)| ids.len() > 1) {
        let mut by_hash: HashMap<u64, Vec<usize>> = HashMap::new();
        for id in ids {
            match fnv1a_file(Path::new(&result.nodes[id].path)) {
                Ok(hash) => by_hash.entry(hash).or_default().push(id),
                Err(error) => hash_errors.push(ScanError {
                    path: result.nodes[id].path.clone(),
                    message: error.to_string(),
                }),
            }
        }
        for (hash, ids) in by_hash.into_iter().filter(|(_, ids)| ids.len() > 1) {
            groups.push((size, hash, ids));
        }
    }

    groups.sort_by(|left, right| {
        let left_waste = left.0.saturating_mul(left.2.len().saturating_sub(1) as u64);
        let right_waste = right
            .0
            .saturating_mul(right.2.len().saturating_sub(1) as u64);
        right_waste.cmp(&left_waste)
    });
    groups.truncate(limit);

    let mut output = String::from("{\"minSize\":");
    output.push_str(&min_size.to_string());
    output.push_str(",\"groups\":[");
    for (index, (size, hash, ids)) in groups.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        let waste = size.saturating_mul(ids.len().saturating_sub(1) as u64);
        output.push('{');
        output.push_str("\"size\":");
        output.push_str(&size.to_string());
        output.push_str(",\"hash\":");
        push_json_string(&mut output, &format!("{hash:016x}"));
        output.push_str(",\"waste\":");
        output.push_str(&waste.to_string());
        output.push_str(",\"ids\":");
        push_id_array(&mut output, ids);
        output.push('}');
    }
    output.push_str("],\"errors\":[");
    for (index, error) in hash_errors.iter().take(200).enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push('{');
        output.push_str("\"path\":");
        push_json_string(&mut output, &error.path);
        output.push_str(",\"message\":");
        push_json_string(&mut output, &error.message);
        output.push('}');
    }
    output.push_str("]}");
    output
}

fn fnv1a_file(path: &Path) -> sio::Result<u64> {
    let mut file = File::open(path)?;
    let mut buffer = [0u8; 1024 * 1024];
    let mut hash = 0xcbf29ce484222325u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        for byte in &buffer[..read] {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    Ok(hash)
}

fn top_file_ids(nodes: &[NodeRecord], limit: usize) -> Vec<usize> {
    let mut ids: Vec<usize> = nodes
        .iter()
        .filter(|node| !node.is_dir)
        .map(|node| node.id)
        .collect();
    ids.sort_by(|left, right| nodes[*right].size.cmp(&nodes[*left].size));
    ids.truncate(limit);
    ids
}

fn largest_dir_ids(nodes: &[NodeRecord], limit: usize) -> Vec<usize> {
    let mut ids: Vec<usize> = nodes
        .iter()
        .filter(|node| node.is_dir)
        .map(|node| node.id)
        .collect();
    ids.sort_by(|left, right| nodes[*right].size.cmp(&nodes[*left].size));
    ids.truncate(limit);
    ids
}

fn extension_stats(nodes: &[NodeRecord], limit: usize) -> Vec<ExtensionStat> {
    let mut stats: BTreeMap<String, ExtensionStat> = BTreeMap::new();
    for node in nodes.iter().filter(|node| !node.is_dir) {
        let ext = if node.extension.is_empty() {
            "[none]".to_string()
        } else {
            node.extension.clone()
        };
        let entry = stats.entry(ext.clone()).or_insert(ExtensionStat {
            ext,
            bytes: 0,
            allocated: 0,
            files: 0,
        });
        entry.bytes = entry.bytes.saturating_add(node.size);
        entry.allocated = entry.allocated.saturating_add(node.allocated);
        entry.files = entry.files.saturating_add(1);
    }
    let mut stats: Vec<ExtensionStat> = stats.into_values().collect();
    stats.sort_by_key(|stat| std::cmp::Reverse(stat.bytes));
    stats.truncate(limit);
    stats
}

fn age_stats(nodes: &[NodeRecord], scanned_at_ms: u128) -> Vec<AgeBucket> {
    let mut buckets = vec![
        AgeBucket {
            label: "7 days",
            bytes: 0,
            files: 0,
        },
        AgeBucket {
            label: "30 days",
            bytes: 0,
            files: 0,
        },
        AgeBucket {
            label: "90 days",
            bytes: 0,
            files: 0,
        },
        AgeBucket {
            label: "1 year",
            bytes: 0,
            files: 0,
        },
        AgeBucket {
            label: "older",
            bytes: 0,
            files: 0,
        },
        AgeBucket {
            label: "unknown",
            bytes: 0,
            files: 0,
        },
    ];

    for node in nodes.iter().filter(|node| !node.is_dir) {
        let bucket = if node.modified_ms == 0 || node.modified_ms > scanned_at_ms {
            5
        } else {
            let days = ((scanned_at_ms - node.modified_ms) / 86_400_000) as u64;
            match days {
                0..=7 => 0,
                8..=30 => 1,
                31..=90 => 2,
                91..=365 => 3,
                _ => 4,
            }
        };
        buckets[bucket].bytes = buckets[bucket].bytes.saturating_add(node.size);
        buckets[bucket].files = buckets[bucket].files.saturating_add(1);
    }

    buckets
}

fn duplicate_candidates(nodes: &[NodeRecord], limit: usize) -> Vec<DuplicateCandidate> {
    let mut groups: HashMap<(u64, String), Vec<usize>> = HashMap::new();
    for node in nodes.iter().filter(|node| !node.is_dir && node.size > 0) {
        groups
            .entry((node.size, node.name.to_lowercase()))
            .or_default()
            .push(node.id);
    }

    let mut candidates = Vec::new();
    for ((size, name), ids) in groups.into_iter().filter(|(_, ids)| ids.len() > 1) {
        let waste = size.saturating_mul(ids.len().saturating_sub(1) as u64);
        candidates.push(DuplicateCandidate {
            name,
            size,
            waste,
            ids,
        });
    }
    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.waste));
    candidates.truncate(limit);
    candidates
}

fn push_id_array(output: &mut String, ids: &[usize]) {
    output.push('[');
    for (index, id) in ids.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push_str(&id.to_string());
    }
    output.push(']');
}

fn push_json_string(output: &mut String, value: &str) {
    output.push('"');
    for ch in value.chars() {
        match ch {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            ch if ch < ' ' => output.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => output.push(ch),
        }
    }
    output.push('"');
}

fn push_csv_field(output: &mut String, value: &str) {
    let needs_quotes =
        value.contains(',') || value.contains('"') || value.contains('\n') || value.contains('\r');
    if needs_quotes {
        output.push('"');
        for ch in value.chars() {
            if ch == '"' {
                output.push('"');
            }
            output.push(ch);
        }
        output.push('"');
    } else {
        output.push_str(value);
    }
}

#[cfg(windows)]
mod desktop {
    #![allow(dead_code)]
    #![allow(clippy::manual_is_multiple_of)]
    #![allow(clippy::manual_range_contains)]
    #![allow(clippy::too_many_arguments)]
    #![allow(clippy::upper_case_acronyms)]
    #![allow(non_upper_case_globals)]
    #![allow(non_snake_case)]
    #![allow(unsafe_op_in_unsafe_fn)]

    use super::*;
    use std::ffi::{OsStr, c_void};
    use std::io;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null, null_mut};
    use std::sync::{Mutex, OnceLock};

    type Bool = i32;
    type Dword = u32;
    type Hbrush = isize;
    type Hcursor = isize;
    type Hdc = isize;
    type Hfont = isize;
    type Hicon = isize;
    type Hinstance = isize;
    type Hmenu = isize;
    type Hgdobj = isize;
    type Hwnd = isize;
    type Lparam = isize;
    type Lresult = isize;
    type Uint = u32;
    type Wparam = usize;
    type Handle = isize;
    type UlongPtr = usize;

    #[repr(C)]
    struct ACTCTXW {
        cbSize: Dword,
        dwFlags: Dword,
        lpSource: *const u16,
        wProcessorArchitecture: u16,
        wLangId: u16,
        lpAssemblyDirectory: *const u16,
        lpResourceName: *const u16,
        lpApplicationName: *const u16,
        hModule: Hinstance,
    }

    const CS_HREDRAW: Uint = 0x0002;
    const CS_VREDRAW: Uint = 0x0001;
    const CS_DBLCLKS: Uint = 0x0008;
    const CW_USEDEFAULT: i32 = 0x80000000u32 as i32;
    const ES_AUTOHSCROLL: Dword = 0x0080;
    const FILE_ATTRIBUTE_DIRECTORY: Dword = 0x0000_0010;
    const FILE_ATTRIBUTE_NORMAL: Dword = 0x0000_0080;
    const ICC_LISTVIEW_CLASSES: Dword = 0x0000_0001;
    const IDC_ARROW: usize = 32512;
    const IDI_APPLICATION: usize = 32512;
    const DI_NORMAL: Uint = 0x0003;
    const DT_END_ELLIPSIS: Uint = 0x0000_8000;
    const DT_LEFT: Uint = 0x0000_0000;
    const DT_CENTER: Uint = 0x0000_0001;
    const DT_NOPREFIX: Uint = 0x0000_0800;
    const DT_RIGHT: Uint = 0x0000_0002;
    const DT_SINGLELINE: Uint = 0x0000_0020;
    const DT_VCENTER: Uint = 0x0000_0004;
    const IMAGE_ICON: Uint = 1;
    const LR_SHARED: Uint = 0x8000;
    const MB_ICONERROR: Uint = 0x0000_0010;
    const MB_OK: Uint = 0x0000_0000;
    const SHGFI_SMALLICON: Uint = 0x0000_0001;
    const SHGFI_ICON: Uint = 0x0000_0100;
    const SHGFI_USEFILEATTRIBUTES: Uint = 0x0000_0010;
    const SW_SHOW: i32 = 5;
    const TRANSPARENT: i32 = 1;
    const WM_APP: Uint = 0x8000;
    const WM_COMMAND: Uint = 0x0111;
    const WM_CREATE: Uint = 0x0001;
    const WM_CTLCOLOREDIT: Uint = 0x0133;
    const WM_CTLCOLORBTN: Uint = 0x0135;
    const WM_CTLCOLORSTATIC: Uint = 0x0138;
    const WM_DESTROY: Uint = 0x0002;
    const WM_KEYDOWN: Uint = 0x0100;
    const WM_LBUTTONDBLCLK: Uint = 0x0203;
    const WM_LBUTTONDOWN: Uint = 0x0201;
    const WM_MOUSEWHEEL: Uint = 0x020a;
    const WM_NOTIFY: Uint = 0x004e;
    const WM_PAINT: Uint = 0x000f;
    const WM_SETFONT: Uint = 0x0030;
    const WM_SIZE: Uint = 0x0005;
    const WS_BORDER: Dword = 0x0080_0000;
    const WS_CHILD: Dword = 0x4000_0000;
    const WS_OVERLAPPEDWINDOW: Dword = 0x00cf_0000;
    const WS_TABSTOP: Dword = 0x0001_0000;
    const WS_VISIBLE: Dword = 0x1000_0000;
    const BS_AUTOCHECKBOX: Dword = 0x0000_0003;
    const BS_PUSHBUTTON: Dword = 0x0000_0000;
    const COINIT_APARTMENTTHREADED: Dword = 0x0000_0002;
    const BM_GETCHECK: Uint = 0x00f0;
    const BM_SETCHECK: Uint = 0x00f1;
    const BST_CHECKED: Wparam = 1;
    const BIF_RETURNONLYFSDIRS: Uint = 0x0000_0001;
    const BIF_NEWDIALOGSTYLE: Uint = 0x0000_0040;
    const MAX_VISIBLE_ROWS: usize = 20_000;
    const VK_DOWN: Wparam = 0x28;
    const VK_END: Wparam = 0x23;
    const VK_HOME: Wparam = 0x24;
    const VK_NEXT: Wparam = 0x22;
    const VK_PRIOR: Wparam = 0x21;
    const VK_UP: Wparam = 0x26;

    const WM_ERASEBKGND: Uint = 0x0014;
    const WM_RBUTTONDOWN: Uint = 0x0204;
    const WM_RBUTTONUP: Uint = 0x0205;
    const WM_MOUSEMOVE: Uint = 0x0200;
    const CF_UNICODETEXT: Uint = 13;
    const GMEM_MOVEABLE: Uint = 0x0002;
    const MF_STRING: Uint = 0x0000_0000;
    const MF_SEPARATOR: Uint = 0x0000_0800;
    const TPM_LEFTALIGN: Uint = 0x0000;
    const TPM_RIGHTBUTTON: Uint = 0x0002;
    const SRCCOPY: Dword = 0x00CC0020;

    const ID_PATH_EDIT: isize = 101;
    const ID_SCAN_BUTTON: isize = 102;
    const ID_REFRESH_BUTTON: isize = 103;
    const ID_HIDDEN_CHECK: isize = 104;
    const ID_FILES_CHECK: isize = 105;
    const ID_FOLLOW_CHECK: isize = 106;
    const ID_BROWSE_BUTTON: isize = 107;
    const ID_STOP_BUTTON: isize = 108;
    const ID_EXPAND_BUTTON: isize = 109;
    const ID_COLLAPSE_BUTTON: isize = 110;
    const ID_COLUMNS_BUTTON: isize = 111;
    const ID_DARK_CHECK: isize = 112;
    const ID_STATUS: isize = 201;

    const ID_MENU_OPEN: isize = 3001;
    const ID_MENU_REVEAL: isize = 3002;
    const ID_MENU_COPY_PATH: isize = 3003;
    const ID_MENU_DELETE: isize = 3004;
    const ID_MENU_PROPERTIES: isize = 3005;

    const WM_SCAN_DONE: Uint = WM_APP + 7;
    const WM_SCAN_PROGRESS: Uint = WM_APP + 8;

    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }

    static STATE: OnceLock<Mutex<DesktopState>> = OnceLock::new();
    static DARK_BRUSH: OnceLock<Hbrush> = OnceLock::new();
    static LIGHT_BRUSH: OnceLock<Hbrush> = OnceLock::new();
    static DARK_MODE_ATOMIC: AtomicBool = AtomicBool::new(true);

    #[repr(C)]
    struct InitCommonControlsEx {
        dwSize: Dword,
        dwICC: Dword,
    }

    #[repr(C)]
    struct Msg {
        hwnd: Hwnd,
        message: Uint,
        wParam: Wparam,
        lParam: Lparam,
        time: Dword,
        pt_x: i32,
        pt_y: i32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    struct WndClassW {
        style: Uint,
        lpfnWndProc: Option<unsafe extern "system" fn(Hwnd, Uint, Wparam, Lparam) -> Lresult>,
        cbClsExtra: i32,
        cbWndExtra: i32,
        hInstance: Hinstance,
        hIcon: Hicon,
        hCursor: Hcursor,
        hbrBackground: Hbrush,
        lpszMenuName: *const u16,
        lpszClassName: *const u16,
    }

    #[repr(C)]
    struct BrowseInfoW {
        hwndOwner: Hwnd,
        pidlRoot: *mut c_void,
        pszDisplayName: *mut u16,
        lpszTitle: *const u16,
        ulFlags: Uint,
        lpfn: Option<unsafe extern "system" fn(Hwnd, Uint, Lparam, Lparam) -> i32>,
        lParam: Lparam,
        iImage: i32,
    }

    #[repr(C)]
    struct ShFileInfoW {
        hIcon: Hicon,
        iIcon: i32,
        dwAttributes: Dword,
        szDisplayName: [u16; 260],
        szTypeName: [u16; 80],
    }

    #[repr(C)]
    struct PaintStruct {
        hdc: Hdc,
        fErase: Bool,
        rcPaint: Rect,
        fRestore: Bool,
        fIncUpdate: Bool,
        rgbReserved: [u8; 32],
    }

    #[link(name = "Comctl32")]
    unsafe extern "system" {
        fn InitCommonControlsEx(picce: *const InitCommonControlsEx) -> Bool;
    }

    #[link(name = "Dwmapi")]
    unsafe extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: Hwnd,
            dwAttribute: Dword,
            pvAttribute: *const c_void,
            cbAttribute: Dword,
        ) -> i32;
    }

    #[link(name = "Gdi32")]
    unsafe extern "system" {
        fn CreateFontW(
            cHeight: i32,
            cWidth: i32,
            cEscapement: i32,
            cOrientation: i32,
            cWeight: i32,
            bItalic: Dword,
            bUnderline: Dword,
            bStrikeOut: Dword,
            iCharSet: Dword,
            iOutPrecision: Dword,
            iClipPrecision: Dword,
            iQuality: Dword,
            iPitchAndFamily: Dword,
            pszFaceName: *const u16,
        ) -> Hfont;
        fn CreateSolidBrush(color: Dword) -> Hbrush;
        fn DeleteObject(ho: Hgdobj) -> Bool;
        fn SelectObject(hdc: Hdc, h: Hgdobj) -> Hgdobj;
        fn SetBkColor(hdc: Hdc, color: Dword) -> Dword;
        fn SetBkMode(hdc: Hdc, mode: i32) -> i32;
        fn SetTextColor(hdc: Hdc, color: Dword) -> Dword;
        fn CreateCompatibleDC(hdc: Hdc) -> Hdc;
        fn CreateCompatibleBitmap(hdc: Hdc, cx: i32, cy: i32) -> Hgdobj;
        fn DeleteDC(hdc: Hdc) -> Bool;
        fn BitBlt(
            hdcDest: Hdc,
            xDest: i32,
            yDest: i32,
            w: i32,
            h: i32,
            hdcSrc: Hdc,
            xSrc: i32,
            ySrc: i32,
            rop: Dword,
        ) -> Bool;
    }

    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn GetModuleHandleW(lpModuleName: *const u16) -> Hinstance;
        fn GlobalAlloc(uFlags: Uint, dwBytes: usize) -> isize;
        fn GlobalLock(hMem: isize) -> *mut c_void;
        fn GlobalUnlock(hMem: isize) -> Bool;
        fn GlobalFree(hMem: isize) -> isize;
        fn GetDiskFreeSpaceExW(
            lpDirectoryName: *const u16,
            lpFreeBytesAvailableToCaller: *mut u64,
            lpTotalNumberOfBytes: *mut u64,
            lpTotalNumberOfFreeBytes: *mut u64,
        ) -> Bool;
        fn CreateActCtxW(pActCtx: *const ACTCTXW) -> Handle;
        fn ActivateActCtx(hActCtx: Handle, lpCookie: *mut UlongPtr) -> Bool;
    }

    #[link(name = "Ole32")]
    unsafe extern "system" {
        fn CoInitializeEx(pvReserved: *mut c_void, dwCoInit: Dword) -> i32;
        fn CoTaskMemFree(pv: *mut c_void);
        fn CoUninitialize();
    }

    #[link(name = "Shell32")]
    unsafe extern "system" {
        fn SHBrowseForFolderW(lpbi: *mut BrowseInfoW) -> *mut c_void;
        fn SHGetFileInfoW(
            pszPath: *const u16,
            dwFileAttributes: Dword,
            psfi: *mut ShFileInfoW,
            cbFileInfo: Uint,
            uFlags: Uint,
        ) -> usize;
        fn SHGetPathFromIDListW(pidl: *mut c_void, pszPath: *mut u16) -> Bool;
        fn ShellExecuteW(
            hwnd: Hwnd,
            lpOperation: *const u16,
            lpFile: *const u16,
            lpParameters: *const u16,
            lpDirectory: *const u16,
            nShowCmd: i32,
        ) -> isize;
    }

    #[link(name = "UxTheme")]
    unsafe extern "system" {
        fn SetWindowTheme(hwnd: Hwnd, pszSubAppName: *const u16, pszSubIdList: *const u16) -> i32;
    }

    #[link(name = "User32")]
    unsafe extern "system" {
        fn BeginPaint(hWnd: Hwnd, lpPaint: *mut PaintStruct) -> Hdc;
        fn CreateWindowExW(
            dwExStyle: Dword,
            lpClassName: *const u16,
            lpWindowName: *const u16,
            dwStyle: Dword,
            X: i32,
            Y: i32,
            nWidth: i32,
            nHeight: i32,
            hWndParent: Hwnd,
            hMenu: Hmenu,
            hInstance: Hinstance,
            lpParam: *mut c_void,
        ) -> Hwnd;
        fn DefWindowProcW(hwnd: Hwnd, msg: Uint, wparam: Wparam, lparam: Lparam) -> Lresult;
        fn DestroyIcon(hIcon: Hicon) -> Bool;
        fn DrawIconEx(
            hdc: Hdc,
            xLeft: i32,
            yTop: i32,
            hIcon: Hicon,
            cxWidth: i32,
            cyWidth: i32,
            istepIfAniCur: Uint,
            hbrFlickerFreeDraw: Hbrush,
            diFlags: Uint,
        ) -> Bool;
        fn DrawTextW(
            hdc: Hdc,
            lpchText: *const u16,
            cchText: i32,
            lprc: *mut Rect,
            format: Uint,
        ) -> i32;
        fn EndPaint(hWnd: Hwnd, lpPaint: *const PaintStruct) -> Bool;
        fn FillRect(hDC: Hdc, lprc: *const Rect, hbr: Hbrush) -> i32;
        fn DispatchMessageW(lpMsg: *const Msg) -> Lresult;
        fn EnableWindow(hwnd: Hwnd, bEnable: Bool) -> Bool;
        fn GetClientRect(hwnd: Hwnd, lpRect: *mut Rect) -> Bool;
        fn GetMessageW(
            lpMsg: *mut Msg,
            hWnd: Hwnd,
            wMsgFilterMin: Uint,
            wMsgFilterMax: Uint,
        ) -> Bool;
        fn GetWindowTextLengthW(hwnd: Hwnd) -> i32;
        fn GetWindowTextW(hwnd: Hwnd, lpString: *mut u16, nMaxCount: i32) -> i32;
        fn InvalidateRect(hwnd: Hwnd, lpRect: *const Rect, bErase: Bool) -> Bool;
        fn LoadImageW(
            hInst: Hinstance,
            name: *const u16,
            type_: Uint,
            cx: i32,
            cy: i32,
            fuLoad: Uint,
        ) -> isize;
        fn LoadCursorW(hInstance: Hinstance, lpCursorName: *const u16) -> Hcursor;
        fn MessageBoxW(hwnd: Hwnd, lpText: *const u16, lpCaption: *const u16, uType: Uint) -> i32;
        fn MoveWindow(hwnd: Hwnd, x: i32, y: i32, nWidth: i32, nHeight: i32, repaint: Bool)
        -> Bool;
        fn PostMessageW(hwnd: Hwnd, msg: Uint, wparam: Wparam, lparam: Lparam) -> Bool;
        fn PostQuitMessage(nExitCode: i32);
        fn RegisterClassW(lpWndClass: *const WndClassW) -> u16;
        fn SendMessageW(hwnd: Hwnd, msg: Uint, wparam: Wparam, lparam: Lparam) -> Lresult;
        fn SetWindowTextW(hwnd: Hwnd, lpString: *const u16) -> Bool;
        fn ShowWindow(hwnd: Hwnd, nCmdShow: i32) -> Bool;
        fn TranslateMessage(lpMsg: *const Msg) -> Bool;
        fn UpdateWindow(hwnd: Hwnd) -> Bool;
        fn CreatePopupMenu() -> Hmenu;
        fn AppendMenuW(
            hMenu: Hmenu,
            uFlags: Uint,
            uIDNewItem: usize,
            lpNewItem: *const u16,
        ) -> Bool;
        fn TrackPopupMenu(
            hMenu: Hmenu,
            uFlags: Uint,
            x: i32,
            y: i32,
            nReserved: i32,
            hWnd: Hwnd,
            prcRect: *const Rect,
        ) -> Bool;
        fn DestroyMenu(hMenu: Hmenu) -> Bool;
        fn OpenClipboard(hWndNewOwner: Hwnd) -> Bool;
        fn CloseClipboard() -> Bool;
        fn EmptyClipboard() -> Bool;
        fn SetClipboardData(uFormat: Uint, hMem: isize) -> isize;
        fn GetCursorPos(lpPoint: *mut Point) -> Bool;
        fn ScreenToClient(hWnd: Hwnd, lpPoint: *mut Point) -> Bool;
    }

    #[repr(C)]
    #[derive(Copy, Clone, Debug, Eq, PartialEq)]
    struct GUID {
        Data1: u32,
        Data2: u16,
        Data3: u16,
        Data4: [u8; 8],
    }

    #[repr(C)]
    struct ITEMIDLIST {
        _unused: u8,
    }

    #[repr(C)]
    struct CMINVOKECOMMANDINFO {
        cbSize: u32,
        fMask: u32,
        hwnd: Hwnd,
        lpVerb: *const u8,
        lpParameters: *const u8,
        lpDirectory: *const u8,
        nShow: i32,
        dwHotKey: u32,
        hIcon: Hicon,
    }

    #[repr(C)]
    struct IUnknownVtbl {
        QueryInterface: unsafe extern "system" fn(
            this: *mut c_void,
            riid: *const GUID,
            ppvObject: *mut *mut c_void,
        ) -> i32,
        AddRef: unsafe extern "system" fn(this: *mut c_void) -> u32,
        Release: unsafe extern "system" fn(this: *mut c_void) -> u32,
    }

    #[repr(C)]
    struct IShellFolderVtbl {
        QueryInterface: unsafe extern "system" fn(
            this: *mut c_void,
            riid: *const GUID,
            ppvObject: *mut *mut c_void,
        ) -> i32,
        AddRef: unsafe extern "system" fn(this: *mut c_void) -> u32,
        Release: unsafe extern "system" fn(this: *mut c_void) -> u32,
        ParseDisplayName: unsafe extern "system" fn(
            this: *mut c_void,
            hwnd: Hwnd,
            pbc: *mut c_void,
            pszDisplayName: *const u16,
            pchEaten: *mut u32,
            ppidl: *mut *mut ITEMIDLIST,
            pdwAttributes: *mut u32,
        ) -> i32,
        EnumObjects: unsafe extern "system" fn(
            this: *mut c_void,
            hwnd: Hwnd,
            grfFlags: u32,
            ppenumIDList: *mut *mut c_void,
        ) -> i32,
        BindToObject: unsafe extern "system" fn(
            this: *mut c_void,
            pidl: *const ITEMIDLIST,
            pbc: *mut c_void,
            riid: *const GUID,
            ppv: *mut *mut c_void,
        ) -> i32,
        BindToStorage: unsafe extern "system" fn(
            this: *mut c_void,
            pidl: *const ITEMIDLIST,
            pbc: *mut c_void,
            riid: *const GUID,
            ppv: *mut *mut c_void,
        ) -> i32,
        CompareIDs: unsafe extern "system" fn(
            this: *mut c_void,
            lParam: Lparam,
            pidl1: *const ITEMIDLIST,
            pidl2: *const ITEMIDLIST,
        ) -> i32,
        CreateViewObject: unsafe extern "system" fn(
            this: *mut c_void,
            hwndOwner: Hwnd,
            riid: *const GUID,
            ppv: *mut *mut c_void,
        ) -> i32,
        GetAttributesOf: unsafe extern "system" fn(
            this: *mut c_void,
            cidl: u32,
            apidl: *mut *const ITEMIDLIST,
            rgfInOut: *mut u32,
        ) -> i32,
        GetUIObjectOf: unsafe extern "system" fn(
            this: *mut c_void,
            hwndOwner: Hwnd,
            cidl: u32,
            apidl: *mut *const ITEMIDLIST,
            riid: *const GUID,
            rgfReserved: *mut u32,
            ppv: *mut *mut c_void,
        ) -> i32,
        GetDisplayNameOf: unsafe extern "system" fn(
            this: *mut c_void,
            pidl: *const ITEMIDLIST,
            dwFlags: u32,
            pName: *mut c_void,
        ) -> i32,
        SetNameOf: unsafe extern "system" fn(
            this: *mut c_void,
            hwnd: Hwnd,
            pidl: *const ITEMIDLIST,
            pszName: *const u16,
            dwFlags: u32,
            ppidlOut: *mut *mut ITEMIDLIST,
        ) -> i32,
    }

    #[repr(C)]
    struct IContextMenuVtbl {
        QueryInterface: unsafe extern "system" fn(
            this: *mut c_void,
            riid: *const GUID,
            ppvObject: *mut *mut c_void,
        ) -> i32,
        AddRef: unsafe extern "system" fn(this: *mut c_void) -> u32,
        Release: unsafe extern "system" fn(this: *mut c_void) -> u32,
        QueryContextMenu: unsafe extern "system" fn(
            this: *mut c_void,
            hmenu: Hmenu,
            indexMenu: u32,
            idCmdFirst: u32,
            idCmdLast: u32,
            uFlags: u32,
        ) -> i32,
        InvokeCommand:
            unsafe extern "system" fn(this: *mut c_void, lpici: *const CMINVOKECOMMANDINFO) -> i32,
        GetCommandString: unsafe extern "system" fn(
            this: *mut c_void,
            idCmd: usize,
            uType: u32,
            pwReserved: *mut u32,
            pszName: *mut u8,
            cchMax: u32,
        ) -> i32,
    }

    const IID_IShellFolder: GUID = GUID {
        Data1: 0x000214E6,
        Data2: 0x0000,
        Data3: 0x0000,
        Data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
    };

    const IID_IContextMenu: GUID = GUID {
        Data1: 0x000214E4,
        Data2: 0x0000,
        Data3: 0x0000,
        Data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
    };

    const TPM_RETURNCMD: Uint = 0x0100;

    #[link(name = "Shell32")]
    unsafe extern "system" {
        fn SHParseDisplayName(
            pszName: *const u16,
            pbc: *mut c_void,
            ppidl: *mut *mut ITEMIDLIST,
            sfgaoIn: u32,
            psfgaoOut: *mut u32,
        ) -> i32;

        fn SHBindToParent(
            pidl: *const ITEMIDLIST,
            riid: *const GUID,
            ppv: *mut *mut c_void,
            ppidlLast: *mut *const ITEMIDLIST,
        ) -> i32;
    }

    struct DesktopState {
        initial_path: PathBuf,
        hwnd: Hwnd,
        path_edit: Hwnd,
        browse_button: Hwnd,
        scan_button: Hwnd,
        stop_button: Hwnd,
        refresh_button: Hwnd,
        expand_button: Hwnd,
        collapse_button: Hwnd,
        columns_button: Hwnd,
        hidden_check: Hwnd,
        files_check: Hwnd,
        follow_check: Hwnd,
        dark_check: Hwnd,
        status: Hwnd,
        list: Hwnd,
        font: Hfont,
        bold_font: Hfont,
        current_scan: Option<Arc<ScanResult>>,
        current_cancel: Option<Arc<AtomicBool>>,
        expanded: BTreeSet<usize>,
        visible_rows: Vec<usize>,
        icon_cache: HashMap<String, Hicon>,
        show_files: bool,
        scanning: bool,
        dark_mode: bool,
        path_column_visible: bool,
        selected_id: usize,
        scroll_row: usize,
        hovered_id: Option<usize>,
        active_tab: usize,
    }

    struct ScanDone {
        result: Result<ScanResult, String>,
        canceled: bool,
    }

    struct ScanProgressInfo {
        node_count: usize,
        elapsed_ms: u128,
        partial_result: Option<ScanResult>,
    }

    impl DesktopState {
        fn new(initial_path: PathBuf) -> Self {
            Self {
                initial_path,
                hwnd: 0,
                path_edit: 0,
                browse_button: 0,
                scan_button: 0,
                stop_button: 0,
                refresh_button: 0,
                expand_button: 0,
                collapse_button: 0,
                columns_button: 0,
                hidden_check: 0,
                files_check: 0,
                follow_check: 0,
                dark_check: 0,
                status: 0,
                list: 0,
                font: 0,
                bold_font: 0,
                current_scan: None,
                current_cancel: None,
                expanded: BTreeSet::new(),
                visible_rows: Vec::new(),
                icon_cache: HashMap::new(),
                show_files: true,
                scanning: false,
                dark_mode: true,
                path_column_visible: true,
                selected_id: 0,
                scroll_row: 0,
                hovered_id: None,
                active_tab: 1,
            }
        }
    }

    unsafe fn enable_visual_styles() {
        let manifest_content = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
<assemblyIdentity version="1.0.0.0" processorArchitecture="*" name="FileTree" type="win32"/>
<dependency>
    <dependentAssembly>
        <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
</dependency>
</assembly>"#;

        let mut temp_path = std::env::temp_dir();
        temp_path.push("filetree.manifest");
        if std::fs::write(&temp_path, manifest_content).is_ok() {
            let path_wide = wide(&temp_path.to_string_lossy());
            let act_ctx = ACTCTXW {
                cbSize: size_of::<ACTCTXW>() as Dword,
                dwFlags: 0,
                lpSource: path_wide.as_ptr(),
                wProcessorArchitecture: 0,
                wLangId: 0,
                lpAssemblyDirectory: null(),
                lpResourceName: null(),
                lpApplicationName: null(),
                hModule: 0,
            };
            let h_ctx = CreateActCtxW(&act_ctx);
            if h_ctx != -1 {
                let mut cookie: UlongPtr = 0;
                ActivateActCtx(h_ctx, &mut cookie);
            }
        }
    }

    pub fn run(initial_path: PathBuf) -> io::Result<()> {
        unsafe {
            enable_visual_styles();
            let com_initialized = CoInitializeEx(null_mut(), COINIT_APARTMENTTHREADED) >= 0;
            let controls = InitCommonControlsEx {
                dwSize: size_of::<InitCommonControlsEx>() as Dword,
                dwICC: ICC_LISTVIEW_CLASSES,
            };
            InitCommonControlsEx(&controls);

            let _ = STATE.set(Mutex::new(DesktopState::new(initial_path)));

            let h_instance = GetModuleHandleW(null());
            let class_name = wide("FileTreeDesktopWindow");
            let cursor = LoadCursorW(0, IDC_ARROW as *const u16);
            let app_icon = LoadImageW(
                0,
                IDI_APPLICATION as *const u16,
                IMAGE_ICON,
                0,
                0,
                LR_SHARED,
            ) as Hicon;
            let window_class = WndClassW {
                style: CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS,
                lpfnWndProc: Some(window_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: h_instance,
                hIcon: app_icon,
                hCursor: cursor,
                hbrBackground: dark_brush(),
                lpszMenuName: null(),
                lpszClassName: class_name.as_ptr(),
            };
            RegisterClassW(&window_class);

            let title = wide(&format!("{APP_NAME} - Native Disk Explorer"));
            let hwnd = CreateWindowExW(
                0,
                class_name.as_ptr(),
                title.as_ptr(),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                CW_USEDEFAULT,
                CW_USEDEFAULT,
                1280,
                760,
                0,
                0,
                h_instance,
                null_mut(),
            );

            if hwnd == 0 {
                if com_initialized {
                    CoUninitialize();
                }
                return Err(io::Error::last_os_error());
            }

            set_window_dark_mode(hwnd, true);

            ShowWindow(hwnd, SW_SHOW);
            UpdateWindow(hwnd);
            start_scan_from_controls(hwnd);

            let mut message: Msg = zeroed();
            while GetMessageW(&mut message, 0, 0, 0) > 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }

            if com_initialized {
                CoUninitialize();
            }
        }

        Ok(())
    }

    unsafe extern "system" fn window_proc(
        hwnd: Hwnd,
        msg: Uint,
        wparam: Wparam,
        lparam: Lparam,
    ) -> Lresult {
        match msg {
            WM_CREATE => {
                create_controls(hwnd);
                resize_controls(hwnd);
                0
            }
            WM_ERASEBKGND => 1,
            WM_PAINT => {
                paint_window(hwnd);
                0
            }
            WM_SIZE => {
                resize_controls(hwnd);
                InvalidateRect(hwnd, null(), 1);
                0
            }
            WM_LBUTTONDOWN => {
                handle_mouse_click(hwnd, lparam, false);
                0
            }
            WM_LBUTTONDBLCLK => {
                handle_mouse_click(hwnd, lparam, true);
                0
            }
            WM_RBUTTONDOWN => {
                let y = hiword_signed(lparam);
                with_state_mut(|state| {
                    let row_top = table_top() + 30;
                    if y >= row_top {
                        let row_h = 27;
                        let row_index = state.scroll_row + ((y - row_top) / row_h) as usize;
                        if let Some(node_id) = state.visible_rows.get(row_index).copied() {
                            state.selected_id = node_id;
                            InvalidateRect(hwnd, null(), 0);
                        }
                    }
                });
                0
            }
            WM_RBUTTONUP => {
                let x = loword_signed(lparam);
                let y = hiword_signed(lparam);
                handle_right_click(hwnd, x, y);
                0
            }
            WM_MOUSEMOVE => {
                let x = loword_signed(lparam);
                let y = hiword_signed(lparam);
                handle_mouse_move(hwnd, x, y);
                0
            }
            WM_MOUSEWHEEL => {
                handle_mouse_wheel(hwnd, wparam);
                0
            }
            WM_KEYDOWN => {
                handle_key(hwnd, wparam);
                0
            }
            WM_COMMAND => {
                let id = (wparam & 0xffff) as isize;
                match id {
                    ID_BROWSE_BUTTON => choose_and_set_directory(hwnd),
                    ID_SCAN_BUTTON | ID_REFRESH_BUTTON => start_scan_from_controls(hwnd),
                    ID_STOP_BUTTON => stop_current_scan(),
                    ID_EXPAND_BUTTON => expand_all_directories(),
                    ID_COLLAPSE_BUTTON => collapse_to_root(),
                    ID_COLUMNS_BUTTON => toggle_path_column(),
                    ID_FILES_CHECK => {
                        with_state_mut(|state| {
                            state.show_files = button_checked(state.files_check);
                            render_list(state);
                        });
                    }
                    ID_DARK_CHECK => {
                        let status_text = with_state_mut(|state| {
                            state.dark_mode = button_checked(state.dark_check);
                            DARK_MODE_ATOMIC.store(state.dark_mode, Ordering::Relaxed);
                            apply_theme(state);
                            render_list(state)
                        })
                        .flatten();
                        if let Some(text) = status_text {
                            with_state_mut(|state| set_window_text(state.status, &text));
                        }
                    }
                    ID_MENU_OPEN => {
                        let path = with_state_mut(|state| {
                            let scan = state.current_scan.as_ref()?;
                            let node = scan.nodes.get(state.selected_id)?;
                            Some(node.path.clone())
                        })
                        .flatten();
                        if let Some(p) = path {
                            thread::spawn(move || unsafe {
                                ShellExecuteW(
                                    0,
                                    wide("open").as_ptr(),
                                    wide(&p).as_ptr(),
                                    null(),
                                    null(),
                                    5,
                                );
                            });
                        }
                    }
                    ID_MENU_REVEAL => {
                        let path = with_state_mut(|state| {
                            let scan = state.current_scan.as_ref()?;
                            let node = scan.nodes.get(state.selected_id)?;
                            Some(node.path.clone())
                        })
                        .flatten();
                        if let Some(p) = path {
                            thread::spawn(move || {
                                let _ = super::reveal_path(&p);
                            });
                        }
                    }
                    ID_MENU_COPY_PATH => {
                        let path = with_state_mut(|state| {
                            let scan = state.current_scan.as_ref()?;
                            let node = scan.nodes.get(state.selected_id)?;
                            Some(node.path.clone())
                        })
                        .flatten();
                        if let Some(p) = path {
                            unsafe {
                                copy_to_clipboard(&p);
                            }
                        }
                    }
                    ID_MENU_DELETE => {
                        let path = with_state_mut(|state| {
                            let scan = state.current_scan.as_ref()?;
                            let node = scan.nodes.get(state.selected_id)?;
                            Some(node.path.clone())
                        })
                        .flatten();
                        if let Some(p) = path {
                            unsafe {
                                let title = wide("Confirm Delete");
                                let msg = wide(&format!(
                                    "Are you sure you want to permanently delete this item?\n\n{}",
                                    p
                                ));
                                let response = MessageBoxW(
                                    hwnd,
                                    msg.as_ptr(),
                                    title.as_ptr(),
                                    0x00000004 | 0x00000020, // MB_YESNO | MB_ICONQUESTION
                                );
                                if response == 6 {
                                    // IDYES is 6
                                    thread::spawn(move || {
                                        let path_buf = PathBuf::from(p);
                                        let delete_result = if path_buf.is_dir() {
                                            fs::remove_dir_all(&path_buf)
                                        } else {
                                            fs::remove_file(&path_buf)
                                        };
                                        match delete_result {
                                            Ok(_) => {
                                                PostMessageW(
                                                    hwnd,
                                                    WM_COMMAND,
                                                    ID_REFRESH_BUTTON as Wparam,
                                                    0,
                                                );
                                            }
                                            Err(err) => {
                                                let err_msg =
                                                    format!("Failed to delete item:\n{}", err);
                                                show_error_in_thread(hwnd, err_msg);
                                            }
                                        }
                                    });
                                }
                            }
                        }
                    }
                    ID_MENU_PROPERTIES => {
                        let path = with_state_mut(|state| {
                            let scan = state.current_scan.as_ref()?;
                            let node = scan.nodes.get(state.selected_id)?;
                            Some(node.path.clone())
                        })
                        .flatten();
                        if let Some(p) = path {
                            thread::spawn(move || {
                                use std::os::windows::process::CommandExt;
                                const CREATE_NO_WINDOW: u32 = 0x08000000;
                                let script = format!(
                                    "(New-Object -ComObject Shell.Application).NameSpace((Split-Path '{}')).ParseName((Split-Path '{}' -Leaf)).InvokeVerb('Properties')",
                                    p.replace("'", "''"),
                                    p.replace("'", "''")
                                );
                                let _ = Command::new("powershell")
                                    .args([
                                        "-NoProfile",
                                        "-WindowStyle",
                                        "Hidden",
                                        "-Command",
                                        &script,
                                    ])
                                    .creation_flags(CREATE_NO_WINDOW)
                                    .spawn();
                            });
                        }
                    }
                    _ => {}
                }
                0
            }
            WM_NOTIFY => {
                let _ = lparam;
                0
            }
            WM_SCAN_DONE => {
                if lparam != 0 {
                    let payload = Box::from_raw(lparam as *mut ScanDone);
                    finish_scan(hwnd, payload.result, payload.canceled);
                }
                0
            }
            WM_SCAN_PROGRESS => {
                if lparam != 0 {
                    let payload = Box::from_raw(lparam as *mut ScanProgressInfo);
                    apply_scan_progress(
                        payload.node_count,
                        payload.elapsed_ms,
                        payload.partial_result,
                    );
                }
                0
            }
            WM_CTLCOLOREDIT | WM_CTLCOLORSTATIC | WM_CTLCOLORBTN => {
                // Must NOT acquire the STATE mutex here — this message is sent
                // synchronously by child controls during repaint, which can
                // happen while the mutex is already held (reentrant call).
                // Using Mutex::lock() here would deadlock.
                let hdc = wparam as Hdc;
                if DARK_MODE_ATOMIC.load(Ordering::Relaxed) {
                    SetTextColor(hdc, rgb(238, 242, 246));
                    SetBkColor(hdc, rgb(24, 26, 30));
                    dark_brush() as Lresult
                } else {
                    SetTextColor(hdc, rgb(18, 22, 27));
                    SetBkColor(hdc, rgb(242, 244, 247));
                    light_brush() as Lresult
                }
            }
            WM_DESTROY => {
                stop_current_scan();
                destroy_cached_icons();
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    unsafe fn create_controls(hwnd: Hwnd) {
        let h_instance = GetModuleHandleW(null());
        with_state_mut(|state| {
            state.hwnd = hwnd;
            let face = wide("Segoe UI");
            state.font = CreateFontW(-15, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, face.as_ptr());
            state.bold_font = CreateFontW(-15, 0, 0, 0, 700, 0, 0, 0, 1, 0, 0, 5, 0, face.as_ptr());

            state.path_edit = create_child(
                hwnd,
                h_instance,
                "EDIT",
                &path_to_string(&state.initial_path),
                WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL,
                0,
                ID_PATH_EDIT,
            );
            state.browse_button = create_child(
                hwnd,
                h_instance,
                "BUTTON",
                "Select Directory",
                WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
                0,
                ID_BROWSE_BUTTON,
            );
            state.scan_button = create_child(
                hwnd,
                h_instance,
                "BUTTON",
                "Scan",
                WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
                0,
                ID_SCAN_BUTTON,
            );
            state.stop_button = create_child(
                hwnd,
                h_instance,
                "BUTTON",
                "Stop",
                WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
                0,
                ID_STOP_BUTTON,
            );
            state.refresh_button = create_child(
                hwnd,
                h_instance,
                "BUTTON",
                "Refresh",
                WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
                0,
                ID_REFRESH_BUTTON,
            );
            state.expand_button = create_child(
                hwnd,
                h_instance,
                "BUTTON",
                "Expand",
                WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
                0,
                ID_EXPAND_BUTTON,
            );
            state.collapse_button = create_child(
                hwnd,
                h_instance,
                "BUTTON",
                "Collapse",
                WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
                0,
                ID_COLLAPSE_BUTTON,
            );
            state.columns_button = create_child(
                hwnd,
                h_instance,
                "BUTTON",
                "Path Column",
                WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
                0,
                ID_COLUMNS_BUTTON,
            );
            state.hidden_check = create_child(
                hwnd,
                h_instance,
                "BUTTON",
                "Hidden",
                WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTOCHECKBOX,
                0,
                ID_HIDDEN_CHECK,
            );
            state.files_check = create_child(
                hwnd,
                h_instance,
                "BUTTON",
                "Files",
                WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTOCHECKBOX,
                0,
                ID_FILES_CHECK,
            );
            state.follow_check = create_child(
                hwnd,
                h_instance,
                "BUTTON",
                "Links",
                WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTOCHECKBOX,
                0,
                ID_FOLLOW_CHECK,
            );
            state.dark_check = create_child(
                hwnd,
                h_instance,
                "BUTTON",
                "Dark",
                WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTOCHECKBOX,
                0,
                ID_DARK_CHECK,
            );
            state.status = create_child(
                hwnd,
                h_instance,
                "STATIC",
                "Ready",
                WS_CHILD | WS_VISIBLE,
                0,
                ID_STATUS,
            );
            state.list = 0;

            SendMessageW(state.hidden_check, BM_SETCHECK, BST_CHECKED, 0);
            SendMessageW(state.files_check, BM_SETCHECK, BST_CHECKED, 0);
            SendMessageW(state.dark_check, BM_SETCHECK, BST_CHECKED, 0);
            for control in [
                state.path_edit,
                state.browse_button,
                state.scan_button,
                state.stop_button,
                state.refresh_button,
                state.expand_button,
                state.collapse_button,
                state.columns_button,
                state.hidden_check,
                state.files_check,
                state.follow_check,
                state.dark_check,
                state.status,
            ] {
                SendMessageW(control, WM_SETFONT, state.font as Wparam, 1);
            }
            apply_theme(state);
            EnableWindow(state.stop_button, 0);
        });
    }

    unsafe fn create_child(
        parent: Hwnd,
        h_instance: Hinstance,
        class_name: &str,
        text: &str,
        style: Dword,
        ex_style: Dword,
        id: isize,
    ) -> Hwnd {
        let class = wide(class_name);
        let text = wide(text);
        CreateWindowExW(
            ex_style,
            class.as_ptr(),
            text.as_ptr(),
            style,
            0,
            0,
            10,
            10,
            parent,
            id as Hmenu,
            h_instance,
            null_mut(),
        )
    }

    unsafe fn resize_controls(hwnd: Hwnd) {
        let mut rect: Rect = zeroed();
        if GetClientRect(hwnd, &mut rect) == 0 {
            return;
        }

        let width = (rect.right - rect.left).max(500);
        let height = (rect.bottom - rect.top).max(300);
        with_state_mut(|state| {
            let margin = 10;
            let browse_w = 110;
            let button_h = 26;
            let path_y = 38;
            let actions_y = 74;
            let status_h = 26;

            // Path edit takes all width minus browse button
            let path_w = (width - margin * 2 - browse_w - 8).max(260);

            MoveWindow(state.path_edit, margin, path_y, path_w, button_h, 1);
            MoveWindow(
                state.browse_button,
                margin + path_w + 8,
                path_y,
                browse_w,
                button_h,
                1,
            );

            // Dynamically layout row 2 controls based on active tab
            let tab = state.active_tab;
            let mut current_x = margin;
            let spacing = 6;
            let show = 5;
            let hide = 0;

            // 1. Home tab controls (Scan, Stop, Refresh, Expand, Collapse)
            if tab == 1 {
                ShowWindow(state.scan_button, show);
                MoveWindow(state.scan_button, current_x, actions_y, 75, button_h, 1);
                current_x += 75 + spacing;

                ShowWindow(state.stop_button, show);
                MoveWindow(state.stop_button, current_x, actions_y, 75, button_h, 1);
                current_x += 75 + spacing;

                ShowWindow(state.refresh_button, show);
                MoveWindow(state.refresh_button, current_x, actions_y, 80, button_h, 1);
                current_x += 80 + spacing;

                ShowWindow(state.expand_button, show);
                MoveWindow(state.expand_button, current_x, actions_y, 80, button_h, 1);
                current_x += 80 + spacing;

                ShowWindow(state.collapse_button, show);
                MoveWindow(state.collapse_button, current_x, actions_y, 90, button_h, 1);
            } else {
                ShowWindow(state.scan_button, hide);
                ShowWindow(state.stop_button, hide);
                ShowWindow(state.refresh_button, hide);
                ShowWindow(state.expand_button, hide);
                ShowWindow(state.collapse_button, hide);
            }

            // 2. Scan tab controls (Hidden, Files, Links)
            if tab == 2 {
                ShowWindow(state.hidden_check, show);
                MoveWindow(state.hidden_check, current_x, actions_y, 92, button_h, 1);
                current_x += 92 + spacing;

                ShowWindow(state.files_check, show);
                MoveWindow(state.files_check, current_x, actions_y, 78, button_h, 1);
                current_x += 78 + spacing;

                ShowWindow(state.follow_check, show);
                MoveWindow(state.follow_check, current_x, actions_y, 78, button_h, 1);
            } else if tab != 4 && tab != 3 {
                ShowWindow(state.hidden_check, hide);
                ShowWindow(state.files_check, hide);
                ShowWindow(state.follow_check, hide);
            }

            // 3. View tab controls (Columns, Files, Dark)
            if tab == 3 {
                ShowWindow(state.columns_button, show);
                MoveWindow(state.columns_button, current_x, actions_y, 100, button_h, 1);
                current_x += 100 + spacing;

                ShowWindow(state.files_check, show);
                MoveWindow(state.files_check, current_x, actions_y, 78, button_h, 1);
                current_x += 78 + spacing;

                ShowWindow(state.dark_check, show);
                MoveWindow(state.dark_check, current_x, actions_y, 72, button_h, 1);
            } else if tab != 4 {
                ShowWindow(state.columns_button, hide);
                if tab != 2 {
                    ShowWindow(state.files_check, hide);
                }
                ShowWindow(state.dark_check, hide);
            }

            // 4. Options tab controls (Hidden, Files, Links, Dark)
            if tab == 4 {
                ShowWindow(state.hidden_check, show);
                MoveWindow(state.hidden_check, current_x, actions_y, 92, button_h, 1);
                current_x += 92 + spacing;

                ShowWindow(state.files_check, show);
                MoveWindow(state.files_check, current_x, actions_y, 78, button_h, 1);
                current_x += 78 + spacing;

                ShowWindow(state.follow_check, show);
                MoveWindow(state.follow_check, current_x, actions_y, 78, button_h, 1);
                current_x += 78 + spacing;

                ShowWindow(state.dark_check, show);
                MoveWindow(state.dark_check, current_x, actions_y, 72, button_h, 1);
            }

            // 5. Help / File tabs (No specific controls shown)
            if tab == 0 || tab == 5 {
                ShowWindow(state.scan_button, hide);
                ShowWindow(state.stop_button, hide);
                ShowWindow(state.refresh_button, hide);
                ShowWindow(state.expand_button, hide);
                ShowWindow(state.collapse_button, hide);
                ShowWindow(state.columns_button, hide);
                ShowWindow(state.hidden_check, hide);
                ShowWindow(state.files_check, hide);
                ShowWindow(state.follow_check, hide);
                ShowWindow(state.dark_check, hide);
            }

            MoveWindow(
                state.status,
                margin,
                height - status_h,
                width - margin * 2,
                status_h,
                1,
            );
        });
    }

    unsafe fn start_scan_from_controls(hwnd: Hwnd) {
        // Collect everything we need from state, then release the mutex
        // BEFORE calling any Win32 APIs that could send messages back.
        let scan_setup = with_state_mut(|state| {
            if state.scanning {
                return None;
            }
            let path = get_window_text(state.path_edit);
            state.scanning = true;
            state.current_scan = None;
            state.visible_rows.clear();
            state.expanded.clear();
            state.expanded.insert(0);
            for (_key, icon) in state.icon_cache.drain() {
                if icon != 0 {
                    DestroyIcon(icon);
                }
            }
            state.show_files = button_checked(state.files_check);
            let cancel_flag = Arc::new(AtomicBool::new(false));
            state.current_cancel = Some(Arc::clone(&cancel_flag));

            let options = ScanOptions {
                root: PathBuf::from(path),
                include_hidden: button_checked(state.hidden_check),
                follow_links: button_checked(state.follow_check),
                exclude_patterns: Vec::new(),
                max_depth: None,
                threads: default_thread_count(),
            };
            let controls = (
                state.status,
                state.path_edit,
                state.browse_button,
                state.scan_button,
                state.refresh_button,
                state.stop_button,
            );
            Some((options, cancel_flag, controls))
        })
        .flatten();

        let Some((options, cancel, controls)) = scan_setup else {
            return;
        };

        // Win32 calls OUTSIDE the mutex — safe from deadlock.
        set_window_text(controls.0, "Scanning...");
        EnableWindow(controls.1, 0);
        EnableWindow(controls.2, 0);
        EnableWindow(controls.3, 0);
        EnableWindow(controls.4, 0);
        EnableWindow(controls.5, 1);
        InvalidateRect(hwnd, null(), 1);

        thread::spawn(move || {
            let progress_cancel = Arc::clone(&cancel);
            let result = scan_path_with_progress(
                options,
                Arc::clone(&cancel),
                |node_count, elapsed_ms, partial| {
                    if !progress_cancel.load(Ordering::Relaxed) {
                        let payload = Box::new(ScanProgressInfo {
                            node_count,
                            elapsed_ms,
                            partial_result: partial,
                        });
                        unsafe {
                            PostMessageW(
                                hwnd,
                                WM_SCAN_PROGRESS,
                                0,
                                Box::into_raw(payload) as Lparam,
                            );
                        }
                    }
                },
            )
            .map_err(|error| error.to_string());
            let canceled = cancel.load(Ordering::Relaxed);
            let payload = Box::new(ScanDone { result, canceled });
            unsafe {
                PostMessageW(hwnd, WM_SCAN_DONE, 0, Box::into_raw(payload) as Lparam);
            }
        });
    }

    unsafe fn finish_scan(hwnd: Hwnd, result: Result<ScanResult, String>, canceled: bool) {
        // Collect deferred Win32 actions from state, then execute them
        // AFTER releasing the mutex to avoid deadlock.
        let deferred = with_state_mut(|state| {
            state.scanning = false;
            state.current_cancel = None;
            let controls = (
                state.status,
                state.path_edit,
                state.browse_button,
                state.scan_button,
                state.refresh_button,
                state.stop_button,
            );

            match result {
                Ok(scan) => {
                    let elapsed = scan.elapsed_ms;
                    let node_count = scan.nodes.len();
                    let root_size = scan.nodes.first().map(|node| node.size).unwrap_or(0);
                    state.current_scan = Some(Arc::new(scan));
                    state.expanded.clear();
                    state.expanded.insert(0);
                    let list_status = render_list(state);
                    let status_message = if canceled {
                        format!(
                            "Stopped after {node_count} nodes in {} | partial total {}",
                            format_duration_ui(elapsed),
                            format_bytes_ui(root_size)
                        )
                    } else {
                        format!(
                            "Scanned {node_count} nodes in {} | {}",
                            format_duration_ui(elapsed),
                            format_bytes_ui(root_size)
                        )
                    };
                    let _ = list_status; // render_list already invalidated
                    (controls, Some(status_message), None)
                }
                Err(message) => (controls, Some("Scan failed".to_string()), Some(message)),
            }
        });

        if let Some((controls, status_msg, error_msg)) = deferred {
            // Win32 calls OUTSIDE the mutex.
            EnableWindow(controls.1, 1);
            EnableWindow(controls.2, 1);
            EnableWindow(controls.3, 1);
            EnableWindow(controls.4, 1);
            EnableWindow(controls.5, 0);
            if let Some(msg) = status_msg {
                set_window_text(controls.0, &msg);
            }
            if let Some(msg) = error_msg {
                show_error(hwnd, &msg);
            }
        }
    }

    unsafe fn apply_scan_progress(
        node_count: usize,
        elapsed_ms: u128,
        partial_result: Option<ScanResult>,
    ) {
        // Update the scan result inside state and trigger render_list if a partial result is present.
        let status_hwnd = with_state_mut(|state| {
            if !state.scanning {
                return None;
            }
            if let Some(scan) = partial_result {
                state.current_scan = Some(Arc::new(scan));
                let _ = render_list(state);
            }
            Some(state.status)
        })
        .flatten();

        // Win32 call OUTSIDE the mutex — safe from deadlock.
        if let Some(status) = status_hwnd {
            set_window_text(
                status,
                &format!(
                    "Scanning... {} nodes | {} elapsed",
                    format_count_ui(node_count as u64),
                    format_duration_ui(elapsed_ms)
                ),
            );
        }
    }

    unsafe fn stop_current_scan() {
        let status = with_state_mut(|state| {
            if let Some(cancel) = &state.current_cancel {
                cancel.store(true, Ordering::Relaxed);
                Some(state.status)
            } else {
                None
            }
        })
        .flatten();
        if let Some(status) = status {
            set_window_text(status, "Stopping scan...");
        }
    }

    unsafe fn destroy_cached_icons() {
        with_state_mut(|state| {
            for (_key, icon) in state.icon_cache.drain() {
                if icon != 0 {
                    DestroyIcon(icon);
                }
            }
        });
    }

    unsafe fn expand_all_directories() {
        let deferred = with_state_mut(|state| {
            if let Some(scan) = &state.current_scan {
                state.expanded = scan
                    .nodes
                    .iter()
                    .filter(|node| node.is_dir)
                    .map(|node| node.id)
                    .collect();
                render_list(state)
            } else {
                None
            }
        })
        .flatten();
        if let Some(text) = deferred {
            with_state_mut(|state| set_window_text(state.status, &text));
        }
    }

    unsafe fn collapse_to_root() {
        let deferred = with_state_mut(|state| {
            state.expanded.clear();
            state.expanded.insert(0);
            render_list(state)
        })
        .flatten();
        if let Some(text) = deferred {
            with_state_mut(|state| set_window_text(state.status, &text));
        }
    }

    unsafe fn toggle_path_column() {
        let deferred = with_state_mut(|state| {
            state.path_column_visible = !state.path_column_visible;
            update_column_widths(state);
            let msg = if state.path_column_visible {
                "Path column shown"
            } else {
                "Path column hidden"
            };
            (state.status, msg.to_string())
        });
        if let Some((status, msg)) = deferred {
            set_window_text(status, &msg);
        }
    }

    unsafe fn choose_and_set_directory(hwnd: Hwnd) {
        if let Some(path) = browse_for_directory(hwnd) {
            let hwnds = with_state_mut(|state| (state.path_edit, state.status));
            if let Some((path_edit, status)) = hwnds {
                set_window_text(path_edit, &path);
                set_window_text(status, "Directory selected");
            }
        }
    }

    unsafe fn browse_for_directory(hwnd: Hwnd) -> Option<String> {
        let title = wide("Select a directory to scan");
        let mut display_name = [0u16; 260];
        let mut info = BrowseInfoW {
            hwndOwner: hwnd,
            pidlRoot: null_mut(),
            pszDisplayName: display_name.as_mut_ptr(),
            lpszTitle: title.as_ptr(),
            ulFlags: BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE,
            lpfn: None,
            lParam: 0,
            iImage: 0,
        };
        let pidl = SHBrowseForFolderW(&mut info);
        if pidl.is_null() {
            return None;
        }

        let mut path = [0u16; 260];
        let ok = SHGetPathFromIDListW(pidl, path.as_mut_ptr()) != 0;
        CoTaskMemFree(pidl);
        if !ok {
            return None;
        }

        let len = path.iter().position(|ch| *ch == 0).unwrap_or(path.len());
        Some(String::from_utf16_lossy(&path[..len]))
    }

    unsafe fn icon_for_node(state: &mut DesktopState, node: &NodeRecord) -> Hicon {
        let key = if node.is_dir {
            "[dir]".to_string()
        } else if node.extension.is_empty() {
            "[file]".to_string()
        } else {
            format!(".{}", node.extension)
        };

        if let Some(icon) = state.icon_cache.get(&key) {
            return *icon;
        }

        let sample_path = if node.is_dir {
            "folder".to_string()
        } else if node.extension.is_empty() {
            "file".to_string()
        } else {
            format!("file.{0}", node.extension)
        };
        let sample_path = wide(&sample_path);
        let attributes = if node.is_dir {
            FILE_ATTRIBUTE_DIRECTORY
        } else {
            FILE_ATTRIBUTE_NORMAL
        };
        let mut info: ShFileInfoW = zeroed();
        SHGetFileInfoW(
            sample_path.as_ptr(),
            attributes,
            &mut info,
            size_of::<ShFileInfoW>() as Uint,
            SHGFI_ICON | SHGFI_SMALLICON | SHGFI_USEFILEATTRIBUTES,
        );
        state.icon_cache.insert(key, info.hIcon);
        info.hIcon
    }

    unsafe fn apply_theme(state: &mut DesktopState) {
        set_window_dark_mode(state.hwnd, state.dark_mode);
        let theme = if state.dark_mode {
            wide("DarkMode_Explorer")
        } else {
            wide("Explorer")
        };

        // Setting Explorer themes on buttons and checkboxes strips their ComCtl32 v6
        // modern visuals and falls back to flat ugly legacy classic styles.
        // We only set it on edit and status static controls.
        SetWindowTheme(state.path_edit, theme.as_ptr(), null());
        SetWindowTheme(state.status, theme.as_ptr(), null());

        let buttons = [
            state.browse_button,
            state.scan_button,
            state.stop_button,
            state.refresh_button,
            state.expand_button,
            state.collapse_button,
            state.columns_button,
            state.hidden_check,
            state.files_check,
            state.follow_check,
            state.dark_check,
        ];
        for btn in buttons {
            SetWindowTheme(btn, null(), null());
        }

        update_column_widths(state);
        InvalidateRect(state.hwnd, null(), 1);
    }

    unsafe fn update_column_widths(state: &DesktopState) {
        InvalidateRect(state.hwnd, null(), 0);
    }

    unsafe fn set_window_dark_mode(hwnd: Hwnd, enabled: bool) {
        let value: i32 = if enabled { 1 } else { 0 };
        let value_ptr = &value as *const i32 as *const c_void;
        DwmSetWindowAttribute(hwnd, 20, value_ptr, size_of::<i32>() as Dword);
        DwmSetWindowAttribute(hwnd, 19, value_ptr, size_of::<i32>() as Dword);
    }

    unsafe fn dark_brush() -> Hbrush {
        *DARK_BRUSH.get_or_init(|| CreateSolidBrush(rgb(24, 26, 30)))
    }

    unsafe fn light_brush() -> Hbrush {
        *LIGHT_BRUSH.get_or_init(|| CreateSolidBrush(rgb(242, 244, 247)))
    }

    const fn rgb(red: u8, green: u8, blue: u8) -> Dword {
        red as Dword | ((green as Dword) << 8) | ((blue as Dword) << 16)
    }

    unsafe fn paint_window(hwnd: Hwnd) {
        let mut paint: PaintStruct = zeroed();
        let hdc = BeginPaint(hwnd, &mut paint);
        if hdc == 0 {
            return;
        }

        let mut rect: Rect = zeroed();
        GetClientRect(hwnd, &mut rect);
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;

        if width > 0 && height > 0 {
            let mem_dc = CreateCompatibleDC(hdc);
            if mem_dc != 0 {
                let mem_bmp = CreateCompatibleBitmap(hdc, width, height);
                if mem_bmp != 0 {
                    let old_bmp = SelectObject(mem_dc, mem_bmp);

                    with_state_mut(|state| {
                        fill_rect(mem_dc, rect, palette_bg(state));
                        draw_toolbar_background(mem_dc, rect, state);
                        draw_table(mem_dc, rect, state);
                    });

                    BitBlt(hdc, 0, 0, width, height, mem_dc, 0, 0, SRCCOPY);

                    SelectObject(mem_dc, old_bmp);
                    DeleteObject(mem_bmp);
                }
                DeleteDC(mem_dc);
            }
        }

        EndPaint(hwnd, &paint);
    }

    unsafe fn draw_toolbar_background(hdc: Hdc, client: Rect, state: &DesktopState) {
        // 1. Draw top tab bar background
        let tab_bar_bg = if state.dark_mode {
            rgb(16, 17, 20)
        } else {
            rgb(215, 219, 226)
        };
        let tab_bar_rect = Rect {
            left: 0,
            top: 0,
            right: client.right,
            bottom: 30,
        };
        fill_rect(hdc, tab_bar_rect, tab_bar_bg);

        // 2. Draw active tab ("Home") and other tabs
        let tabs = [
            ("File", 10, 60),
            ("Home", 60, 120),
            ("Scan", 120, 180),
            ("View", 180, 240),
            ("Options", 240, 310),
            ("Help", 310, 370),
        ];

        let old_font = SelectObject(hdc, state.bold_font as Hgdobj);
        SetBkMode(hdc, TRANSPARENT);

        for (i, &(name, left, right)) in tabs.iter().enumerate() {
            let is_active = state.active_tab == i;
            let tab_rect = Rect {
                left,
                top: 0,
                right,
                bottom: 30,
            };

            if is_active {
                // Active tab background (palette_panel)
                fill_rect(hdc, tab_rect, palette_panel(state));

                // Beautiful blue bottom accent line for active tab
                let accent_color = if state.dark_mode {
                    rgb(92, 93, 242)
                } else {
                    rgb(65, 122, 232)
                };
                let accent_rect = Rect {
                    left,
                    top: 27,
                    right,
                    bottom: 30,
                };
                fill_rect(hdc, accent_rect, accent_color);

                let text_color = if state.dark_mode {
                    rgb(255, 255, 255)
                } else {
                    rgb(10, 11, 13)
                };
                SetTextColor(hdc, text_color);
            } else {
                let text_color = if state.dark_mode {
                    rgb(150, 155, 160)
                } else {
                    rgb(80, 85, 90)
                };
                SetTextColor(hdc, text_color);
            }

            let mut text_rect = tab_rect;
            draw_text(
                hdc,
                name,
                &mut text_rect,
                DT_CENTER | DT_VCENTER | DT_SINGLELINE,
            );
        }

        SelectObject(hdc, old_font);

        // 3. Draw main ribbon panel body below the tabs
        let ribbon_body_rect = Rect {
            left: 0,
            top: 30,
            right: client.right,
            bottom: table_top() - 4,
        };
        fill_rect(hdc, ribbon_body_rect, palette_panel(state));

        // 4. Draw separator line below ribbon
        let separator_rect = Rect {
            left: 0,
            top: table_top() - 4,
            right: client.right,
            bottom: table_top() - 3,
        };
        fill_rect(hdc, separator_rect, palette_line(state));
    }

    unsafe fn draw_table(hdc: Hdc, client: Rect, state: &mut DesktopState) {
        let table_left = 10;
        let table_right = client.right - 10;
        let header_top = table_top();
        let header_h = 30;
        let row_h = 27;
        let row_top = header_top + header_h;
        let bottom = client.bottom - 30;

        let table_bg = Rect {
            left: table_left,
            top: header_top,
            right: table_right,
            bottom,
        };
        fill_rect(hdc, table_bg, palette_table(state));

        SelectObject(hdc, state.bold_font as Hgdobj);
        SetBkMode(hdc, TRANSPARENT);
        draw_header(hdc, table_left, table_right, header_top, header_h, state);

        SelectObject(hdc, state.font as Hgdobj);
        if state.visible_rows.is_empty() {
            let message = if state.scanning {
                "Scanning... discovered rows will appear here"
            } else {
                "Select a directory, then scan"
            };
            let mut empty_rect = Rect {
                left: table_left + 12,
                top: row_top + 14,
                right: table_right - 12,
                bottom: row_top + 46,
            };
            SetTextColor(hdc, palette_muted(state));
            draw_text(
                hdc,
                message,
                &mut empty_rect,
                DT_LEFT | DT_SINGLELINE | DT_VCENTER,
            );
            return;
        }

        let visible_capacity = ((bottom - row_top).max(row_h) / row_h) as usize;
        if state.scroll_row + visible_capacity > state.visible_rows.len() {
            state.scroll_row = state.visible_rows.len().saturating_sub(visible_capacity);
        }

        let Some(scan) = state.current_scan.clone() else {
            return;
        };

        for screen_index in 0..visible_capacity {
            let row_index = state.scroll_row + screen_index;
            let Some(node_id) = state.visible_rows.get(row_index).copied() else {
                break;
            };
            let node = &scan.nodes[node_id];
            let top = row_top + (screen_index as i32 * row_h);
            draw_row(
                hdc,
                table_left,
                table_right,
                top,
                row_h,
                state,
                &scan,
                node,
                row_index,
            );
        }
    }

    unsafe fn draw_header(
        hdc: Hdc,
        left: i32,
        right: i32,
        top: i32,
        height: i32,
        state: &DesktopState,
    ) {
        fill_rect(
            hdc,
            Rect {
                left,
                top,
                right,
                bottom: top + height,
            },
            palette_header(state),
        );
        let mut x = left;
        for (label, width, align) in columns(state) {
            let col_right = (x + width).min(right);
            let mut text_rect = Rect {
                left: x + 8,
                top,
                right: col_right - 8,
                bottom: top + height,
            };
            SetTextColor(hdc, palette_text(state));
            draw_text(
                hdc,
                label,
                &mut text_rect,
                if align {
                    DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS
                } else {
                    DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS
                },
            );
            fill_rect(
                hdc,
                Rect {
                    left: col_right,
                    top,
                    right: col_right + 1,
                    bottom: top + height,
                },
                palette_line(state),
            );
            x = col_right;
            if x >= right {
                break;
            }
        }
        fill_rect(
            hdc,
            Rect {
                left,
                top: top + height - 1,
                right,
                bottom: top + height,
            },
            palette_line(state),
        );
    }

    unsafe fn draw_row(
        hdc: Hdc,
        left: i32,
        right: i32,
        top: i32,
        height: i32,
        state: &mut DesktopState,
        scan: &ScanResult,
        node: &NodeRecord,
        row_index: usize,
    ) {
        let selected = state.selected_id == node.id;
        let hovered = state.hovered_id == Some(node.id);
        let bg = if selected {
            palette_selected(state)
        } else if hovered {
            palette_hovered(state)
        } else if row_index % 2 == 0 {
            palette_table(state)
        } else {
            palette_table_alt(state)
        };
        fill_rect(
            hdc,
            Rect {
                left,
                top,
                right,
                bottom: top + height,
            },
            bg,
        );

        let parent_size = node
            .parent
            .and_then(|parent| scan.nodes.get(parent))
            .map(|parent| parent.size)
            .unwrap_or(node.size);
        let percent = if parent_size > 0 {
            (node.size as f64 / parent_size as f64) * 100.0
        } else {
            0.0
        };

        let mut x = left;
        let cols = columns(state);
        for (column_index, (_label, width, align)) in cols.iter().enumerate() {
            let col_right = (x + *width).min(right);
            if column_index == 0 {
                draw_name_cell(hdc, x, col_right, top, height, state, node, percent);
            } else if column_index == 5 {
                draw_percent_cell(hdc, x, col_right, top, height, state, percent);
            } else {
                let text = match column_index {
                    1 => format_bytes_ui(node.size),
                    2 => format_bytes_ui(node.allocated),
                    3 => format_count_ui(node.files),
                    4 => format_count_ui(node.folders),
                    6 => epoch_ms_to_utc(node.modified_ms),
                    7 => node.path.clone(),
                    _ => String::new(),
                };
                let mut text_rect = Rect {
                    left: x + 8,
                    top,
                    right: col_right - 8,
                    bottom: top + height,
                };
                SetTextColor(hdc, palette_text(state));
                draw_text(
                    hdc,
                    &text,
                    &mut text_rect,
                    if *align {
                        DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX
                    } else {
                        DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX
                    },
                );
            }
            fill_rect(
                hdc,
                Rect {
                    left: col_right,
                    top,
                    right: col_right + 1,
                    bottom: top + height,
                },
                palette_grid(state),
            );
            x = col_right;
            if x >= right {
                break;
            }
        }

        fill_rect(
            hdc,
            Rect {
                left,
                top: top + height - 1,
                right,
                bottom: top + height,
            },
            palette_grid(state),
        );
    }

    unsafe fn draw_name_cell(
        hdc: Hdc,
        left: i32,
        right: i32,
        top: i32,
        height: i32,
        state: &mut DesktopState,
        node: &NodeRecord,
        percent: f64,
    ) {
        let bar_w = (((right - left) as f64) * (percent / 100.0).clamp(0.0, 1.0)) as i32;
        if bar_w > 2 {
            fill_rect(
                hdc,
                Rect {
                    left,
                    top: top + 3,
                    right: left + bar_w,
                    bottom: top + height - 3,
                },
                palette_size_bar(state),
            );
        }

        let indent = 8 + (node.depth as i32 * 18);
        let twist = if node.is_dir {
            if state.expanded.contains(&node.id) {
                "v"
            } else {
                ">"
            }
        } else {
            ""
        };
        let mut twist_rect = Rect {
            left: left + indent,
            top,
            right: left + indent + 16,
            bottom: top + height,
        };
        SetTextColor(hdc, palette_muted(state));
        draw_text(
            hdc,
            twist,
            &mut twist_rect,
            DT_LEFT | DT_SINGLELINE | DT_VCENTER,
        );

        let icon = icon_for_node(state, node);
        if icon != 0 {
            DrawIconEx(
                hdc,
                left + indent + 19,
                top + ((height - 16) / 2),
                icon,
                16,
                16,
                0,
                0,
                DI_NORMAL,
            );
        }

        // Prefix formatted size directly onto the node's name for classic TreeSize style
        let display_name = format!("{} {}", format_bytes_ui(node.size), node.name);

        let mut text_rect = Rect {
            left: left + indent + 40,
            top,
            right: right - 8,
            bottom: top + height,
        };
        SetTextColor(hdc, palette_text(state));
        draw_text(
            hdc,
            &display_name,
            &mut text_rect,
            DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX,
        );
    }

    unsafe fn draw_percent_cell(
        hdc: Hdc,
        left: i32,
        right: i32,
        top: i32,
        height: i32,
        state: &DesktopState,
        percent: f64,
    ) {
        let inner = Rect {
            left: left + 5,
            top: top + 5,
            right: right - 5,
            bottom: top + height - 5,
        };

        // 1. Draw outer 1px border around the progress track
        let border_color = palette_line(state);
        fill_rect(
            hdc,
            Rect {
                left: inner.left,
                top: inner.top,
                right: inner.left + 1,
                bottom: inner.bottom,
            },
            border_color,
        );
        fill_rect(
            hdc,
            Rect {
                left: inner.right - 1,
                top: inner.top,
                right: inner.right,
                bottom: inner.bottom,
            },
            border_color,
        );
        fill_rect(
            hdc,
            Rect {
                left: inner.left,
                top: inner.top,
                right: inner.right,
                bottom: inner.top + 1,
            },
            border_color,
        );
        fill_rect(
            hdc,
            Rect {
                left: inner.left,
                top: inner.bottom - 1,
                right: inner.right,
                bottom: inner.bottom,
            },
            border_color,
        );

        // 2. Fill background of the track
        let track_bg = Rect {
            left: inner.left + 1,
            top: inner.top + 1,
            right: inner.right - 1,
            bottom: inner.bottom - 1,
        };
        fill_rect(hdc, track_bg, palette_percent_track(state));

        // 3. Fill the progress bar indicator with top highlight
        let max_fill_w = track_bg.right - track_bg.left;
        let fill_w = (((max_fill_w) as f64) * (percent / 100.0).clamp(0.0, 1.0)) as i32;
        if fill_w > 0 {
            let fill_rect_area = Rect {
                left: track_bg.left,
                top: track_bg.top,
                right: track_bg.left + fill_w,
                bottom: track_bg.bottom,
            };
            fill_rect(hdc, fill_rect_area, palette_percent_fill(state));

            // Accent highlighting stripe for high-fidelity visual appeal
            let highlight_rect = Rect {
                left: track_bg.left,
                top: track_bg.top,
                right: track_bg.left + fill_w,
                bottom: track_bg.top + 2,
            };
            let highlight_color = if state.dark_mode {
                rgb(140, 142, 255)
            } else {
                rgb(130, 180, 255)
            };
            fill_rect(hdc, highlight_rect, highlight_color);
        }

        // 4. Draw percent text aligned to the right (slightly padded)
        let mut text_rect = Rect {
            left,
            top,
            right: right - 12,
            bottom: top + height,
        };
        SetBkMode(hdc, TRANSPARENT);
        SetTextColor(hdc, palette_text(state));
        draw_text(
            hdc,
            &format!("{percent:.1}%"),
            &mut text_rect,
            DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
        );
    }

    unsafe fn handle_mouse_click(hwnd: Hwnd, lparam: Lparam, double_click: bool) {
        let x = loword_signed(lparam);
        let y = hiword_signed(lparam);

        let mut tab_clicked = None;
        if y >= 0 && y < 30 {
            if x >= 10 && x < 60 {
                tab_clicked = Some(0);
            } else if x >= 60 && x < 120 {
                tab_clicked = Some(1);
            } else if x >= 120 && x < 180 {
                tab_clicked = Some(2);
            } else if x >= 180 && x < 240 {
                tab_clicked = Some(3);
            } else if x >= 240 && x < 310 {
                tab_clicked = Some(4);
            } else if x >= 310 && x < 370 {
                tab_clicked = Some(5);
            }
        }

        if let Some(tab_idx) = tab_clicked {
            with_state_mut(|state| {
                state.active_tab = tab_idx;
            });
            resize_controls(hwnd);
            InvalidateRect(hwnd, null(), 0);
            return;
        }

        with_state_mut(|state| {
            let row_top = table_top() + 30;
            if y < row_top {
                return;
            }
            let row_h = 27;
            let row_index = state.scroll_row + ((y - row_top) / row_h) as usize;
            let Some(node_id) = state.visible_rows.get(row_index).copied() else {
                return;
            };
            state.selected_id = node_id;

            let Some(scan) = state.current_scan.clone() else {
                InvalidateRect(hwnd, null(), 0);
                return;
            };
            let Some(node) = scan.nodes.get(node_id) else {
                InvalidateRect(hwnd, null(), 0);
                return;
            };
            let twist_x = 10 + 8 + (node.depth as i32 * 18);
            let in_twist = x >= twist_x && x <= twist_x + 20;
            if node.is_dir && (double_click || in_twist) {
                if state.expanded.contains(&node_id) {
                    state.expanded.remove(&node_id);
                } else {
                    state.expanded.insert(node_id);
                }
                render_list(state);
            } else {
                if !node.is_dir && double_click {
                    let path_clone = node.path.clone();
                    thread::spawn(move || unsafe {
                        ShellExecuteW(
                            0,
                            wide("open").as_ptr(),
                            wide(&path_clone).as_ptr(),
                            null(),
                            null(),
                            5,
                        );
                    });
                }
                InvalidateRect(hwnd, null(), 0);
            }
        });
    }

    unsafe fn show_shell_context_menu(hwnd: Hwnd, path: &str, x: i32, y: i32) -> bool {
        let wide_path = wide(path);
        let mut pidl: *mut ITEMIDLIST = null_mut();

        let hr_parse = SHParseDisplayName(wide_path.as_ptr(), null_mut(), &mut pidl, 0, null_mut());
        if hr_parse < 0 || pidl.is_null() {
            return false;
        }

        let mut parent_folder_ptr: *mut *mut IShellFolderVtbl = null_mut();
        let mut relative_pidl: *const ITEMIDLIST = null();

        let hr_bind = SHBindToParent(
            pidl,
            &IID_IShellFolder,
            &mut parent_folder_ptr as *mut *mut *mut IShellFolderVtbl as *mut *mut c_void,
            &mut relative_pidl,
        );
        if hr_bind < 0 || parent_folder_ptr.is_null() || relative_pidl.is_null() {
            CoTaskMemFree(pidl as *mut c_void);
            return false;
        }

        let mut context_menu_ptr: *mut *mut IContextMenuVtbl = null_mut();
        let hr_gui = ((**parent_folder_ptr).GetUIObjectOf)(
            parent_folder_ptr as *mut c_void,
            hwnd,
            1,
            &mut relative_pidl,
            &IID_IContextMenu,
            null_mut(),
            &mut context_menu_ptr as *mut *mut *mut IContextMenuVtbl as *mut *mut c_void,
        );
        if hr_gui < 0 || context_menu_ptr.is_null() {
            ((**parent_folder_ptr).Release)(parent_folder_ptr as *mut c_void);
            CoTaskMemFree(pidl as *mut c_void);
            return false;
        }

        let hmenu = CreatePopupMenu();
        if hmenu == 0 {
            ((**context_menu_ptr).Release)(context_menu_ptr as *mut c_void);
            ((**parent_folder_ptr).Release)(parent_folder_ptr as *mut c_void);
            CoTaskMemFree(pidl as *mut c_void);
            return false;
        }

        let min_id = 1;
        let max_id = 30000;
        let hr_query = ((**context_menu_ptr).QueryContextMenu)(
            context_menu_ptr as *mut c_void,
            hmenu,
            0,
            min_id,
            max_id,
            0, // CMF_NORMAL
        );

        let mut success = false;
        if hr_query >= 0 {
            success = true;
            let selected_id = TrackPopupMenu(
                hmenu,
                TPM_RETURNCMD | TPM_LEFTALIGN | TPM_RIGHTBUTTON,
                x,
                y,
                0,
                hwnd,
                null_mut(),
            );

            if selected_id >= min_id as i32 && selected_id <= max_id as i32 {
                let verb = (selected_id - min_id as i32) as usize;
                let info = CMINVOKECOMMANDINFO {
                    cbSize: size_of::<CMINVOKECOMMANDINFO>() as u32,
                    fMask: 0,
                    hwnd,
                    lpVerb: verb as *const u8,
                    lpParameters: null(),
                    lpDirectory: null(),
                    nShow: SW_SHOW,
                    dwHotKey: 0,
                    hIcon: 0,
                };
                ((**context_menu_ptr).InvokeCommand)(context_menu_ptr as *mut c_void, &info);
            }
        }

        DestroyMenu(hmenu);
        ((**context_menu_ptr).Release)(context_menu_ptr as *mut c_void);
        ((**parent_folder_ptr).Release)(parent_folder_ptr as *mut c_void);
        CoTaskMemFree(pidl as *mut c_void);
        success
    }

    unsafe fn handle_right_click(hwnd: Hwnd, _client_x: i32, client_y: i32) {
        let clicked_node_id = with_state_mut(|state| {
            let row_top = table_top() + 30;
            if client_y < row_top {
                return None;
            }
            let row_h = 27;
            let row_index = state.scroll_row + ((client_y - row_top) / row_h) as usize;
            let node_id = state.visible_rows.get(row_index).copied()?;
            state.selected_id = node_id;
            InvalidateRect(hwnd, null(), 0);
            Some(node_id)
        })
        .flatten();

        let Some(_node_id) = clicked_node_id else {
            return;
        };

        // For TrackPopupMenu, we need screen coordinates of the cursor
        let mut screen_pt = Point { x: 0, y: 0 };
        if GetCursorPos(&mut screen_pt) == 0 {
            return;
        }

        let path = with_state_mut(|state| {
            let scan = state.current_scan.as_ref()?;
            let node = scan.nodes.get(state.selected_id)?;
            Some(node.path.clone())
        })
        .flatten();

        if let Some(p) = path
            && show_shell_context_menu(hwnd, &p, screen_pt.x, screen_pt.y)
        {
            return;
        }

        let menu = CreatePopupMenu();
        if menu == 0 {
            return;
        }

        let label_open = wide("Open / Play");
        let label_reveal = wide("Reveal in Explorer");
        let label_copy = wide("Copy Path");
        let label_delete = wide("Delete");
        let label_properties = wide("Properties");

        AppendMenuW(menu, MF_STRING, ID_MENU_OPEN as usize, label_open.as_ptr());
        AppendMenuW(
            menu,
            MF_STRING,
            ID_MENU_REVEAL as usize,
            label_reveal.as_ptr(),
        );
        AppendMenuW(
            menu,
            MF_STRING,
            ID_MENU_COPY_PATH as usize,
            label_copy.as_ptr(),
        );
        AppendMenuW(menu, MF_SEPARATOR, 0, null());
        AppendMenuW(
            menu,
            MF_STRING,
            ID_MENU_DELETE as usize,
            label_delete.as_ptr(),
        );
        AppendMenuW(menu, MF_SEPARATOR, 0, null());
        AppendMenuW(
            menu,
            MF_STRING,
            ID_MENU_PROPERTIES as usize,
            label_properties.as_ptr(),
        );

        TrackPopupMenu(
            menu,
            TPM_LEFTALIGN | TPM_RIGHTBUTTON,
            screen_pt.x,
            screen_pt.y,
            0,
            hwnd,
            null(),
        );

        DestroyMenu(menu);
    }

    unsafe fn copy_to_clipboard(text: &str) -> bool {
        let wide_str = wide(text);
        let len_bytes = wide_str.len() * 2;
        let h_mem = GlobalAlloc(GMEM_MOVEABLE, len_bytes);
        if h_mem == 0 {
            return false;
        }
        let ptr = GlobalLock(h_mem);
        if ptr.is_null() {
            GlobalFree(h_mem);
            return false;
        }
        std::ptr::copy_nonoverlapping(wide_str.as_ptr() as *const c_void, ptr, len_bytes);
        GlobalUnlock(h_mem);

        if OpenClipboard(0) == 0 {
            GlobalFree(h_mem);
            return false;
        }
        EmptyClipboard();
        let success = SetClipboardData(CF_UNICODETEXT, h_mem) != 0;
        CloseClipboard();
        if !success {
            GlobalFree(h_mem);
        }
        success
    }

    fn show_error_in_thread(hwnd: Hwnd, message: String) {
        thread::spawn(move || unsafe {
            let title = wide(APP_NAME);
            let msg = wide(&message);
            MessageBoxW(hwnd, msg.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR);
        });
    }

    unsafe fn handle_mouse_wheel(hwnd: Hwnd, wparam: Wparam) {
        let delta = ((wparam >> 16) as i16) as i32;
        with_state_mut(|state| {
            if state.visible_rows.is_empty() {
                return;
            }
            let step = if delta > 0 { -3 } else { 3 };
            scroll_rows(state, step);
            InvalidateRect(hwnd, null(), 0);
        });
    }

    unsafe fn handle_mouse_move(hwnd: Hwnd, _client_x: i32, client_y: i32) {
        let hovered = with_state_mut(|state| {
            let row_top = table_top() + 30;
            if client_y < row_top {
                let old = state.hovered_id;
                state.hovered_id = None;
                return (old, None);
            }
            let row_h = 27;
            let row_index = state.scroll_row + ((client_y - row_top) / row_h) as usize;
            let node_id = state.visible_rows.get(row_index).copied();
            let old = state.hovered_id;
            state.hovered_id = node_id;
            (old, node_id)
        });

        if let Some((old_hover, new_hover)) = hovered
            && old_hover != new_hover
        {
            InvalidateRect(hwnd, null(), 0);
        }
    }

    unsafe fn handle_key(hwnd: Hwnd, key: Wparam) {
        with_state_mut(|state| {
            match key {
                VK_UP => move_selection(state, -1),
                VK_DOWN => move_selection(state, 1),
                VK_PRIOR => scroll_rows(state, -20),
                VK_NEXT => scroll_rows(state, 20),
                VK_HOME => state.scroll_row = 0,
                VK_END => state.scroll_row = state.visible_rows.len().saturating_sub(1),
                _ => {}
            }
            InvalidateRect(hwnd, null(), 0);
        });
    }

    fn move_selection(state: &mut DesktopState, delta: isize) {
        if state.visible_rows.is_empty() {
            return;
        }
        let current = state
            .visible_rows
            .iter()
            .position(|id| *id == state.selected_id)
            .unwrap_or(0);
        let next = current
            .saturating_add_signed(delta)
            .min(state.visible_rows.len().saturating_sub(1));
        state.selected_id = state.visible_rows[next];
        if next < state.scroll_row {
            state.scroll_row = next;
        }
    }

    fn scroll_rows(state: &mut DesktopState, delta: isize) {
        let max = state.visible_rows.len().saturating_sub(1);
        state.scroll_row = state.scroll_row.saturating_add_signed(delta).min(max);
    }

    unsafe fn fill_rect(hdc: Hdc, rect: Rect, color: Dword) {
        let brush = CreateSolidBrush(color);
        FillRect(hdc, &rect, brush);
        DeleteObject(brush as Hgdobj);
    }

    unsafe fn draw_text(hdc: Hdc, text: &str, rect: &mut Rect, flags: Uint) {
        let wide = wide(text);
        DrawTextW(hdc, wide.as_ptr(), -1, rect, flags);
    }

    fn table_top() -> i32 {
        115
    }

    fn columns(state: &DesktopState) -> Vec<(&'static str, i32, bool)> {
        let mut columns = vec![
            ("Name", 520, false),
            ("Size", 110, true),
            ("Allocated", 118, true),
            ("Files", 88, true),
            ("Folders", 88, true),
            ("% Parent", 110, true),
            ("Last Modified", 168, false),
        ];
        if state.path_column_visible {
            columns.push(("Path", 520, false));
        }
        columns
    }

    fn loword_signed(value: Lparam) -> i32 {
        (value as u32 & 0xffff) as i16 as i32
    }

    fn hiword_signed(value: Lparam) -> i32 {
        ((value as u32 >> 16) & 0xffff) as i16 as i32
    }

    fn palette_bg(state: &DesktopState) -> Dword {
        if state.dark_mode {
            rgb(12, 13, 15)
        } else {
            rgb(242, 244, 247)
        }
    }

    fn palette_panel(state: &DesktopState) -> Dword {
        if state.dark_mode {
            rgb(28, 30, 34)
        } else {
            rgb(236, 238, 241)
        }
    }

    fn palette_table(state: &DesktopState) -> Dword {
        if state.dark_mode {
            rgb(24, 26, 29)
        } else {
            rgb(255, 255, 255)
        }
    }

    fn palette_table_alt(state: &DesktopState) -> Dword {
        if state.dark_mode {
            rgb(21, 23, 26)
        } else {
            rgb(249, 250, 252)
        }
    }

    fn palette_header(state: &DesktopState) -> Dword {
        if state.dark_mode {
            rgb(50, 53, 58)
        } else {
            rgb(226, 229, 234)
        }
    }

    fn palette_line(state: &DesktopState) -> Dword {
        if state.dark_mode {
            rgb(64, 68, 74)
        } else {
            rgb(196, 202, 210)
        }
    }

    fn palette_grid(state: &DesktopState) -> Dword {
        if state.dark_mode {
            rgb(36, 39, 43)
        } else {
            rgb(231, 234, 238)
        }
    }

    fn palette_text(state: &DesktopState) -> Dword {
        if state.dark_mode {
            rgb(240, 244, 248)
        } else {
            rgb(18, 22, 27)
        }
    }

    fn palette_muted(state: &DesktopState) -> Dword {
        if state.dark_mode {
            rgb(156, 165, 174)
        } else {
            rgb(91, 100, 112)
        }
    }

    fn palette_selected(state: &DesktopState) -> Dword {
        if state.dark_mode {
            rgb(70, 74, 79)
        } else {
            rgb(211, 226, 246)
        }
    }

    fn palette_hovered(state: &DesktopState) -> Dword {
        if state.dark_mode {
            rgb(38, 41, 46)
        } else {
            rgb(228, 236, 247)
        }
    }

    fn palette_size_bar(state: &DesktopState) -> Dword {
        if state.dark_mode {
            rgb(72, 78, 84)
        } else {
            rgb(217, 225, 235)
        }
    }

    fn palette_percent_track(state: &DesktopState) -> Dword {
        if state.dark_mode {
            rgb(54, 56, 59)
        } else {
            rgb(232, 235, 240)
        }
    }

    fn palette_percent_fill(state: &DesktopState) -> Dword {
        if state.dark_mode {
            rgb(92, 93, 242)
        } else {
            rgb(65, 122, 232)
        }
    }

    /// Rebuilds the visible_rows list and invalidates the window.
    /// Returns a status message string that should be set on the status
    /// bar AFTER the mutex is released (to avoid deadlock from
    /// SetWindowTextW sending synchronous messages back to our proc).
    unsafe fn render_list(state: &mut DesktopState) -> Option<String> {
        state.visible_rows.clear();

        let Some(scan) = state.current_scan.clone() else {
            state.scroll_row = 0;
            InvalidateRect(state.hwnd, null(), 1);
            return None;
        };

        collect_rows(
            &scan,
            0,
            &state.expanded,
            state.show_files,
            &mut state.visible_rows,
        );
        if state.scroll_row >= state.visible_rows.len() {
            state.scroll_row = state.visible_rows.len().saturating_sub(1);
        }

        InvalidateRect(state.hwnd, null(), 0);

        scan.nodes.first().map(|root| {
            format!(
                "{} | {} | {} files | {} folders | {} visible rows",
                root.path,
                format_bytes_ui(root.size),
                format_count_ui(root.files),
                format_count_ui(root.folders),
                format_count_ui(state.visible_rows.len() as u64)
            )
        })
    }

    fn collect_rows(
        scan: &ScanResult,
        id: usize,
        expanded: &BTreeSet<usize>,
        show_files: bool,
        rows: &mut Vec<usize>,
    ) {
        let Some(node) = scan.nodes.get(id) else {
            return;
        };

        if rows.len() >= MAX_VISIBLE_ROWS {
            return;
        }

        if node.is_dir || show_files {
            rows.push(id);
        }

        if node.is_dir && expanded.contains(&id) {
            for child in &node.children {
                if rows.len() >= MAX_VISIBLE_ROWS {
                    break;
                }
                collect_rows(scan, *child, expanded, show_files, rows);
            }
        }
    }

    unsafe fn button_checked(hwnd: Hwnd) -> bool {
        SendMessageW(hwnd, BM_GETCHECK, 0, 0) as Wparam == BST_CHECKED
    }

    unsafe fn get_window_text(hwnd: Hwnd) -> String {
        let len = GetWindowTextLengthW(hwnd).max(0);
        let mut buffer = vec![0u16; len as usize + 1];
        let read = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
        String::from_utf16_lossy(&buffer[..read.max(0) as usize])
    }

    unsafe fn set_window_text(hwnd: Hwnd, text: &str) {
        let text = wide(text);
        SetWindowTextW(hwnd, text.as_ptr());
    }

    unsafe fn show_error(hwnd: Hwnd, message: &str) {
        let title = wide(APP_NAME);
        let message = wide(message);
        MessageBoxW(hwnd, message.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR);
    }

    fn with_state_mut<T>(callback: impl FnOnce(&mut DesktopState) -> T) -> Option<T> {
        let state = STATE.get()?;
        // Use try_lock instead of lock to prevent deadlocks from reentrant
        // calls. Win32 APIs (e.g. SetWindowTextW, EnableWindow) can send
        // synchronous messages back to our window proc while we hold this
        // lock. Rust's std::Mutex is NOT reentrant — lock() on the same
        // thread would deadlock permanently. try_lock() returns Err
        // (WouldBlock) for reentrant calls, allowing the reentrant handler
        // to gracefully skip non-critical work.
        let mut state = state.try_lock().ok()?;
        Some(callback(&mut state))
    }

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain(Some(0)).collect()
    }

    fn format_bytes_ui(value: u64) -> String {
        const UNITS: &[(&str, f64)] = &[
            ("TB", 1024.0 * 1024.0 * 1024.0 * 1024.0),
            ("GB", 1024.0 * 1024.0 * 1024.0),
            ("MB", 1024.0 * 1024.0),
            ("KB", 1024.0),
        ];

        for (unit, factor) in UNITS {
            if value as f64 >= *factor {
                let amount = value as f64 / *factor;
                return format!("{amount:.1} {unit}");
            }
        }
        format!("{} B", format_count_ui(value))
    }

    fn format_count_ui(value: u64) -> String {
        let text = value.to_string();
        let mut output = String::new();
        for (index, ch) in text.chars().rev().enumerate() {
            if index > 0 && index % 3 == 0 {
                output.push(',');
            }
            output.push(ch);
        }
        output.chars().rev().collect()
    }

    fn format_duration_ui(ms: u128) -> String {
        if ms < 1_000 {
            format!("{ms} ms")
        } else if ms < 60_000 {
            format!("{:.1} s", ms as f64 / 1_000.0)
        } else {
            format!("{}m {}s", ms / 60_000, (ms % 60_000) / 1_000)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_fields_are_escaped() {
        let mut output = String::new();
        push_csv_field(&mut output, "a,b \"c\"");
        assert_eq!(output, "\"a,b \"\"c\"\"\"");
    }

    fn make_test_node(id: usize, parent: Option<usize>, is_dir: bool, size: u64) -> NodeRecord {
        NodeRecord {
            id,
            parent,
            name: format!("node_{id}"),
            path: format!("/test/node_{id}"),
            is_dir,
            is_link: false,
            hidden: false,
            readonly: false,
            size,
            allocated: size,
            files: if is_dir { 0 } else { 1 },
            folders: 0,
            modified_ms: 1_000_000,
            depth: if parent.is_some() { 1 } else { 0 },
            errors: 0,
            children: Vec::new(),
            extension: String::new(),
        }
    }

    #[test]
    fn aggregate_nodes_sums_children_into_parent() {
        let mut nodes = vec![
            make_test_node(0, None, true, 0),
            make_test_node(1, Some(0), false, 100),
            make_test_node(2, Some(0), false, 250),
        ];
        nodes[0].children = vec![1, 2];

        aggregate_nodes(&mut nodes);

        assert_eq!(
            nodes[0].size, 350,
            "parent size should equal sum of children"
        );
        assert_eq!(
            nodes[0].files, 2,
            "parent files should equal count of child files"
        );
        assert_eq!(
            nodes[0].allocated, 350,
            "parent allocated should equal sum of children"
        );
    }

    #[test]
    fn snapshot_result_has_correct_aggregation() {
        let mut root = make_test_node(0, None, true, 0);
        let child_a = make_test_node(1, Some(0), false, 500);
        let child_b = make_test_node(2, Some(0), false, 300);
        root.children = vec![1, 2];

        let shared = Arc::new(WorkerShared {
            options: ScanOptions {
                root: PathBuf::from("/test"),
                include_hidden: true,
                follow_links: false,
                exclude_patterns: Vec::new(),
                max_depth: None,
                threads: 1,
            },
            nodes: Mutex::new(vec![root, child_a, child_b]),
            errors: Mutex::new(Vec::new()),
            queue: Mutex::new(QueueState {
                dirs: VecDeque::new(),
                active: 0,
                done: true,
            }),
            queue_ready: Condvar::new(),
            cancel: Arc::new(AtomicBool::new(false)),
        });

        let result = snapshot_scan_result(&shared, 1_000_000, 42, 1);

        assert_eq!(
            result.nodes[0].size, 800,
            "root size should be aggregated sum of children"
        );
        assert_eq!(
            result.nodes[0].files, 2,
            "root file count should aggregate children"
        );
        assert_eq!(result.elapsed_ms, 42);
        assert_eq!(result.thread_count, 1);
    }

    #[test]
    fn snapshot_releases_nodes_lock_before_aggregation() {
        // Build a shared state with some nodes.
        let mut root = make_test_node(0, None, true, 0);
        let child = make_test_node(1, Some(0), false, 100);
        root.children = vec![1];

        let shared = Arc::new(WorkerShared {
            options: ScanOptions {
                root: PathBuf::from("/test"),
                include_hidden: true,
                follow_links: false,
                exclude_patterns: Vec::new(),
                max_depth: None,
                threads: 1,
            },
            nodes: Mutex::new(vec![root, child]),
            errors: Mutex::new(Vec::new()),
            queue: Mutex::new(QueueState {
                dirs: VecDeque::new(),
                active: 0,
                done: true,
            }),
            queue_ready: Condvar::new(),
            cancel: Arc::new(AtomicBool::new(false)),
        });

        // Take the snapshot (this clones nodes then releases the lock).
        let _result = snapshot_scan_result(&shared, 1_000_000, 0, 1);

        // Verify that the nodes lock is not held — try_lock must succeed.
        assert!(
            shared.nodes.try_lock().is_ok(),
            "nodes lock should be released after snapshot_scan_result returns"
        );
    }

    #[test]
    fn active_guard_decrements_active_and_sets_done_when_empty() {
        let shared = Arc::new(WorkerShared {
            options: ScanOptions {
                root: PathBuf::from("/test"),
                include_hidden: true,
                follow_links: false,
                exclude_patterns: Vec::new(),
                max_depth: None,
                threads: 1,
            },
            nodes: Mutex::new(Vec::new()),
            errors: Mutex::new(Vec::new()),
            queue: Mutex::new(QueueState {
                dirs: VecDeque::new(),
                active: 1,
                done: false,
            }),
            queue_ready: Condvar::new(),
            cancel: Arc::new(AtomicBool::new(false)),
        });

        {
            let _guard = ActiveGuard {
                shared: Arc::clone(&shared),
            };
            // Simulate work
            let queue = shared.queue.lock().unwrap();
            assert_eq!(queue.active, 1);
            assert!(!queue.done);
        }

        // After guard is dropped:
        let queue = shared.queue.lock().unwrap();
        assert_eq!(queue.active, 0, "active count should be decremented");
        assert!(
            queue.done,
            "done should be true because active == 0 and dirs is empty"
        );
    }

    #[test]
    fn active_guard_does_not_set_done_when_dirs_remain() {
        let shared = Arc::new(WorkerShared {
            options: ScanOptions {
                root: PathBuf::from("/test"),
                include_hidden: true,
                follow_links: false,
                exclude_patterns: Vec::new(),
                max_depth: None,
                threads: 1,
            },
            nodes: Mutex::new(Vec::new()),
            errors: Mutex::new(Vec::new()),
            queue: Mutex::new(QueueState {
                dirs: VecDeque::from(vec![0]),
                active: 2,
                done: false,
            }),
            queue_ready: Condvar::new(),
            cancel: Arc::new(AtomicBool::new(false)),
        });

        {
            let _guard = ActiveGuard {
                shared: Arc::clone(&shared),
            };
        }

        let queue = shared.queue.lock().unwrap();
        assert_eq!(queue.active, 1, "active count should be decremented");
        assert!(
            !queue.done,
            "done should be false because dirs is not empty"
        );
    }

    #[test]
    fn scan_path_with_progress_sends_partial_results() {
        let temp_dir = std::env::temp_dir().join(format!("filetree_test_{}", now_ms()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let file_path = temp_dir.join("test_file.txt");
        std::fs::write(&file_path, "hello world").unwrap();

        let options = ScanOptions {
            root: temp_dir.clone(),
            include_hidden: true,
            follow_links: false,
            exclude_patterns: Vec::new(),
            max_depth: None,
            threads: 1,
        };

        let mut progress_called = false;

        let cancel = Arc::new(AtomicBool::new(false));
        let _res = scan_path_with_progress(options, cancel, |node_count, _elapsed_ms, _partial| {
            progress_called = true;
            assert!(node_count >= 1);
        });

        // Clean up
        let _ = std::fs::remove_file(&file_path);
        let _ = std::fs::remove_dir(&temp_dir);

        assert!(progress_called, "progress callback should be called");
    }
}
