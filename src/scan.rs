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
use crate::model::{
    DirJob, NodeRecord, QueueState, ScanError, ScanOptions, ScanResult, WorkerShared,
};

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

    // Reserve worker-thread slots from the process-wide scan budget so that
    // several concurrent scans share the CPU instead of each spawning a full
    // thread pool. The permit is held (RAII) until every worker has joined at the
    // end of this function, then released for the next waiting scan.
    let scan_permit = crate::io::acquire_scan_threads(options.threads.clamp(1, 64));
    let thread_count = scan_permit.threads();

    // Root is id 0 and lives outside the worker buffers. If it is a directory,
    // seed the queue with its own scan job; the path + depth the job needs travel
    // WITH the job, so a worker never has to read a shared node buffer to scan it.
    let initial_queue: VecDeque<DirJob> = if root_is_dir {
        VecDeque::from([DirJob { id: 0, path: root_node.path.clone(), depth: 0 }])
    } else {
        VecDeque::new()
    };
    let done = initial_queue.is_empty();

    // Atomic node counter — a worker fetch_adds to claim a contiguous id range for
    // the children of the directory it is scanning, assigns those ids, and writes
    // the records into its OWN thread-local buffer (no shared lock). Root is id 0,
    // so the counter starts at 1; the final node count equals this counter.
    let node_count = Arc::new(AtomicUsize::new(1));

    let shared = Arc::new(WorkerShared {
        options,
        errors: Mutex::new(Vec::new()),
        queue: Mutex::new(QueueState {
            dirs: initial_queue,
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

    // Collect each worker's thread-local node buffer (workers have all joined, so
    // every record they produced is now owned here).
    let mut worker_buffers: Vec<Vec<NodeRecord>> = Vec::with_capacity(thread_count);
    for handle in handles {
        if let Ok(buf) = handle.join() {
            worker_buffers.push(buf);
        }
    }

    let total_nodes = node_count_shared.load(Ordering::Relaxed);
    let pending_errors =
        std::mem::take(&mut *shared.errors.lock().expect("errors lock poisoned"));

    Ok(finalize_scan_result(
        root_node,
        worker_buffers,
        total_nodes,
        pending_errors,
        scanned_at_ms,
        started.elapsed().as_millis() as u64,
        thread_count,
    ))
}

/// Assemble the final, contiguous node buffer from the root node plus every
/// worker's thread-local buffer, then aggregate. The sharded scan produces id
/// blocks in nondeterministic worker order, so this SCATTERS each record to
/// `nodes[record.id]`, restoring the positional `id == index` contract exactly —
/// the invariant every endpoint, serializer, and `aggregate_nodes` itself relies
/// on. `parent.children` lists and per-node error counts are rebuilt here (they
/// can't be maintained across independent buffers during the walk).
pub(crate) fn finalize_scan_result(
    root: NodeRecord,
    worker_buffers: Vec<Vec<NodeRecord>>,
    total_nodes: usize,
    pending_errors: Vec<(usize, ScanError)>,
    scanned_at_ms: u64,
    elapsed_ms: u64,
    thread_count: usize,
) -> ScanResult {
    // Scatter by id into a pre-sized buffer. The placeholder carries only empty
    // String/Vec fields (no heap allocation), so filling `total_nodes` slots is
    // cheap; each real record is then MOVED into its slot (its heap strings are
    // moved, not copied). Ids are contiguous (root = 0, plus every fetch_add
    // block), so each slot is written exactly once.
    let placeholder = NodeRecord {
        id: 0,
        parent: None,
        name: String::new(),
        path: String::new(),
        is_dir: false,
        is_link: false,
        hidden: false,
        readonly: false,
        size: 0,
        allocated: 0,
        files: 0,
        folders: 0,
        modified_ms: 0,
        created_ms: 0,
        accessed_ms: 0,
        depth: 0,
        errors: 0,
        children: Vec::new(),
        extension: String::new(),
        owner: String::new(),
        attributes: 0,
    };
    let mut nodes: Vec<NodeRecord> = vec![placeholder; total_nodes.max(1)];
    let root_id = root.id;
    if root_id < nodes.len() {
        nodes[root_id] = root;
    }
    for buf in worker_buffers {
        for node in buf {
            let id = node.id;
            if id < nodes.len() {
                nodes[id] = node;
            }
        }
    }

    // Rebuild each parent's children list from the parent pointers, in ascending
    // id order. This reproduces the previous incremental push order exactly (a
    // directory's children always occupied one contiguous, ascending id block),
    // and `aggregate_nodes` re-sorts children anyway.
    for id in 0..nodes.len() {
        let Some(parent) = nodes[id].parent else { continue };
        if parent < nodes.len() {
            nodes[parent].children.push(id);
        }
    }

    // Apply the deferred per-node error counts, then collect the error messages.
    let mut errors = Vec::with_capacity(pending_errors.len());
    for (node_id, err) in pending_errors {
        if let Some(node) = nodes.get_mut(node_id) {
            node.errors = node.errors.saturating_add(1);
        }
        errors.push(err);
    }

    // Aggregation is O(n) and operates on the owned buffer (no shared lock held).
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

/// Run one scan worker, returning the thread-local node buffer it accumulated.
/// Each worker owns its `Vec<NodeRecord>`; nodes are scattered into the final
/// contiguous buffer by id in `finalize_scan_result`, so workers never contend
/// on a shared node lock — they only take the (short-lived) queue lock to claim
/// the next directory job and to push freshly discovered sub-directories.
fn worker_loop(shared: Arc<WorkerShared>, node_count: Arc<AtomicUsize>) -> Vec<NodeRecord> {
    let mut local_buf: Vec<NodeRecord> = Vec::new();
    loop {
        if shared.cancel.load(Ordering::Relaxed) {
            let mut queue = shared.queue.lock().expect("queue lock poisoned");
            queue.done = true;
            shared.queue_ready.notify_all();
            return local_buf;
        }

        let job = {
            let mut queue = shared.queue.lock().expect("queue lock poisoned");
            loop {
                if shared.cancel.load(Ordering::Relaxed) {
                    queue.done = true;
                    shared.queue_ready.notify_all();
                    break None;
                }
                if let Some(job) = queue.dirs.pop_front() {
                    queue.active += 1;
                    break Some(job);
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

        let Some(job) = job else {
            return local_buf;
        };

        {
            let _guard = ActiveGuard {
                shared: Arc::clone(&shared),
            };
            scan_directory_job(&shared, &node_count, &job, &mut local_buf);
        }
    }
}

fn scan_directory_job(
    shared: &Arc<WorkerShared>,
    node_count: &Arc<AtomicUsize>,
    job: &DirJob,
    local_buf: &mut Vec<NodeRecord>,
) {
    if shared.cancel.load(Ordering::Relaxed) {
        return;
    }

    // The directory's own path and depth travel WITH the job (it was recorded by
    // whichever worker discovered it), so there is no shared node buffer to read.
    #[cfg(windows)]
    {
        scan_directory_win32(shared, node_count, job.id, &job.path, job.depth, local_buf);
    }
    #[cfg(not(windows))]
    {
        scan_directory_portable(
            shared,
            node_count,
            job.id,
            &PathBuf::from(&job.path),
            job.depth,
            local_buf,
        );
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
    local_buf: &mut Vec<NodeRecord>,
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

        // A reparse-point directory (junction / directory symlink / mount point)
        // is recorded but NEVER recursed into. Enumerating one with
        // FindFirstFileExW can fail with ERROR_ACCESS_DENIED (error 5): the legacy
        // "My Music" / "My Pictures" / "My Videos" compatibility junctions inside a
        // user's Documents carry deny-read ACLs, so trying to open them surfaces an
        // alarming scan error. Their real targets live under the user profile and
        // are scanned at that canonical location, so skipping the junction also
        // avoids double-counting and reparse-loop cycles. The node still keeps
        // `is_link = true` and the FILE_ATTRIBUTE_REPARSE_POINT bit in `attributes`
        // (so the client can flag it as a junction) and is emitted as a 0-byte
        // directory with no children and no error. Genuinely-inaccessible NON-
        // reparse directories are still queued and still record their real error.
        let is_reparse_dir = is_dir && is_link;
        let needs_queue =
            is_dir && !is_reparse_dir && should_recurse(depth, shared.options.max_depth);
        let at_depth_limit =
            is_dir && !is_reparse_dir && !needs_queue && shared.options.max_depth.is_some();

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

    // Atomically reserve n consecutive global IDs for this directory's children.
    let first_id = node_count.fetch_add(n, Ordering::Relaxed);

    // Assign the reserved IDs. The records then go into this worker's own buffer;
    // `finalize_scan_result` scatters every record to `nodes[id]`, so the global
    // `id == index` contract holds no matter which worker produced the record.
    for (i, node) in local_nodes.iter_mut().enumerate() {
        node.id = first_id + i;
    }

    // Build the sub-directory jobs and depth-limit errors BEFORE moving the
    // records into the buffer (the job carries the child's id/path/depth so the
    // worker that picks it up needs no shared node lookup).
    let mut dirs_to_scan: Vec<DirJob> = Vec::new();
    let mut depth_limit_iter = depth_limit_paths.into_iter();
    for (i, &sentinel) in pending_dir_indices.iter().enumerate() {
        let child = &local_nodes[i];
        let child_id = child.id;
        if sentinel == usize::MAX {
            let path_str = depth_limit_iter.next().unwrap_or_default();
            add_scan_error(shared, child_id, &path_str, "depth limit reached".to_string());
        } else if sentinel != usize::MAX - 1 {
            dirs_to_scan.push(DirJob {
                id: child_id,
                path: child.path.clone(),
                depth: child.depth,
            });
        }
    }

    // Append to the worker-local buffer — no shared node lock. Parent/child links
    // are rebuilt from the `parent` pointers during finalize.
    local_buf.extend(local_nodes);

    if !dirs_to_scan.is_empty() {
        let mut queue = shared.queue.lock().expect("queue lock poisoned");
        for job in dirs_to_scan {
            queue.dirs.push_back(job);
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
    local_buf: &mut Vec<NodeRecord>,
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

        // A symlink / reparse-point directory is recorded but NEVER recursed into,
        // mirroring the Windows fast path: following it can hit an inaccessible or
        // cyclic target (and on Windows the legacy Documents compatibility
        // junctions deny read access entirely), while the real target is scanned at
        // its canonical location. `is_link` comes from the `symlink_metadata` read
        // above, so it stays set even when `follow_links` resolved `metadata`
        // through the link. No recursion, no scan error — just a leaf node.
        let is_reparse_dir = is_dir && is_link;
        let needs_queue =
            is_dir && !is_reparse_dir && should_recurse(depth, shared.options.max_depth);
        let at_depth_limit =
            is_dir && !is_reparse_dir && !needs_queue && shared.options.max_depth.is_some();

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

    // Build sub-directory jobs / depth-limit errors before the buffer move, so
    // each job carries the child id/path/depth (no shared node lookup needed).
    let mut dirs_to_scan: Vec<DirJob> = Vec::new();
    let mut depth_limit_iter = depth_limit_paths.into_iter();
    for (i, &sentinel) in pending_dirs.iter().enumerate() {
        let child = &local_nodes[i];
        let child_id = child.id;
        if sentinel == usize::MAX {
            let path_str = depth_limit_iter.next().unwrap_or_default();
            add_scan_error(shared, child_id, &path_str, "depth limit reached".to_string());
        } else if sentinel != usize::MAX - 1 {
            dirs_to_scan.push(DirJob {
                id: child_id,
                path: child.path.clone(),
                depth: child.depth,
            });
        }
    }

    // Append to the worker-local buffer — no shared node lock. Parent/child links
    // are rebuilt from the `parent` pointers during finalize.
    local_buf.extend(local_nodes);

    if !dirs_to_scan.is_empty() {
        let mut queue = shared.queue.lock().expect("queue lock poisoned");
        for job in dirs_to_scan {
            queue.dirs.push_back(job);
        }
        shared.queue_ready.notify_all();
    }
}

fn add_scan_error(shared: &WorkerShared, node_id: usize, path: &str, message: String) {
    // The node owning this error may live in another worker's buffer, so the
    // per-node `errors` count can't be bumped here. Record `(node_id, error)` and
    // apply the increment in `finalize_scan_result`, where the full buffer exists.
    shared
        .errors
        .lock()
        .expect("errors lock poisoned")
        .push((
            node_id,
            ScanError {
                path: path.to_string(),
                message,
            },
        ));
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
    use crate::model::{DirJob, QueueState, ScanOptions, WorkerShared};

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
    fn finalize_result_has_correct_aggregation() {
        // Root (id 0) lives outside the worker buffers; its two file children were
        // produced by a worker into that worker's own thread-local buffer.
        let root = make_test_node(0, None, true, 0);
        let child_a = make_test_node(1, Some(0), false, 500);
        let child_b = make_test_node(2, Some(0), false, 300);

        let result = finalize_scan_result(
            root,
            vec![vec![child_a, child_b]],
            3,
            Vec::new(),
            1_000_000,
            42,
            1,
        );

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
    fn finalize_scatters_nodes_by_id_regardless_of_buffer_order() {
        // Tree: root(0) ▸ [file(1), dir(2) ▸ file(4), file(3)].
        // The worker buffers are presented OUT OF ID ORDER (the dir-2 worker's
        // buffer, whose node has the highest id, is listed first). finalize must
        // still scatter every record to nodes[id] so the positional `id == index`
        // contract — relied on by every endpoint/serializer — holds exactly.
        let root = make_test_node(0, None, true, 0);
        let n1 = make_test_node(1, Some(0), false, 10);
        let n2 = make_test_node(2, Some(0), true, 0);
        let n3 = make_test_node(3, Some(0), false, 30);
        let mut n4 = make_test_node(4, Some(2), false, 40);
        n4.depth = 2; // grandchild: child of dir 2 (which is at depth 1)

        let result = finalize_scan_result(
            root,
            vec![vec![n4], vec![n1, n2, n3]],
            5,
            Vec::new(),
            1_000_000,
            7,
            2,
        );

        for (idx, node) in result.nodes.iter().enumerate() {
            assert_eq!(node.id, idx, "node at index {idx} must have id == index");
        }
        assert_eq!(result.nodes[2].size, 40, "dir should aggregate its child");
        assert_eq!(result.nodes[0].size, 80, "root should aggregate the whole tree");
        assert_eq!(result.nodes[0].files, 3, "root should count every file");
    }

    #[test]
    fn aggregate_is_order_independent_across_scrambled_id_blocks() {
        // The sharded scan reserves per-worker id BLOCKS from an atomic counter and
        // merges thread-local buffers at finalize, so a parent and its descendants
        // can be assigned ids in any relative order and arrive in any buffer order.
        // This builds a directory chain whose ids deliberately VIOLATE a
        // "parent.id < child.id" assumption — directory A (id 3) owns sub-directory
        // B (id 1), which has a LOWER id than its own parent — and presents the
        // worker buffers out of id order. Aggregation keys on DEPTH, not id order,
        // so every leaf size must still roll up through the whole chain. (An
        // id-order aggregation would compute A from a not-yet-aggregated B and
        // leave directory sizes at 0 — the reported "folders show 0 B" symptom.)
        let mut root = make_test_node(0, None, true, 0);
        let mut a = make_test_node(3, Some(0), true, 0); // depth 1 dir
        let mut b = make_test_node(1, Some(3), true, 0); // depth 2 dir (id 1 < parent id 3)
        let mut f = make_test_node(2, Some(1), false, 500); // depth 3 file
        root.depth = 0;
        a.depth = 1;
        b.depth = 2;
        f.depth = 3;

        // Buffers intentionally out of id order; root (id 0) is supplied separately.
        let result = finalize_scan_result(
            root,
            vec![vec![b, f], vec![a]],
            4,
            Vec::new(),
            1_000_000,
            0,
            2,
        );

        for (idx, node) in result.nodes.iter().enumerate() {
            assert_eq!(node.id, idx, "id == index contract must hold at {idx}");
        }
        assert_eq!(result.nodes[2].size, 500, "leaf file keeps its size");
        assert_eq!(result.nodes[1].size, 500, "dir B aggregates its file child");
        assert_eq!(
            result.nodes[3].size, 500,
            "dir A aggregates dir B even though B.id < A.id"
        );
        assert_eq!(result.nodes[0].size, 500, "root aggregates the whole chain");
        assert_eq!(result.nodes[0].files, 1, "root counts the single leaf file");
        assert_eq!(result.nodes[0].folders, 2, "root counts both sub-directories");
    }

    #[test]
    fn finalize_applies_deferred_node_errors() {
        // Errors are recorded as (node_id, ScanError) during the scan and the
        // per-node count is applied in finalize. A dir-level error should roll up
        // into the root's aggregated error count.
        let root = make_test_node(0, None, true, 0);
        let child = make_test_node(1, Some(0), false, 100);
        let pending = vec![(
            1usize,
            ScanError {
                path: "/test/node_1".to_string(),
                message: "denied".to_string(),
            },
        )];

        let result = finalize_scan_result(root, vec![vec![child]], 2, pending, 1_000_000, 0, 1);

        assert_eq!(result.nodes[1].errors, 1, "deferred error should land on the node");
        assert_eq!(result.nodes[0].errors, 1, "child error should roll up to root");
        assert_eq!(result.errors.len(), 1, "the error message should be retained");
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
            errors: Mutex::new(Vec::new()),
            queue: Mutex::new(QueueState {
                dirs: VecDeque::from(vec![DirJob {
                    id: 0,
                    path: String::new(),
                    depth: 0,
                }]),
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

    // ── Functional, end-to-end scan of a real on-disk tree ──────────────────
    // Builds a temp tree with KNOWN byte sizes, scans it through the real entry
    // point, and proves (a) the live progress counter reaches the true total and
    // (b) every directory's aggregated size equals the sum of its contents —
    // regardless of how the sharded workers ordered their id blocks.
    #[test]
    fn functional_scan_aggregates_sizes_and_counts() {
        use std::fs;
        let base = std::env::temp_dir()
            .join(format!("filetree_func_{}_{}", std::process::id(), now_ms()));
        let sub1 = base.join("sub1");
        let sub2 = sub1.join("sub2");
        fs::create_dir_all(&sub2).unwrap();
        // root/a.txt = 100, sub1/b.txt = 200, sub1/c.txt = 50, sub1/sub2/d.txt = 1000
        fs::write(base.join("a.txt"), vec![b'a'; 100]).unwrap();
        fs::write(sub1.join("b.txt"), vec![b'b'; 200]).unwrap();
        fs::write(sub1.join("c.txt"), vec![b'c'; 50]).unwrap();
        fs::write(sub2.join("d.txt"), vec![b'd'; 1000]).unwrap();

        let options = ScanOptions {
            root: base.clone(),
            include_hidden: true,
            follow_links: false,
            exclude_patterns: Vec::new(),
            max_depth: None,
            threads: 4,
            collect_owners: false,
        };

        // Capture the highest progress count the callback observed.
        let max_progress = Arc::new(AtomicUsize::new(0));
        let mp = Arc::clone(&max_progress);
        let cancel = Arc::new(AtomicBool::new(false));
        let result = scan_path_with_progress(options, cancel, move |count, _elapsed| {
            mp.fetch_max(count, Ordering::Relaxed);
        })
        .expect("scan should succeed");

        let total_nodes = result.nodes.len();
        // root + 2 dirs (sub1, sub2) + 4 files = 7
        assert_eq!(total_nodes, 7, "expected 7 nodes, got {total_nodes}");

        let find = |name: &str| {
            result
                .nodes
                .iter()
                .find(|n| n.is_dir && n.name == name)
                .unwrap_or_else(|| panic!("dir {name} should be present"))
        };

        let root = &result.nodes[0];
        assert_eq!(root.size, 1350, "root size must equal sum of every file");
        assert_eq!(root.files, 4, "root must count all 4 files");
        assert_eq!(find("sub1").size, 1250, "sub1 = b(200)+c(50)+sub2(1000)");
        assert_eq!(find("sub2").size, 1000, "sub2 = d(1000)");

        // The live counter must have reached the true total (not stuck at 0).
        let seen = max_progress.load(Ordering::Relaxed);
        assert!(seen > 0, "progress counter must increment above 0 (was {seen})");
        assert_eq!(seen, total_nodes, "progress counter must reach the node total");

        let _ = fs::remove_dir_all(&base);
    }

    // ── Reparse-point (junction) directories are skipped, not errored ───────
    // Recreates the reported bug: a directory junction (like the legacy
    // "My Music"/"My Pictures"/"My Videos" compatibility junctions inside
    // Documents) must be listed as a 0-byte leaf flagged as a link — never
    // recursed into and never recorded as a "FindFirstFileExW failed" error.
    // Uses `mklink /J`, which (unlike `/D` symlinks) needs no admin rights; if
    // the environment forbids junction creation the test no-ops instead of
    // failing. The junction here points to a READABLE target, so without the fix
    // it would be enumerated and its 1000-byte child double-counted under the
    // junction — asserting the junction's aggregated size is 0 proves it was
    // treated as a non-recursed leaf.
    #[cfg(windows)]
    #[test]
    fn scan_skips_reparse_point_directory_without_error() {
        use std::fs;
        use std::process::Command;

        let base = std::env::temp_dir()
            .join(format!("filetree_junction_{}_{}", std::process::id(), now_ms()));
        let target = base.join("target");
        fs::create_dir_all(&target).expect("create target dir");
        fs::write(target.join("data.bin"), vec![b'x'; 1000]).expect("write target file");

        let link = base.join("link");
        let status = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&target)
            .status();

        // Skip gracefully if junction creation is not permitted here.
        let created = matches!(status, Ok(s) if s.success()) && link.exists();
        if !created {
            let _ = fs::remove_dir_all(&base);
            return;
        }

        let options = ScanOptions {
            root: base.clone(),
            include_hidden: true,
            follow_links: false,
            exclude_patterns: Vec::new(),
            max_depth: None,
            threads: 2,
            collect_owners: false,
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let result = scan_path_with_progress(options, cancel, |_, _| {})
            .expect("scan should succeed");

        let junction = result
            .nodes
            .iter()
            .find(|n| n.name == "link")
            .expect("junction node should be present in the scan");
        assert!(junction.is_link, "junction must be flagged is_link");
        assert!(junction.is_dir, "a directory junction keeps FILE_ATTRIBUTE_DIRECTORY");
        assert_eq!(
            junction.size, 0,
            "reparse-point dir must not be recursed (size would be 1000 if it were)"
        );
        assert_eq!(junction.errors, 0, "skipping a junction must not record an error");

        // The hard requirement: NO FindFirstFileExW error for the junction.
        assert!(
            !result
                .errors
                .iter()
                .any(|e| e.message.contains("FindFirstFileExW")),
            "scanning a reparse-point dir must produce no FindFirstFileExW error, got: {:?}",
            result.errors
        );

        // The real target is still scanned at its canonical location (counted once).
        let target_dir = result
            .nodes
            .iter()
            .find(|n| n.is_dir && n.name == "target")
            .expect("target dir should be scanned");
        assert_eq!(target_dir.size, 1000, "the real target is scanned normally");

        let _ = fs::remove_dir_all(&base);
    }
}
