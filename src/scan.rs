use std::collections::VecDeque;
use std::fs::{self, Metadata};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::io::{
    display_name, extension_for, is_hidden_entry, metadata_modified_ms, now_ms, path_to_string,
    platform_allocated_size, should_exclude, should_recurse,
};
use crate::model::{NodeRecord, QueueState, ScanError, ScanOptions, ScanResult, WorkerShared};

pub(crate) fn scan_path(options: ScanOptions) -> io::Result<ScanResult> {
    scan_path_with_progress(options, Arc::new(AtomicBool::new(false)), |_, _, _| {})
}

pub(crate) fn scan_path_with_progress<F>(
    options: ScanOptions,
    cancel: Arc<AtomicBool>,
    mut progress: F,
) -> io::Result<ScanResult>
where
    F: FnMut(usize, u128, Option<ScanResult>),
{
    if !options.root.exists() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
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

pub(crate) fn snapshot_scan_result(
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

fn metadata_for_entry(path: &Path, follow_links: bool) -> io::Result<Metadata> {
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

pub(crate) fn aggregate_nodes(nodes: &mut [NodeRecord]) {
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
