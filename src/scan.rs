use std::collections::VecDeque;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::io::{
    display_name, is_hidden_entry, metadata_modified_ms, now_ms, platform_allocated_size,
    platform_allocated_size_raw, should_exclude, should_recurse,
};
use crate::model::{NodeRecord, QueueState, ScanError, ScanOptions, ScanResult, WorkerShared};

// ──────────────────────────────────────────────────────────────────
// Extension extraction from raw name string (avoids Path allocation)
// ──────────────────────────────────────────────────────────────────
#[inline]
fn extension_from_name(name: &str) -> &str {
    match name.rfind('.') {
        // dot must not be at position 0 (dotfiles have no extension)
        // and must not be the last character
        Some(dot) if dot > 0 && dot + 1 < name.len() => &name[dot + 1..],
        _ => "",
    }
}

// ──────────────────────────────────────────────────────────────────
// Fast path string builder (avoids PathBuf round-trip)
// ──────────────────────────────────────────────────────────────────
#[inline]
fn join_path(parent: &str, name: &str) -> String {
    let mut s = String::with_capacity(parent.len() + 1 + name.len());
    s.push_str(parent);
    if !parent.ends_with('\\') && !parent.ends_with('/') {
        s.push('\\');
    }
    s.push_str(name);
    s
}

pub(crate) fn scan_path(options: ScanOptions) -> io::Result<ScanResult> {
    scan_path_with_progress(options, Arc::new(AtomicBool::new(false)), |_, _| {})
}

pub(crate) fn scan_path_with_progress<F>(
    options: ScanOptions,
    cancel: Arc<AtomicBool>,
    mut progress: F,
) -> io::Result<ScanResult>
where
    F: FnMut(usize, u64),
{
    if !options.root.exists() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("path does not exist: {}", options.root.display()),
        ));
    }

    let started = Instant::now();
    let scanned_at_ms: u64 = now_ms();
    let root_metadata = fs::symlink_metadata(&options.root)?;
    let root_is_link = root_metadata.file_type().is_symlink();
    let root_is_dir = root_metadata.is_dir();
    let root_hidden = is_hidden_entry(&options.root, &root_metadata);
    let root_name = display_name(&options.root);
    let root_path = options.root.display().to_string();
    // Owner is opt-in (one security-descriptor open per entry); attributes are
    // free here (already in the root metadata on Windows).
    let root_owner = if options.collect_owners {
        crate::owner::owner_of(&root_path)
    } else {
        String::new()
    };
    #[cfg(windows)]
    let root_attributes = {
        use std::os::windows::fs::MetadataExt;
        root_metadata.file_attributes()
    };
    #[cfg(not(windows))]
    let root_attributes = 0u32;
    let root_node = NodeRecord {
        id: 0,
        parent: None,
        name: root_name,
        path: root_path,
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
        created_ms: 0,
        accessed_ms: 0,
        depth: 0,
        errors: 0,
        children: Vec::new(),
        extension: String::new(),
        owner: root_owner,
        attributes: root_attributes,
    };

    let queue = if root_is_dir {
        VecDeque::from([0usize])
    } else {
        VecDeque::new()
    };
    let done = queue.is_empty();
    let thread_count = options.threads.clamp(1, 64);

    // Pre-allocate nodes with a generous capacity hint.
    // Most Windows drive scans have 100k–2M nodes; start at 256k to avoid
    // the 20+ doublings that happen with a default Vec.
    let nodes_initial = Vec::with_capacity(256_000);
    let mut nodes_init = nodes_initial;
    nodes_init.push(root_node);

    // Atomic node counter — workers use fetch_add to claim ID slots without
    // holding the nodes mutex, then write into the pre-reserved slots.
    // Invariant: node_count.load() == nodes.lock().len() at all times that
    // the nodes mutex is NOT held by a worker.
    let node_count = Arc::new(AtomicUsize::new(1)); // root occupies id=0

    let shared = Arc::new(WorkerShared {
        options,
        nodes: Mutex::new(nodes_init),
        errors: Mutex::new(Vec::new()),
        queue: Mutex::new(QueueState {
            dirs: queue,
            active: 0,
            done,
        }),
        queue_ready: Condvar::new(),
        cancel,
    });
    let node_count_shared = Arc::clone(&node_count);

    let mut handles = Vec::with_capacity(thread_count);
    for _ in 0..thread_count {
        let shared = Arc::clone(&shared);
        let node_count = Arc::clone(&node_count_shared);
        handles.push(thread::spawn(move || worker_loop(shared, node_count)));
    }

    let mut last_progress_nodes = 0usize;
    loop {
        // For large scans (> 50k nodes), halve the snapshot frequency.
        let interval_ms = if last_progress_nodes > 50_000 { 3000 } else { 1500 };
        thread::sleep(Duration::from_millis(interval_ms));
        let scan_done = {
            let queue = shared.queue.lock().expect("queue lock poisoned");
            queue.done
        };
        let current_count = node_count_shared.load(Ordering::Relaxed);
        if current_count != last_progress_nodes || scan_done {
            progress(current_count, started.elapsed().as_millis() as u64);
            last_progress_nodes = current_count;
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
        started.elapsed().as_millis() as u64,
        thread_count,
    ))
}

pub(crate) fn snapshot_scan_result(
    shared: &WorkerShared,
    scanned_at_ms: u64,
    elapsed_ms: u64,
    thread_count: usize,
) -> ScanResult {
    // Clone nodes and errors while holding their locks, then drop locks
    // immediately so worker threads are not blocked during aggregation.
    // Workers have already joined (handles are joined before this is called), so
    // move the buffers out instead of cloning them (~250-400 MB at 750k nodes).
    // mem::take leaves empty Vecs behind, which is fine — the scan is finished.
    let mut nodes = std::mem::take(&mut *shared.nodes.lock().expect("nodes lock poisoned"));
    let errors = std::mem::take(&mut *shared.errors.lock().expect("errors lock poisoned"));

    // Aggregation is O(n) and must not hold any shared lock.
    aggregate_nodes(&mut nodes);

    let root_path = nodes.first().map(|node| node.path.clone()).unwrap_or_default();
    // Compute capped analytics once here so responses/cache hits never recompute.
    let summary = crate::analytics::scan_summary(&nodes, scanned_at_ms);

    ScanResult {
        root_path,
        scanned_at_ms,
        elapsed_ms,
        thread_count,
        nodes,
        errors,
        summary,
    }
}

pub(crate) struct ActiveGuard {
    pub(crate) shared: Arc<WorkerShared>,
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

fn worker_loop(shared: Arc<WorkerShared>, node_count: Arc<AtomicUsize>) {
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
            scan_directory_job(&shared, &node_count, dir_id);
        }
    }
}

fn scan_directory_job(shared: &Arc<WorkerShared>, node_count: &Arc<AtomicUsize>, dir_id: usize) {
    if shared.cancel.load(Ordering::Relaxed) {
        return;
    }

    let (dir_path, dir_depth) = {
        let nodes = shared.nodes.lock().expect("nodes lock poisoned");
        let Some(node) = nodes.get(dir_id) else {
            return;
        };
        (node.path.clone(), node.depth)
    };

    #[cfg(windows)]
    {
        scan_directory_win32(shared, node_count, dir_id, &dir_path, dir_depth);
    }
    #[cfg(not(windows))]
    {
        scan_directory_portable(shared, node_count, dir_id, &PathBuf::from(&dir_path), dir_depth);
    }
}

// ──────────────────────────────────────────────────────────────────
// Windows fast path
// ──────────────────────────────────────────────────────────────────

#[cfg(windows)]
fn scan_directory_win32(
    shared: &Arc<WorkerShared>,
    node_count: &Arc<AtomicUsize>,
    dir_id: usize,
    dir_path: &str,
    dir_depth: usize,
) {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x0000_0002;
    const FILE_ATTRIBUTE_READONLY: u32 = 0x0000_0001;
    const FILE_ATTRIBUTE_COMPRESSED: u32 = 0x0000_0800;
    let _file_attribute_system: u32 = 0x0000_0004; // reserved for future use
    const FIND_FIRST_EX_LARGE_FETCH: u32 = 0x0000_0002;
    const FIND_FIRST_EX_ON_DISK_ENTRIES_ONLY: u32 = 0x0000_0004;
    const INVALID_HANDLE_VALUE: isize = -1isize;

    #[repr(C)]
    #[allow(non_snake_case, clippy::upper_case_acronyms)]
    struct FILETIME {
        dwLowDateTime: u32,
        dwHighDateTime: u32,
    }

    // WIN32_FIND_DATAW layout (exact Win32 struct, 592 bytes)
    #[repr(C)]
    #[allow(non_snake_case, clippy::upper_case_acronyms)]
    struct WIN32_FIND_DATAW {
        dwFileAttributes: u32,
        ftCreationTime: FILETIME,
        ftLastAccessTime: FILETIME,
        ftLastWriteTime: FILETIME,
        nFileSizeHigh: u32,
        nFileSizeLow: u32,
        dwReserved0: u32,
        dwReserved1: u32,
        cFileName: [u16; 260],
        cAlternateFileName: [u16; 14],
        dwFileType: u32,
        dwCreatorType: u32,
        wFinderFlags: u16,
    }

    #[link(name = "Kernel32")]
    #[allow(dead_code)]
    unsafe extern "system" {
        fn FindFirstFileExW(
            lpFileName: *const u16,
            fInfoLevelId: u32,
            lpFindFileData: *mut WIN32_FIND_DATAW,
            fSearchOp: u32,
            lpSearchFilter: *const u8,
            dwAdditionalFlags: u32,
        ) -> isize;
        fn FindNextFileW(hFindFile: isize, lpFindFileData: *mut WIN32_FIND_DATAW) -> i32;
        fn FindClose(hFindFile: isize) -> i32;
        fn GetCompressedFileSizeW(lpFileName: *const u16, lpFileSizeHigh: *mut u32) -> u32;
        fn GetLastError() -> u32;
    }

    // Build the "dir_path\*" wide string for FindFirstFileExW.
    // Re-use dir_path as a &str to avoid a PathBuf round-trip.
    let pattern: Vec<u16> = {
        use std::os::windows::ffi::OsStrExt;
        use std::ffi::OsStr;
        let mut wide: Vec<u16> = OsStr::new(dir_path).encode_wide().collect();
        if wide.last().copied() != Some(b'\\' as u16) && wide.last().copied() != Some(b'/' as u16) {
            wide.push(b'\\' as u16);
        }
        wide.push(b'*' as u16);
        wide.push(0u16);
        wide
    };

    let mut find_data = std::mem::MaybeUninit::<WIN32_FIND_DATAW>::uninit();
    let handle = unsafe {
        FindFirstFileExW(
            pattern.as_ptr(),
            1, // FindExInfoBasic — skips alternate (8.3) name, faster
            find_data.as_mut_ptr(),
            0, // FindExSearchNameMatch
            std::ptr::null(),
            FIND_FIRST_EX_LARGE_FETCH | FIND_FIRST_EX_ON_DISK_ENTRIES_ONLY,
        )
    };

    if handle == INVALID_HANDLE_VALUE {
        let err = unsafe { GetLastError() };
        add_scan_error(
            shared,
            dir_id,
            dir_path,
            format!("FindFirstFileExW failed: error {err}"),
        );
        return;
    }

    // Helper: FILETIME (100-ns ticks since 1601-01-01) → Unix ms
    let filetime_to_ms = |hi: u32, lo: u32| -> u64 {
        let ft = ((hi as u64) << 32) | lo as u64;
        ft.saturating_sub(116_444_736_000_000_000)
            .checked_div(10_000)
            .unwrap_or(0)
    };

    // Accumulate all entries for this directory before touching any locks.
    // Use a Vec pre-sized for a typical directory.
    let mut local_nodes: Vec<NodeRecord> = Vec::with_capacity(64);
    // Parallel sentinel vec: usize::MAX-1 = file, usize::MAX = depth limit, else = dir to queue
    let mut pending_dir_indices: Vec<usize> = Vec::with_capacity(64);
    let mut depth_limit_paths: Vec<String> = Vec::new();

    loop {
        if shared.cancel.load(Ordering::Relaxed) {
            break;
        }

        let data = unsafe { find_data.assume_init_ref() };
        let attrs = data.dwFileAttributes;

        // Skip . and .. fast (compare raw u16 bytes)
        let c0 = data.cFileName[0];
        let c1 = data.cFileName[1];
        if c0 == b'.' as u16 && (c1 == 0 || (c1 == b'.' as u16 && data.cFileName[2] == 0)) {
            if unsafe { FindNextFileW(handle, find_data.as_mut_ptr()) } == 0 { break; }
            continue;
        }

        let is_dir = attrs & FILE_ATTRIBUTE_DIRECTORY != 0;
        let is_link = attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0;
        let hidden = attrs & FILE_ATTRIBUTE_HIDDEN != 0;

        if hidden && !shared.options.include_hidden {
            if unsafe { FindNextFileW(handle, find_data.as_mut_ptr()) } == 0 { break; }
            continue;
        }

        // Decode name (null-terminated UTF-16) directly to &str via OsString
        let name_len = data.cFileName.iter().position(|&c| c == 0).unwrap_or(260);
        let name_wide = &data.cFileName[..name_len];
        let name_os = OsString::from_wide(name_wide);
        let name_str = name_os.to_string_lossy();

        // Build full path string without PathBuf allocation
        let entry_path_str = join_path(dir_path, &name_str);

        if !shared.options.exclude_patterns.is_empty()
            && should_exclude(&shared.options.exclude_patterns, &name_str, &entry_path_str)
        {
            if unsafe { FindNextFileW(handle, find_data.as_mut_ptr()) } == 0 { break; }
            continue;
        }

        let depth = dir_depth + 1;
        let readonly = attrs & FILE_ATTRIBUTE_READONLY != 0;

        let (size, allocated, modified_ms, created_ms, accessed_ms) =
            if is_link && shared.options.follow_links && !is_dir {
                // Need to stat the symlink target — only in this uncommon case
                match fs::metadata(&entry_path_str) {
                    Ok(m) => {
                        let s = m.len();
                        let a = platform_allocated_size_raw(&PathBuf::from(&entry_path_str), s);
                        let t = metadata_modified_ms(&m);
                        (s, a, t, 0u64, 0u64)
                    }
                    Err(_) => (0u64, 0u64, 0u64, 0u64, 0u64),
                }
            } else if is_dir {
                (0u64, 0u64,
                 filetime_to_ms(data.ftLastWriteTime.dwHighDateTime, data.ftLastWriteTime.dwLowDateTime),
                 filetime_to_ms(data.ftCreationTime.dwHighDateTime,   data.ftCreationTime.dwLowDateTime),
                 filetime_to_ms(data.ftLastAccessTime.dwHighDateTime, data.ftLastAccessTime.dwLowDateTime))
            } else {
                let s = ((data.nFileSizeHigh as u64) << 32) | data.nFileSizeLow as u64;
                // Only call GetCompressedFileSizeW for compressed files — saves a syscall per file
                let a = if attrs & FILE_ATTRIBUTE_COMPRESSED != 0 {
                    platform_allocated_size_raw(&PathBuf::from(&entry_path_str), s)
                } else {
                    s
                };
                let t  = filetime_to_ms(data.ftLastWriteTime.dwHighDateTime, data.ftLastWriteTime.dwLowDateTime);
                let cr = filetime_to_ms(data.ftCreationTime.dwHighDateTime,   data.ftCreationTime.dwLowDateTime);
                let ac = filetime_to_ms(data.ftLastAccessTime.dwHighDateTime, data.ftLastAccessTime.dwLowDateTime);
                (s, a, t, cr, ac)
            };

        // Extract extension from name string (no Path allocation)
        let extension = if !is_dir {
            extension_from_name(&name_str).to_lowercase()
        } else {
            String::new()
        };

        let needs_queue = is_dir && should_recurse(depth, shared.options.max_depth);
        let at_depth_limit = is_dir && !needs_queue && shared.options.max_depth.is_some();

        // Owner is opt-in: GetNamedSecurityInfo opens a security descriptor per
        // entry, so resolving it unconditionally would slow large scans. The
        // attribute bitmask is already in hand (`attrs`), so it's always carried.
        let owner = if shared.options.collect_owners {
            crate::owner::owner_of(&entry_path_str)
        } else {
            String::new()
        };

        let local_idx = local_nodes.len();
        local_nodes.push(NodeRecord {
            id: 0, // assigned below
            parent: Some(dir_id),
            name: name_str.into_owned(),
            // Path interning: only directories (and the root) keep their full
            // path; a file's is reconstructed on demand from its parent dir +
            // name (see `model::node_abs_path`), removing the largest per-file
            // allocation. `entry_path_str` is still moved into `depth_limit_paths`
            // below for the depth-limited-directory case.
            path: if is_dir { entry_path_str.clone() } else { String::new() },
            is_dir,
            is_link,
            hidden,
            readonly,
            size,
            allocated,
            files: if !is_dir { 1 } else { 0 },
            folders: 0,
            modified_ms,
            created_ms,
            accessed_ms,
            depth,
            errors: 0,
            children: Vec::new(),
            extension,
            owner,
            attributes: attrs,
        });

        if needs_queue {
            pending_dir_indices.push(local_idx);
        } else if at_depth_limit {
            pending_dir_indices.push(usize::MAX);
            depth_limit_paths.push(entry_path_str);
        } else {
            pending_dir_indices.push(usize::MAX - 1);
        }

        if unsafe { FindNextFileW(handle, find_data.as_mut_ptr()) } == 0 {
            break;
        }
    }

    unsafe { FindClose(handle) };

    if local_nodes.is_empty() {
        return;
    }

    let n = local_nodes.len();

    // Atomically reserve n consecutive ID slots.
    // This avoids holding the nodes mutex while we build child IDs.
    let first_id = node_count.fetch_add(n, Ordering::Relaxed);

    // Assign IDs to local nodes before acquiring any lock
    for (i, node) in local_nodes.iter_mut().enumerate() {
        node.id = first_id + i;
    }

    // One lock acquisition to push all nodes + update parent's children list
    {
        let mut nodes = shared.nodes.lock().expect("nodes lock poisoned");
        // Ensure Vec has capacity for the new slots
        if nodes.len() + n > nodes.capacity() {
            nodes.reserve(n.max(4096));
        }
        // Extend Vec with the new nodes (which now have correct IDs)
        nodes.extend(local_nodes.into_iter());
        // Register all children on the parent in one pass
        if let Some(parent_node) = nodes.get_mut(dir_id) {
            for i in 0..n {
                parent_node.children.push(first_id + i);
            }
        }
    }

    // Collect directories to enqueue and depth-limit errors
    let mut dirs_to_scan: Vec<usize> = Vec::new();
    let mut depth_limit_iter = depth_limit_paths.into_iter();

    for (i, &sentinel) in pending_dir_indices.iter().enumerate() {
        let child_id = first_id + i;
        if sentinel == usize::MAX {
            let path_str = depth_limit_iter.next().unwrap_or_default();
            add_scan_error(shared, child_id, &path_str, "depth limit reached".to_string());
        } else if sentinel != usize::MAX - 1 {
            dirs_to_scan.push(child_id);
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

// ──────────────────────────────────────────────────────────────────
// Portable fallback (non-Windows)
// ──────────────────────────────────────────────────────────────────
#[cfg(not(windows))]
fn scan_directory_portable(
    shared: &Arc<WorkerShared>,
    node_count: &Arc<AtomicUsize>,
    dir_id: usize,
    dir_path: &Path,
    dir_depth: usize,
) {
    let entries = match fs::read_dir(dir_path) {
        Ok(entries) => entries,
        Err(error) => {
            add_scan_error(shared, dir_id, &dir_path.display().to_string(), error.to_string());
            return;
        }
    };

    let mut local_nodes: Vec<NodeRecord> = Vec::with_capacity(32);
    let mut pending_dirs: Vec<usize> = Vec::new();
    let mut depth_limit_paths: Vec<String> = Vec::new();

    for entry in entries {
        if shared.cancel.load(Ordering::Relaxed) {
            break;
        }

        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                add_scan_error(shared, dir_id, &dir_path.display().to_string(), error.to_string());
                continue;
            }
        };

        let entry_path = entry.path();
        let symlink_meta = match fs::symlink_metadata(&entry_path) {
            Ok(m) => m,
            Err(error) => {
                add_scan_error(shared, dir_id, &entry_path.display().to_string(), error.to_string());
                continue;
            }
        };
        let is_link = symlink_meta.file_type().is_symlink();
        let metadata = if shared.options.follow_links && is_link {
            match fs::metadata(&entry_path) {
                Ok(m) => m,
                Err(error) => {
                    add_scan_error(shared, dir_id, &entry_path.display().to_string(), error.to_string());
                    continue;
                }
            }
        } else {
            symlink_meta
        };

        let is_dir = metadata.is_dir();
        let hidden = is_hidden_entry(&entry_path, &metadata);
        if hidden && !shared.options.include_hidden {
            continue;
        }

        let name = display_name(&entry_path);
        let path_string = entry_path.display().to_string();
        if should_exclude(&shared.options.exclude_patterns, &name, &path_string) {
            continue;
        }

        let depth = dir_depth + 1;
        let is_file_like = !is_dir;
        let size = if is_file_like { metadata.len() } else { 0 };
        let allocated = if is_file_like {
            platform_allocated_size_raw(&entry_path, size)
        } else {
            0
        };

        let needs_queue = is_dir && should_recurse(depth, shared.options.max_depth);
        let at_depth_limit = is_dir && !needs_queue && shared.options.max_depth.is_some();

        let owner = if shared.options.collect_owners {
            crate::owner::owner_of(&path_string)
        } else {
            String::new()
        };

        let local_idx = local_nodes.len();
        local_nodes.push(NodeRecord {
            id: 0,
            parent: Some(dir_id),
            name,
            // Path interning: files drop their path (rebuilt from parent dir +
            // name via `model::node_abs_path`); dirs keep it. `path_string` is
            // still moved into `depth_limit_paths` below for depth-limited dirs.
            path: if is_dir { path_string.clone() } else { String::new() },
            is_dir,
            is_link,
            hidden,
            readonly: metadata.permissions().readonly(),
            size,
            allocated,
            files: if is_file_like { 1 } else { 0 },
            folders: 0,
            modified_ms: metadata_modified_ms(&metadata),
            created_ms: 0,
            accessed_ms: 0,
            depth,
            errors: 0,
            children: Vec::new(),
            extension: if is_file_like { extension_from_name(&local_nodes.last().map(|_| "").unwrap_or("")).to_string() } else { String::new() },
            owner,
            // Raw Windows attribute bitmask is unavailable via std metadata on
            // non-Windows; the existing hidden/readonly bools still carry over.
            attributes: 0,
        });

        // Fix extension after push (borrow checker)
        if is_file_like {
            let last = local_nodes.last_mut().unwrap();
            last.extension = extension_from_name(&last.name).to_lowercase();
        }

        if needs_queue {
            pending_dirs.push(local_idx);
        } else if at_depth_limit {
            pending_dirs.push(usize::MAX);
            depth_limit_paths.push(path_string);
        } else {
            pending_dirs.push(usize::MAX - 1);
        }
    }

    if local_nodes.is_empty() {
        return;
    }

    let n = local_nodes.len();
    let first_id = node_count.fetch_add(n, Ordering::Relaxed);
    for (i, node) in local_nodes.iter_mut().enumerate() {
        node.id = first_id + i;
    }

    {
        let mut nodes = shared.nodes.lock().expect("nodes lock poisoned");
        if nodes.len() + n > nodes.capacity() {
            nodes.reserve(n.max(4096));
        }
        nodes.extend(local_nodes.into_iter());
        if let Some(parent_node) = nodes.get_mut(dir_id) {
            for i in 0..n {
                parent_node.children.push(first_id + i);
            }
        }
    }

    let mut dirs_to_scan: Vec<usize> = Vec::new();
    let mut depth_limit_iter = depth_limit_paths.into_iter();

    for (i, &sentinel) in pending_dirs.iter().enumerate() {
        let child_id = first_id + i;
        if sentinel == usize::MAX {
            let path_str = depth_limit_iter.next().unwrap_or_default();
            add_scan_error(shared, child_id, &path_str, "depth limit reached".to_string());
        } else if sentinel != usize::MAX - 1 {
            dirs_to_scan.push(child_id);
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

fn add_scan_error(shared: &WorkerShared, node_id: usize, path: &str, message: String) {
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
            path: path.to_string(),
            message,
        });
}

// ──────────────────────────────────────────────────────────────────
// Aggregation — O(n), no temporary Vec allocations
// ──────────────────────────────────────────────────────────────────
pub(crate) fn aggregate_nodes(nodes: &mut [NodeRecord]) {
    // Process deepest nodes first (bottom-up) so each parent sees
    // fully-aggregated children when it runs.
    // Build depth-sorted order without allocating a names/sizes clone.
    // Order indices deepest-first via a counting sort on depth (O(n + maxDepth))
    // instead of sorting all n indices (O(n log n)).
    let max_depth = nodes.iter().map(|n| n.depth).max().unwrap_or(0);
    let mut by_depth: Vec<Vec<usize>> = vec![Vec::new(); max_depth + 1];
    for (i, node) in nodes.iter().enumerate() {
        by_depth[node.depth].push(i);
    }
    let mut order: Vec<usize> = Vec::with_capacity(nodes.len());
    for bucket in by_depth.iter().rev() {
        order.extend_from_slice(bucket);
    }

    for id in order {
        if !nodes[id].is_dir {
            continue;
        }

        // Collect child stats in one pass over the children list
        let n_children = nodes[id].children.len();
        if n_children == 0 {
            continue;
        }

        let mut size = 0u64;
        let mut allocated = 0u64;
        let mut files = 0u64;
        let mut folders = 0u64;
        let mut errors = nodes[id].errors;
        let mut modified_ms = nodes[id].modified_ms;

        // Take the child id vec out (O(1)) instead of cloning it; restored below.
        let children = std::mem::take(&mut nodes[id].children);
        for child_id in &children {
            let child = &nodes[*child_id];
            size = size.saturating_add(child.size);
            allocated = allocated.saturating_add(child.allocated);
            files = files.saturating_add(child.files);
            errors = errors.saturating_add(child.errors);
            if modified_ms < child.modified_ms { modified_ms = child.modified_ms; }
            if child.is_dir {
                folders = folders
                    .saturating_add(1)
                    .saturating_add(child.folders);
            }
        }

        nodes[id].size = size;
        nodes[id].allocated = allocated;
        nodes[id].files = files;
        nodes[id].folders = folders;
        nodes[id].errors = errors;
        nodes[id].modified_ms = modified_ms;
        nodes[id].children = children; // restore (taken above to avoid a clone)
    }

    // Sort each dir's children by size desc, then name asc.
    // Two-pass approach: collect (dir_id, sorted_children) first so we can
    // borrow `nodes` immutably for the sort keys, then write results back.
    // This allocates one small Vec<usize> per directory (just IDs — cheap)
    // rather than the previous approach of cloning two full-length name+size
    // Vecs over the entire node set.
    let dir_ids: Vec<usize> = nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| n.is_dir && n.children.len() >= 2)
        .map(|(id, _)| id)
        .collect();

    for dir_id in dir_ids {
        let mut children = std::mem::take(&mut nodes[dir_id].children);
        // Sort by size desc, then case-insensitive name asc. A cached key
        // lowercases each name once instead of twice on every comparison.
        children.sort_by_cached_key(|&cid| {
            let n = &nodes[cid];
            (std::cmp::Reverse(n.size), n.name.to_lowercase())
        });
        nodes[dir_id].children = children;
    }

    // Children are only needed for aggregation and sorting above.
    // Free the Vecs now to reduce peak RSS before JSON serialisation.
    for node in nodes.iter_mut() {
        node.children = Vec::new();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::now_ms;
    use crate::model::{QueueState, ScanOptions, WorkerShared};

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
            created_ms: 0,
            accessed_ms: 0,
            depth: if parent.is_some() { 1 } else { 0 },
            errors: 0,
            children: Vec::new(),
            extension: String::new(),
            owner: String::new(),
            attributes: 0,
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

        let _node_count = Arc::new(AtomicUsize::new(3));
        let shared = Arc::new(WorkerShared {
            options: ScanOptions {
                root: PathBuf::from("/test"),
                include_hidden: true,
                follow_links: false,
                exclude_patterns: Vec::new(),
                max_depth: None,
                threads: 1,
                collect_owners: false,
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
                collect_owners: false,
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

        let _result = snapshot_scan_result(&shared, 1_000_000, 0, 1);

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
                collect_owners: false,
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
            let queue = shared.queue.lock().unwrap();
            assert_eq!(queue.active, 1);
            assert!(!queue.done);
        }

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
                collect_owners: false,
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
            collect_owners: false,
        };

        let mut progress_called = false;

        let cancel = Arc::new(AtomicBool::new(false));
        let _res = scan_path_with_progress(options, cancel, |node_count, _elapsed_ms| {
            progress_called = true;
            assert!(node_count >= 1);
        });

        let _ = std::fs::remove_file(&file_path);
        let _ = std::fs::remove_dir(&temp_dir);

        assert!(progress_called, "progress callback should be called");
    }

    #[test]
    fn extension_from_name_extracts_correctly() {
        assert_eq!(extension_from_name("foo.rs"), "rs");
        assert_eq!(extension_from_name("archive.tar.gz"), "gz");
        assert_eq!(extension_from_name("no_ext"), "");
        assert_eq!(extension_from_name(".hidden"), "");
        assert_eq!(extension_from_name("file."), "");
    }

    #[test]
    fn join_path_builds_correctly() {
        assert_eq!(join_path("C:\\foo", "bar"), "C:\\foo\\bar");
        assert_eq!(join_path("C:\\foo\\", "bar"), "C:\\foo\\bar");
        assert_eq!(join_path("/usr/local", "bin"), "/usr/local\\bin");
    }
}
