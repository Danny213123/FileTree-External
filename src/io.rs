use std::env;
use std::fs::Metadata;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::{Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

/// Poison-tolerant locking for the process-wide `Mutex`es that several worker
/// threads share (compression pool, gates). If one worker panics while holding a
/// lock the `Mutex` becomes poisoned; a plain `.lock().unwrap()`/`.expect()` on
/// every *other* worker would then panic too, cascading one failure into the
/// whole pool dying. Recovering the inner guard instead (the data is just
/// bookkeeping/bytes, never left in a torn state across a panic here) keeps a
/// single failing file from taking the batch down with it.
pub(crate) trait LockRecover<T> {
    fn lock_recover(&self) -> std::sync::MutexGuard<'_, T>;
}

impl<T> LockRecover<T> for Mutex<T> {
    fn lock_recover(&self) -> std::sync::MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub(crate) fn reveal_path(path: &str) -> io::Result<()> {
    #[cfg(windows)]
    {
        Command::new("explorer.exe")
            .arg(format!("/select,{path}"))
            .spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg("-R").arg(path).spawn()?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let target = Path::new(path).parent().unwrap_or_else(|| Path::new(path));
        Command::new("xdg-open").arg(target).spawn()?;
    }
    Ok(())
}

pub(crate) fn open_path(path: &str) -> io::Result<()> {
    #[cfg(windows)]
    {
        // ShellExecuteW with "open" verb launches the registered default handler
        // for any file type or folder. explorer.exe alone opens Explorer for
        // files instead of their associated app.
        let path_w: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
        let verb_w: Vec<u16> = "open\0".encode_utf16().collect();
        #[link(name = "Shell32")]
        unsafe extern "system" {
            fn ShellExecuteW(
                hwnd: isize, op: *const u16, file: *const u16,
                params: *const u16, dir: *const u16, show: i32,
            ) -> isize;
        }
        unsafe {
            ShellExecuteW(
                0, verb_w.as_ptr(), path_w.as_ptr(),
                std::ptr::null(), std::ptr::null(),
                1, // SW_SHOWNORMAL
            );
        }
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(path).spawn()?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open").arg(path).spawn()?;
    }
    Ok(())
}

pub(crate) fn display_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| path.display().to_string())
}

pub(crate) fn path_to_string(path: &Path) -> String {
    path.display().to_string()
}


pub(crate) fn metadata_modified_ms(metadata: &Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn current_dir_or_dot() -> PathBuf {
    env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

pub(crate) fn default_thread_count() -> usize {
    thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(4)
        .clamp(2, 32)
}

// ──────────────────────────────────────────────────────────────────
// Global scan-thread budget
//
// Each full-tree scan spawns ~`default_thread_count()` workers. Without a gate,
// K simultaneous scans (e.g. several tabs refreshing, or a tree scan racing a
// duplicate scan) would spawn K×threads and oversubscribe the CPU, so every scan
// runs slower. This counting gate caps the TOTAL number of live scan workers at
// the logical-core count: a lone scan still gets all of its requested threads,
// but concurrent scans share the pool and briefly queue for permits instead of
// thrashing. It is a soft pool (no threads are pre-spawned) — just an admission
// budget acquired up front and released (RAII) once a scan's workers have joined.
// ──────────────────────────────────────────────────────────────────

fn scan_thread_budget() -> usize {
    thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(4)
        .clamp(2, 64)
}

struct ScanGate {
    available: Mutex<usize>,
    ready: Condvar,
}

fn scan_gate() -> &'static ScanGate {
    static GATE: OnceLock<ScanGate> = OnceLock::new();
    GATE.get_or_init(|| ScanGate {
        available: Mutex::new(scan_thread_budget()),
        ready: Condvar::new(),
    })
}

/// RAII permit that returns its reserved thread slots to the global scan budget
/// when dropped. Hold it for the lifetime of a scan's worker threads.
pub(crate) struct ScanThreadPermit {
    count: usize,
}

impl ScanThreadPermit {
    /// Worker-thread count this scan is cleared to spawn (its clamped request —
    /// never more than the whole budget).
    pub(crate) fn threads(&self) -> usize {
        self.count
    }
}

impl Drop for ScanThreadPermit {
    fn drop(&mut self) {
        let gate = scan_gate();
        let mut available = gate.available.lock_recover();
        *available += self.count;
        // A waiting scan may now have enough slots, so wake all and let each
        // re-check its own `want` under the lock.
        gate.ready.notify_all();
    }
}

/// Reserve up to `requested` worker-thread slots from the global scan budget,
/// blocking until that many are free. A single scan never needs more than the
/// whole budget (the request is clamped to it), so the all-or-nothing reservation
/// cannot deadlock: every scan acquires exactly once, up front, and releases on
/// drop, so the budget is always eventually replenished.
pub(crate) fn acquire_scan_threads(requested: usize) -> ScanThreadPermit {
    let want = requested.clamp(1, scan_thread_budget());
    let gate = scan_gate();
    let mut available = gate.available.lock_recover();
    while *available < want {
        available = gate.ready.wait(available).unwrap_or_else(|e| e.into_inner());
    }
    *available -= want;
    ScanThreadPermit { count: want }
}

// ──────────────────────────────────────────────────────────────────
// Global compression budget (CompressGate)
//
// Mirrors `ScanGate` above, but for the compression pipeline. Within a single
// job, multiple files now encode in parallel (a bounded worker pool); across
// jobs there is no other coordination, so without a global cap N simultaneous
// jobs would each spawn their own pool and oversubscribe the CPU/GPU. This gate
// is a process-wide admission budget split into workload LANES so a queue of
// heavy videos can't starve quick image/zip work. NVENC gets two slots so GPUs
// with dual encoder engines can use both, while other hardware encoders retain
// a conservative single-session lane. Each lane is a counting semaphore; a
// permit is acquired up front for one file's encode and released (RAII) when
// that file finishes.
// ──────────────────────────────────────────────────────────────────

/// Workload lane a compression file runs in. The caps differ because the
/// resources differ: CPU video encodes are heavy (x264 already multi-threads),
/// GPU encodes are session-capped by the driver, and image/zip work is light /
/// I/O bound.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CompressLane {
    /// CPU video encode (x264 / x265 software).
    VideoCpu,
    /// NVIDIA NVENC. Modern NVIDIA GPUs may expose two encoder engines.
    Nvenc,
    /// Intel QSV / AMD AMF. Kept to one session for driver stability.
    GpuOther,
    /// Image re-encode (ffmpeg / ImageMagick).
    Image,
    /// Built-in zip / archive (I/O bound).
    Zip,
}

struct CompressGate {
    state: Mutex<GateInner>,
    ready: Condvar,
}

#[derive(Debug)]
struct GateInner {
    video_cpu: usize,
    nvenc: usize,
    gpu_other: usize,
    image: usize,
    zip: usize,
}

/// Per-lane caps derived from the logical core count. A lone job still gets
/// healthy parallelism; concurrent jobs share these budgets and briefly queue
/// for permits rather than thrashing.
fn compress_lane_caps() -> GateInner {
    let cores = thread::available_parallelism()
        .map(|c| c.get())
        .unwrap_or(4);
    GateInner {
        // A HandBrake software encode already fans out across several threads.
        // Keep one in flight so a GPU failure cannot create a burst of parallel
        // CPU fallbacks that starves the desktop or exhausts memory.
        video_cpu: 1,
        // A dual-engine NVIDIA GPU needs two independent encode sessions to use
        // both engines; Task Manager otherwise plateaus around 50% Video Encode.
        // The process-wide gate still prevents unbounded HandBrake fan-out.
        nvenc: 2,
        // Retain the conservative limit for QSV/AMF, where the available engine
        // count and driver behavior vary more widely across supported hardware.
        gpu_other: 1,
        // Image encodes are short; allow one per core.
        image: cores.clamp(2, 32),
        // Zip is I/O bound; a handful keeps the disk busy without thrashing.
        zip: (cores / 2).clamp(2, 16),
    }
}

fn compress_gate() -> &'static CompressGate {
    static GATE: OnceLock<CompressGate> = OnceLock::new();
    GATE.get_or_init(|| CompressGate {
        state: Mutex::new(compress_lane_caps()),
        ready: Condvar::new(),
    })
}

/// RAII permit for one in-flight encode in a given lane. Returns its slot to the
/// global budget on drop, waking a queued worker.
pub(crate) struct CompressPermit {
    lane: CompressLane,
}

impl Drop for CompressPermit {
    fn drop(&mut self) {
        let gate = compress_gate();
        let mut s = gate.state.lock_recover();
        match self.lane {
            CompressLane::VideoCpu => s.video_cpu += 1,
            CompressLane::Nvenc => s.nvenc += 1,
            CompressLane::GpuOther => s.gpu_other += 1,
            CompressLane::Image => s.image += 1,
            CompressLane::Zip => s.zip += 1,
        }
        gate.ready.notify_all();
    }
}

fn lane_slot(s: &mut GateInner, lane: CompressLane) -> &mut usize {
    match lane {
        CompressLane::VideoCpu => &mut s.video_cpu,
        CompressLane::Nvenc => &mut s.nvenc,
        CompressLane::GpuOther => &mut s.gpu_other,
        CompressLane::Image => &mut s.image,
        CompressLane::Zip => &mut s.zip,
    }
}

/// Acquire one permit in `lane`, blocking until a slot is free. The cancel flag
/// lets a queued worker give up promptly when its job is cancelled: it returns
/// `None` without consuming a slot.
pub(crate) fn acquire_compress(
    lane: CompressLane,
    cancel: &std::sync::atomic::AtomicBool,
) -> Option<CompressPermit> {
    let gate = compress_gate();
    let mut s = gate.state.lock_recover();
    loop {
        if cancel.load(Ordering::SeqCst) {
            return None;
        }
        if *lane_slot(&mut s, lane) > 0 {
            *lane_slot(&mut s, lane) -= 1;
            return Some(CompressPermit { lane });
        }
        // Wait with a timeout so the cancel flag is re-checked periodically.
        let (g, _to) = gate
            .ready
            .wait_timeout(s, std::time::Duration::from_millis(200))
            .unwrap_or_else(|e| e.into_inner());
        s = g;
    }
}

pub(crate) fn option_value(args: &[String], name: &str) -> Option<String> {
    args.windows(2)
        .find(|window| window[0] == name)
        .map(|window| window[1].clone())
        .or_else(|| {
            let prefix = format!("{name}=");
            args.iter()
                .find_map(|arg| arg.strip_prefix(&prefix).map(str::to_string))
        })
}

pub(crate) fn has_flag(args: &[String], name: &str) -> bool {
    args.iter().any(|arg| arg == name)
}

pub(crate) fn first_positional_arg(args: &[String]) -> Option<String> {
    let mut skip_next = false;
    for arg in args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if arg.starts_with("--") {
            if !arg.contains('=') {
                skip_next = true;
            }
            continue;
        }
        return Some(arg.clone());
    }
    None
}

pub(crate) fn parse_bool(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

pub(crate) fn split_patterns(value: &str) -> Vec<String> {
    value
        .split([';', ','])
        .map(str::trim)
        .filter(|pattern| !pattern.is_empty())
        .map(str::to_string)
        .collect()
}

pub(crate) fn should_recurse(depth: usize, max_depth: Option<usize>) -> bool {
    max_depth.map(|max_depth| depth < max_depth).unwrap_or(true)
}

pub(crate) fn should_exclude(patterns: &[String], name: &str, path: &str) -> bool {
    patterns.iter().any(|pattern| {
        pattern_matches(pattern, name)
            || pattern_matches(pattern, path)
            || pattern_matches(pattern, &path.replace('\\', "/"))
    })
}

fn pattern_matches(pattern: &str, value: &str) -> bool {
    let pattern = pattern.to_ascii_lowercase();
    let value = value.to_ascii_lowercase();
    if pattern.contains('*') || pattern.contains('?') {
        wildcard_match(&pattern, &value)
    } else {
        value.contains(&pattern)
    }
}

pub(crate) fn wildcard_match(pattern: &str, value: &str) -> bool {
    let pattern = pattern.as_bytes();
    let value = value.as_bytes();
    let mut pattern_index = 0usize;
    let mut value_index = 0usize;
    let mut star_index = None;
    let mut match_index = 0usize;

    while value_index < value.len() {
        if pattern_index < pattern.len()
            && (pattern[pattern_index] == b'?' || pattern[pattern_index] == value[value_index])
        {
            pattern_index += 1;
            value_index += 1;
        } else if pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
            star_index = Some(pattern_index);
            match_index = value_index;
            pattern_index += 1;
        } else if let Some(star) = star_index {
            pattern_index = star + 1;
            match_index += 1;
            value_index = match_index;
        } else {
            return false;
        }
    }

    while pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
        pattern_index += 1;
    }

    pattern_index == pattern.len()
}

#[cfg(windows)]
pub(crate) fn is_hidden_entry(path: &Path, metadata: &Metadata) -> bool {
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    metadata.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
        || path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with('.'))
            .unwrap_or(false)
}

#[cfg(not(windows))]
pub(crate) fn is_hidden_entry(path: &Path, _metadata: &Metadata) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with('.'))
        .unwrap_or(false)
}

/// Compressed-aware allocated size. On Windows, always calls GetCompressedFileSizeW
/// (use only when you don't know whether FILE_ATTRIBUTE_COMPRESSED is set).
#[cfg(windows)]
pub(crate) fn platform_allocated_size(path: &Path, metadata: &Metadata) -> u64 {
    windows_compressed_file_size(path).unwrap_or(metadata.len())
}

#[cfg(not(windows))]
pub(crate) fn platform_allocated_size(_path: &Path, metadata: &Metadata) -> u64 {
    metadata.len()
}

/// Raw allocated size given a known logical size — calls GetCompressedFileSizeW
/// only when needed (caller has already checked FILE_ATTRIBUTE_COMPRESSED).
/// On non-Windows, logical size == allocated size.
#[cfg(windows)]
pub(crate) fn platform_allocated_size_raw(path: &Path, logical_size: u64) -> u64 {
    windows_compressed_file_size(path).unwrap_or(logical_size)
}

#[cfg(not(windows))]
pub(crate) fn platform_allocated_size_raw(_path: &Path, logical_size: u64) -> u64 {
    logical_size
}

#[cfg(windows)]
fn windows_compressed_file_size(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn GetCompressedFileSizeW(lpFileName: *const u16, lpFileSizeHigh: *mut u32) -> u32;
        fn GetLastError() -> u32;
    }

    const INVALID_FILE_SIZE: u32 = 0xFFFF_FFFF;
    const NO_ERROR: u32 = 0;

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut high = 0u32;
    let low = unsafe { GetCompressedFileSizeW(wide.as_ptr(), &mut high) };
    if low == INVALID_FILE_SIZE {
        let error = unsafe { GetLastError() };
        if error != NO_ERROR {
            return None;
        }
    }
    Some(((high as u64) << 32) | low as u64)
}

pub(crate) fn epoch_ms_to_utc(ms: u64) -> String {
    if ms == 0 {
        return String::new();
    }
    let seconds = (ms / 1000) as i64;
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3600;
    let minute = (seconds_of_day % 3600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02} UTC")
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let days = days_since_epoch + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

#[cfg(windows)]
pub(crate) fn wide(value: &str) -> Vec<u16> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wildcard_supports_star_and_question() {
        assert!(wildcard_match("*.rs", "main.rs"));
        assert!(wildcard_match("file?.txt", "file1.txt"));
        assert!(!wildcard_match("file?.txt", "file10.txt"));
    }

    #[test]
    fn epoch_formats_unix_start() {
        assert_eq!(epoch_ms_to_utc(1_000), "1970-01-01 00:00:01 UTC");
    }

    #[test]
    fn compression_video_lanes_use_both_nvenc_engines_safely() {
        let caps = compress_lane_caps();
        assert_eq!(caps.video_cpu, 1);
        assert_eq!(caps.nvenc, 2);
        assert_eq!(caps.gpu_other, 1);
    }

    #[cfg(windows)]
    #[test]
    fn wide_ascii_has_nul_terminator() {
        let result = wide("C:\\Users");
        assert_eq!(*result.last().unwrap(), 0u16);
        let without_nul: Vec<u16> = result.into_iter().take_while(|&c| c != 0).collect();
        let decoded = String::from_utf16_lossy(&without_nul);
        assert_eq!(decoded, "C:\\Users");
    }

    #[cfg(windows)]
    #[test]
    fn wide_empty_is_just_nul() {
        let result = wide("");
        assert_eq!(result, vec![0u16]);
    }

    #[cfg(windows)]
    #[test]
    fn wide_unicode_round_trips() {
        let result = wide("caf\u{00e9}");
        assert_eq!(*result.last().unwrap(), 0u16);
        let without_nul: Vec<u16> = result.into_iter().take_while(|&c| c != 0).collect();
        let decoded = String::from_utf16_lossy(&without_nul);
        assert_eq!(decoded, "caf\u{00e9}");
    }
}
