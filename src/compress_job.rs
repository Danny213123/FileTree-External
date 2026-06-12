//! Background compression jobs: registry types, the per-job worker thread, the
//! encode pipelines (HandBrake / image tool / zip), live NDJSON event buffer,
//! and manifest persistence for resume.
//!
//! A job never runs on an HTTP connection thread (encodes take minutes); the
//! create endpoint spawns a dedicated [`std::thread`] via [`spawn_job`] and
//! returns immediately. Per-file progress and lifecycle events are appended to
//! an in-memory ring ([`CompressJob::events`]) that the stream endpoint replays
//! from the start and then tails live (so a stream opened slightly late still
//! sees the whole history). After every file the job rewrites its manifest under
//! `%APPDATA%\FileTree\jobs\<id>.json`, which `retry` reloads to skip files
//! already `done`.

use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

use crate::compress_tools::{self, ImageKind};
use crate::export::push_json_string;
use crate::model::AppState;

/// Coarse file classification that selects a pipeline.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FileKind {
    Video,
    Image,
    Other,
}

impl FileKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            FileKind::Video => "video",
            FileKind::Image => "image",
            FileKind::Other => "other",
        }
    }

    fn from_str(s: &str) -> FileKind {
        match s {
            "video" => FileKind::Video,
            "image" => FileKind::Image,
            _ => FileKind::Other,
        }
    }
}

/// Classify a path by extension. Audio is folded into the video pipeline (it is
/// re-encoded by the same HandBrake/ffmpeg tooling).
pub(crate) fn classify(path: &Path) -> FileKind {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "mp4" | "mkv" | "mov" | "avi" | "wmv" | "flv" | "webm" | "m4v" | "mpg" | "mpeg"
        | "mp3" | "wav" | "flac" | "aac" | "ogg" | "m4a" => FileKind::Video,
        "jpg" | "jpeg" | "png" | "webp" | "bmp" | "tiff" | "tif" | "gif" => FileKind::Image,
        _ => FileKind::Other,
    }
}

/// Per-file mutable state. Counters are atomics so the stream/poll endpoints can
/// read them without taking the job lock; `status`, `out_path` and `error` are
/// behind small mutexes.
#[derive(Debug)]
pub(crate) struct FileState {
    pub(crate) index: usize,
    pub(crate) path: String,
    pub(crate) kind: FileKind,
    /// "pending" | "running" | "done" | "error" | "skipped"
    pub(crate) status: Mutex<String>,
    pub(crate) pct: AtomicU64,
    pub(crate) orig_bytes: AtomicU64,
    pub(crate) new_bytes: AtomicU64,
    pub(crate) recycled: AtomicBool,
    pub(crate) out_path: Mutex<String>,
    pub(crate) error: Mutex<Option<String>>,
}

impl FileState {
    fn new(index: usize, path: String, kind: FileKind, orig: u64, status: &str) -> FileState {
        FileState {
            index,
            path,
            kind,
            status: Mutex::new(status.to_string()),
            pct: AtomicU64::new(if status == "done" { 100 } else { 0 }),
            orig_bytes: AtomicU64::new(orig),
            new_bytes: AtomicU64::new(0),
            recycled: AtomicBool::new(false),
            out_path: Mutex::new(String::new()),
            error: Mutex::new(None),
        }
    }
}

/// A compression job: its file list, cancel flag, the handle of the currently
/// running child (so cancel can kill it), the live event buffer, and the bits
/// needed to persist/replay a manifest.
#[derive(Debug)]
pub(crate) struct CompressJob {
    pub(crate) id: String,
    pub(crate) preset: String,
    pub(crate) recycle_originals: bool,
    pub(crate) tag_filename: bool,
    /// "running" | "done" | "cancelled" | "error"
    pub(crate) status: Mutex<String>,
    pub(crate) total: usize,
    pub(crate) files: Vec<FileState>,
    pub(crate) saved_bytes: AtomicU64,
    pub(crate) cancel: Arc<AtomicBool>,
    /// Handle of the encoder child for the file currently being processed, so
    /// `cancel` can `kill()` it. `None` between files / for the zip pipeline.
    pub(crate) child: Mutex<Option<Child>>,
    /// Live NDJSON event lines. The stream endpoint replays from index 0 then
    /// tails new lines; `finished` + the condvar wake any tailing reader.
    pub(crate) events: Mutex<Vec<String>>,
    pub(crate) events_cv: Condvar,
    pub(crate) finished: AtomicBool,
    pub(crate) manifest_path: PathBuf,
}

impl CompressJob {
    /// Append one NDJSON event line and wake any stream reader tailing the buffer.
    fn emit(&self, line: String) {
        let mut events = self.events.lock().expect("compress events lock");
        events.push(line);
        self.events_cv.notify_all();
    }
}

/// `%APPDATA%\FileTree\jobs\` — where per-job manifests live.
fn jobs_dir() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("FileTree")
            .join("jobs")
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".config")
            .join("filetree")
            .join("jobs")
    }
}

/// Job ids are `<unixMs>-<counter>`; the counter disambiguates two jobs created
/// in the same millisecond. Only `[0-9a-f-]`, so it is always a safe filename.
pub(crate) fn new_job_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed) & 0xffff;
    format!("{}-{:04x}", crate::io::now_ms(), n)
}

/// Guard the externally-supplied id used to build a manifest path / registry
/// key against traversal: only the characters `new_job_id` emits are allowed.
pub(crate) fn is_safe_job_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Build a fresh job from a create request. Each file is classified and sized
/// (best-effort `metadata`) up front so `file_start` events carry `origBytes`.
pub(crate) fn create_job(
    paths: &[String],
    preset: &str,
    recycle_originals: bool,
    tag_filename: bool,
) -> Arc<CompressJob> {
    let id = new_job_id();
    let files: Vec<FileState> = paths
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let path = Path::new(p);
            let kind = classify(path);
            let orig = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            FileState::new(i, p.clone(), kind, orig, "pending")
        })
        .collect();
    let total = files.len();
    Arc::new(CompressJob {
        id: id.clone(),
        preset: normalize_preset(preset),
        recycle_originals,
        tag_filename,
        status: Mutex::new("running".to_string()),
        total,
        files,
        saved_bytes: AtomicU64::new(0),
        cancel: Arc::new(AtomicBool::new(false)),
        child: Mutex::new(None),
        events: Mutex::new(Vec::new()),
        events_cv: Condvar::new(),
        finished: AtomicBool::new(false),
        manifest_path: jobs_dir().join(format!("{id}.json")),
    })
}

/// Rebuild a job from its persisted manifest for `retry`: files already `done`
/// keep their `done` status (and recorded sizes) and are skipped by the worker;
/// everything else is reset to `pending`.
pub(crate) fn job_from_manifest(id: &str) -> Option<Arc<CompressJob>> {
    if !is_safe_job_id(id) {
        return None;
    }
    let manifest_path = jobs_dir().join(format!("{id}.json"));
    let text = std::fs::read_to_string(&manifest_path).ok()?;
    let root = crate::json::parse(&text)?;

    let preset = root.get("preset").and_then(|v| v.as_str()).unwrap_or("balanced");
    let recycle_originals = root
        .get("recycleOriginals")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let tag_filename = root.get("tagFilename").and_then(|v| v.as_bool()).unwrap_or(true);
    let files_arr = root.get("files").and_then(|v| v.as_array())?;

    let mut files = Vec::with_capacity(files_arr.len());
    let mut carried_saved = 0u64;
    for (i, f) in files_arr.iter().enumerate() {
        let path = f.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let kind = FileKind::from_str(f.get("kind").and_then(|v| v.as_str()).unwrap_or("other"));
        let orig = f.get("origBytes").and_then(|v| v.as_u64()).unwrap_or(0);
        let prev_status = f.get("status").and_then(|v| v.as_str()).unwrap_or("pending");
        // Only a genuine completed compress is preserved; skipped/error/pending
        // all re-run.
        let resume_done = prev_status == "done";
        let state = FileState::new(i, path, kind, orig, if resume_done { "done" } else { "pending" });
        if resume_done {
            let newb = f.get("newBytes").and_then(|v| v.as_u64()).unwrap_or(0);
            state.new_bytes.store(newb, Ordering::Relaxed);
            state.recycled.store(
                f.get("recycled").and_then(|v| v.as_bool()).unwrap_or(false),
                Ordering::Relaxed,
            );
            if let Some(op) = f.get("outPath").and_then(|v| v.as_str()) {
                *state.out_path.lock().expect("out_path lock") = op.to_string();
            }
            carried_saved = carried_saved.saturating_add(orig.saturating_sub(newb));
        }
        files.push(state);
    }
    let total = files.len();

    Some(Arc::new(CompressJob {
        id: id.to_string(),
        preset: normalize_preset(preset),
        recycle_originals,
        tag_filename,
        status: Mutex::new("running".to_string()),
        total,
        files,
        saved_bytes: AtomicU64::new(carried_saved),
        cancel: Arc::new(AtomicBool::new(false)),
        child: Mutex::new(None),
        events: Mutex::new(Vec::new()),
        events_cv: Condvar::new(),
        finished: AtomicBool::new(false),
        manifest_path,
    }))
}

fn normalize_preset(p: &str) -> String {
    match p {
        "max" | "balanced" | "high" => p.to_string(),
        _ => "balanced".to_string(),
    }
}

/// The encoder + a human-readable codec parameter string for one file, derived
/// from its kind, the job preset and which image encoder was detected. Mirrors
/// the actual quality/scale knobs the `run_*` pipelines pass to each tool so the
/// CSV log records exactly how a file was (or would have been) encoded.
fn pipeline_params(
    kind: FileKind,
    preset: &str,
    img_kind: Option<ImageKind>,
) -> (&'static str, String) {
    match kind {
        FileKind::Video => {
            let (q, h) = match preset {
                "max" => ("30", Some("480")),
                "high" => ("20", None),
                _ => ("24", Some("1080")),
            };
            let mut s = format!("x264 rf={q}");
            if let Some(h) = h {
                s.push_str(&format!(" maxHeight={h}"));
            }
            ("handbrake", s)
        }
        FileKind::Image => match img_kind {
            Some(ImageKind::Ffmpeg) => {
                let (q, scale) = match preset {
                    "max" => ("12", Some("1280")),
                    "high" => ("3", None),
                    _ => ("6", Some("1920")),
                };
                let mut s = format!("q:v={q}");
                if let Some(edge) = scale {
                    s.push_str(&format!(" scale={edge}"));
                }
                ("ffmpeg", s)
            }
            Some(ImageKind::ImageMagick) => {
                let (q, resize) = match preset {
                    "max" => ("60", Some("1280000@")),
                    "high" => ("92", None),
                    _ => ("80", Some("3686400@")),
                };
                let mut s = format!("quality={q}");
                if let Some(area) = resize {
                    s.push_str(&format!(" resize={area}"));
                }
                ("imagemagick", s)
            }
            None => ("", String::new()),
        },
        FileKind::Other => ("zip", "deflate".to_string()),
    }
}

/// Last path component (file name) for the CSV `name` column.
fn file_name_of(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// Percentage of the original size saved (0 when the original size is unknown).
fn pct_saved(orig: u64, new_bytes: u64) -> f64 {
    if orig == 0 {
        return 0.0;
    }
    (orig.saturating_sub(new_bytes) as f64 / orig as f64) * 100.0
}

/// New/original size ratio (0 when the original size is unknown).
fn ratio(orig: u64, new_bytes: u64) -> f64 {
    if orig == 0 {
        return 0.0;
    }
    new_bytes as f64 / orig as f64
}

// ── Worker thread ──────────────────────────────────────────────────────────

/// Spawn the dedicated worker thread for `job`. Returns immediately; the encode
/// runs entirely off the HTTP connection thread.
pub(crate) fn spawn_job(state: Arc<AppState>, job: Arc<CompressJob>) {
    std::thread::spawn(move || run_job(state, job));
}

fn run_job(state: Arc<AppState>, job: Arc<CompressJob>) {
    job.emit(ev_job_start(&job.id, job.total));

    let hb = compress_tools::detect_handbrake();
    let (img, img_kind) = compress_tools::detect_image();

    // Job-start diagnostics: preset, options, file count and which encoders were
    // detected (path + version) so a "tool missing" outcome later is unambiguous.
    if crate::compress_debug::enabled() {
        let mut l = format!(
            "[job_start] job={} preset={} recycle={} tag={} files={}",
            job.id, job.preset, job.recycle_originals, job.tag_filename, job.total
        );
        l.push_str(&format!(" handbrake={}", tool_desc(&hb)));
        l.push_str(&format!(" image={}", tool_desc(&img)));
        if let Some(k) = img_kind {
            l.push_str(&format!(" imageKind={}", k.as_str()));
        }
        l.push_str(" zip=built-in");
        crate::compress_debug::log(&l);
    }

    let mut done_count = 0usize;
    let mut error_count = 0usize;
    let mut skipped_count = 0usize;

    for i in 0..job.files.len() {
        if job.cancel.load(Ordering::SeqCst) {
            break;
        }
        // Resume: files already completed in a prior run keep their result and
        // are not re-encoded.
        if job.files[i].status.lock().expect("status lock").as_str() == "done" {
            done_count += 1;
            continue;
        }

        {
            let f = &job.files[i];
            *f.status.lock().expect("status lock") = "running".to_string();
            f.pct.store(0, Ordering::Relaxed);
            let orig = f.orig_bytes.load(Ordering::Relaxed);
            job.emit(ev_file_start(i, &f.path, f.kind, orig));
        }

        // Time the whole per-file pipeline so the CSV log can record duration_ms.
        let file_start = Instant::now();
        let outcome = process_file(&state, &job, i, &hb, &img, img_kind);
        let duration_ms = file_start.elapsed().as_millis() as u64;
        let f = &job.files[i];
        let orig = f.orig_bytes.load(Ordering::Relaxed);
        // The tool + codec params are fully determined by the file kind, the
        // chosen preset and which image encoder was detected — compute them here
        // so every outcome arm (including errors) logs consistently.
        let (tool, codec_params) = pipeline_params(f.kind, &job.preset, img_kind);
        let name = file_name_of(&f.path);
        let kind_str = f.kind.as_str();
        // The detected version string of whichever tool this file's kind uses,
        // recorded in the CSV so the exact encoder build is captured.
        let tool_version = match f.kind {
            FileKind::Video => hb.version.as_deref().unwrap_or(""),
            FileKind::Image => img.version.as_deref().unwrap_or(""),
            FileKind::Other => "built-in",
        };
        match outcome {
            FileOutcome::Done { out_path, new_bytes, recycled, recycle_error, tagged, diag } => {
                f.new_bytes.store(new_bytes, Ordering::Relaxed);
                f.recycled.store(recycled, Ordering::Relaxed);
                *f.out_path.lock().expect("out lock") = out_path.clone();
                *f.status.lock().expect("status lock") = "done".to_string();
                f.pct.store(100, Ordering::Relaxed);
                let saved = orig.saturating_sub(new_bytes);
                job.saved_bytes.fetch_add(saved, Ordering::Relaxed);
                done_count += 1;
                crate::compress_log::append_row(&crate::compress_log::Row {
                    job_id: &job.id,
                    index: i,
                    path: &f.path,
                    name: &name,
                    kind: kind_str,
                    preset: &job.preset,
                    status: "success",
                    orig_bytes: orig,
                    new_bytes,
                    saved_bytes: saved,
                    pct_saved: pct_saved(orig, new_bytes),
                    ratio: ratio(orig, new_bytes),
                    tool,
                    codec_params: &codec_params,
                    duration_ms,
                    out_path: &out_path,
                    recycled,
                    error: "",
                    reason: Reason::Success.as_str(),
                    exit_code: diag.exit_code,
                    tool_version,
                    command: &diag.command,
                    stderr_excerpt: &diag.stderr_tail,
                });
                log_file_debug(
                    &job.id, i, &f.path, kind_str, orig, tool, &diag, &out_path, new_bytes,
                    "compressed", Reason::Success.as_str(), duration_ms, recycled,
                    recycle_error.as_deref(), Some(tagged),
                );
                job.emit(ev_file_done(i, &out_path, orig, new_bytes, saved, recycled, "done"));
            }
            FileOutcome::Skipped { new_bytes, diag } => {
                f.new_bytes.store(new_bytes, Ordering::Relaxed);
                *f.status.lock().expect("status lock") = "skipped".to_string();
                f.pct.store(100, Ordering::Relaxed);
                skipped_count += 1;
                crate::compress_log::append_row(&crate::compress_log::Row {
                    job_id: &job.id,
                    index: i,
                    path: &f.path,
                    name: &name,
                    kind: kind_str,
                    preset: &job.preset,
                    status: "skipped_no_gain",
                    orig_bytes: orig,
                    new_bytes,
                    saved_bytes: 0,
                    pct_saved: 0.0,
                    ratio: ratio(orig, new_bytes),
                    tool,
                    codec_params: &codec_params,
                    duration_ms,
                    out_path: "",
                    recycled: false,
                    error: "",
                    reason: Reason::SkippedNoGain.as_str(),
                    exit_code: diag.exit_code,
                    tool_version,
                    command: &diag.command,
                    stderr_excerpt: &diag.stderr_tail,
                });
                log_file_debug(
                    &job.id, i, &f.path, kind_str, orig, tool, &diag, "", new_bytes,
                    "skipped", Reason::SkippedNoGain.as_str(), duration_ms, false, None, None,
                );
                job.emit(ev_file_done(i, "", orig, new_bytes, 0, false, "skipped_no_gain"));
            }
            FileOutcome::Error { reason, message, diag } => {
                *f.error.lock().expect("err lock") = Some(message.clone());
                *f.status.lock().expect("status lock") = "error".to_string();
                error_count += 1;
                crate::compress_log::append_row(&crate::compress_log::Row {
                    job_id: &job.id,
                    index: i,
                    path: &f.path,
                    name: &name,
                    kind: kind_str,
                    preset: &job.preset,
                    status: "error",
                    orig_bytes: orig,
                    new_bytes: 0,
                    saved_bytes: 0,
                    pct_saved: 0.0,
                    ratio: 0.0,
                    tool,
                    codec_params: &codec_params,
                    duration_ms,
                    out_path: "",
                    recycled: false,
                    error: &message,
                    reason: reason.as_str(),
                    exit_code: diag.exit_code,
                    tool_version,
                    command: &diag.command,
                    stderr_excerpt: &diag.stderr_tail,
                });
                log_file_debug(
                    &job.id, i, &f.path, kind_str, orig, tool, &diag, "", 0,
                    "error", reason.as_str(), duration_ms, false, None, None,
                );
                job.emit(ev_error(i, &f.path, &message));
            }
            FileOutcome::Cancelled => {
                *f.status.lock().expect("status lock") = "pending".to_string();
                f.pct.store(0, Ordering::Relaxed);
                write_manifest(&job);
                break;
            }
        }

        write_manifest(&job);
    }

    let cancelled = job.cancel.load(Ordering::SeqCst);
    let status = if cancelled {
        "cancelled"
    } else if error_count > 0 && done_count == 0 {
        "error"
    } else {
        "done"
    };
    *job.status.lock().expect("status lock") = status.to_string();
    write_manifest(&job);

    let total_saved = job.saved_bytes.load(Ordering::Relaxed);
    crate::compress_debug::log(&format!(
        "[job_end] job={} done={done_count} skipped={skipped_count} error={error_count} saved={total_saved} status={status}",
        job.id
    ));
    job.emit(ev_done(&job.id, done_count, error_count, total_saved));
    job.finished.store(true, Ordering::SeqCst);
    job.events_cv.notify_all();
}

/// One-line description of a detected tool for the job-start debug entry:
/// `"<path> (<version>)"` when found, else `not found`.
fn tool_desc(info: &compress_tools::ToolInfo) -> String {
    match (&info.path, &info.version) {
        (Some(p), Some(v)) => format!("{:?} ({v})", p.to_string_lossy()),
        (Some(p), None) => format!("{:?}", p.to_string_lossy()),
        _ => "not found".to_string(),
    }
}

/// Append one richly-detailed per-file entry to the verbose debug log: the
/// command, exit code, decision + reason, sizes, timing, recycle/tag results and
/// (when present) the captured stderr tail. A no-op when debug logging is off.
#[allow(clippy::too_many_arguments)]
fn log_file_debug(
    job_id: &str,
    index: usize,
    path: &str,
    kind: &str,
    orig: u64,
    tool: &str,
    diag: &EncodeDiag,
    out_path: &str,
    out_size: u64,
    decision: &str,
    reason: &str,
    duration_ms: u64,
    recycled: bool,
    recycle_error: Option<&str>,
    tagged: Option<bool>,
) {
    if !crate::compress_debug::enabled() {
        return;
    }
    let exit = diag
        .exit_code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "-".to_string());
    let mut line = format!(
        "[file] job={job_id} #{index} path={path:?} kind={kind} size={orig} tool={tool} exit={exit} decision={decision} reason={reason} duration_ms={duration_ms} recycled={recycled}"
    );
    if !out_path.is_empty() {
        line.push_str(&format!(" out={out_path:?} outSize={out_size}"));
    }
    if let Some(t) = tagged {
        line.push_str(&format!(" tag={}", if t { "added" } else { "off" }));
    }
    if let Some(e) = recycle_error {
        line.push_str(&format!(" recycle_error={e:?}"));
    }
    if !diag.command.is_empty() {
        line.push_str(&format!(" cmd={:?}", diag.command));
    }
    let tail = diag.stderr_tail.trim();
    if !tail.is_empty() {
        line.push_str("\n    stderr_tail:");
        for l in tail.lines() {
            line.push_str("\n    | ");
            line.push_str(l);
        }
    }
    crate::compress_debug::log(&line);
}

/// Precise, machine-readable classification of why a file compressed, was
/// skipped, or errored. Threaded into the per-file status, the human error
/// message, the CSV `reason` column and the verbose debug log so every outcome
/// is explainable.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reason {
    /// Output was smaller; original replaced/recycled.
    Success,
    /// Output produced but not smaller than the original (deleted, original kept).
    SkippedNoGain,
    /// The required external encoder (HandBrake / ffmpeg / ImageMagick) is missing.
    ErrorToolMissing,
    /// The file kind has no supported pipeline. Reserved in the taxonomy; the
    /// current pipelines route every kind (other files always zip).
    #[allow(dead_code)]
    ErrorUnsupported,
    /// The encoder ran but exited non-zero (carries exit code + stderr tail).
    ErrorEncoder,
    /// The encoder reported success but produced a missing/empty output.
    ErrorOutputEmpty,
    /// The source file no longer exists (commonly recycled by a prior run).
    ErrorSourceMissing,
    /// The encoder process could not be spawned at all.
    ErrorSpawn,
}

impl Reason {
    /// Stable snake_case code used in the CSV `reason` column, the debug log and
    /// the UI badge/tooltip mapping.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Reason::Success => "success",
            Reason::SkippedNoGain => "skipped_no_gain",
            Reason::ErrorToolMissing => "error_tool_missing",
            Reason::ErrorUnsupported => "error_unsupported",
            Reason::ErrorEncoder => "error_encoder",
            Reason::ErrorOutputEmpty => "error_output_empty",
            Reason::ErrorSourceMissing => "error_source_missing",
            Reason::ErrorSpawn => "error_spawn",
        }
    }
}

/// Result of one file's pipeline. Every terminal arm carries the [`EncodeDiag`]
/// captured during the encode (empty for outcomes that never spawned a tool, e.g.
/// a missing source or a missing encoder) plus, for errors, the precise reason.
enum FileOutcome {
    Done {
        out_path: String,
        new_bytes: u64,
        recycled: bool,
        recycle_error: Option<String>,
        tagged: bool,
        diag: EncodeDiag,
    },
    /// Output produced but not smaller than the original (deleted, original kept).
    Skipped { new_bytes: u64, diag: EncodeDiag },
    Error { reason: Reason, message: String, diag: EncodeDiag },
    /// Job cancelled mid-encode; partial output deleted, original untouched.
    Cancelled,
}

fn process_file(
    state: &Arc<AppState>,
    job: &Arc<CompressJob>,
    index: usize,
    hb: &compress_tools::ToolInfo,
    img: &compress_tools::ToolInfo,
    img_kind: Option<ImageKind>,
) -> FileOutcome {
    let (input_str, kind) = {
        let f = &job.files[index];
        (f.path.clone(), f.kind)
    };
    let input = PathBuf::from(&input_str);
    if !input.is_file() {
        return FileOutcome::Error {
            reason: Reason::ErrorSourceMissing,
            message: "source no longer exists - may have been recycled by a prior run"
                .to_string(),
            diag: EncodeDiag::default(),
        };
    }
    let orig = job.files[index].orig_bytes.load(Ordering::Relaxed);
    let out = output_path(&input, kind);

    // Run the pipeline for this file kind.
    let encode = match kind {
        FileKind::Video => match hb.path.as_ref() {
            Some(p) => run_handbrake(job, index, p, &input, &out, &job.preset),
            None => return FileOutcome::Error {
                reason: Reason::ErrorToolMissing,
                message: "HandBrake not installed - install HandBrakeCLI to compress video"
                    .to_string(),
                diag: EncodeDiag::default(),
            },
        },
        FileKind::Image => match (img.path.as_ref(), img_kind) {
            (Some(p), Some(ImageKind::Ffmpeg)) => {
                run_ffmpeg_image(job, index, p, &input, &out, &job.preset)
            }
            (Some(p), Some(ImageKind::ImageMagick)) => {
                run_magick_image(job, index, p, &input, &out, &job.preset)
            }
            _ => return FileOutcome::Error {
                reason: Reason::ErrorToolMissing,
                message: "no image encoder installed - install ffmpeg or ImageMagick to compress images"
                    .to_string(),
                diag: EncodeDiag::default(),
            },
        },
        FileKind::Other => run_zip(job, index, &input, &out),
    };

    let diag = match encode {
        EncodeResult::Cancelled => {
            let _ = std::fs::remove_file(&out);
            return FileOutcome::Cancelled;
        }
        EncodeResult::Spawn { error, command } => {
            return FileOutcome::Error {
                reason: Reason::ErrorSpawn,
                message: error,
                diag: EncodeDiag { command, exit_code: None, stderr_tail: String::new() },
            };
        }
        EncodeResult::Done { success, diag } => {
            if !success {
                let _ = std::fs::remove_file(&out);
                return FileOutcome::Error {
                    reason: Reason::ErrorEncoder,
                    message: encoder_error_message(&diag),
                    diag,
                };
            }
            diag
        }
    };

    // Verify the output exists and is non-empty.
    let new_bytes = match std::fs::metadata(&out) {
        Ok(m) if m.len() > 0 => m.len(),
        _ => {
            let _ = std::fs::remove_file(&out);
            return FileOutcome::Error {
                reason: Reason::ErrorOutputEmpty,
                message: "output missing or empty after encode".to_string(),
                diag,
            };
        }
    };

    // No gain → discard output, keep the original (never recycle).
    if new_bytes >= orig && orig > 0 {
        let _ = std::fs::remove_file(&out);
        return FileOutcome::Skipped { new_bytes, diag };
    }

    let out_str = out.to_string_lossy().into_owned();

    // [COMPRESSED] sidecar metadata tag keyed to the new path (the filename
    // already carries the [COMPRESSED] suffix; media re-encodes also embed a
    // container comment where the tool supports it).
    let tagged = job.tag_filename;
    if tagged {
        add_compressed_tag(&out_str);
    }

    // Audit the compress, then recycle the original if requested.
    let src_vec = [input_str.clone()];
    crate::audit::record(crate::audit::Entry {
        op: "compress",
        src: &src_vec,
        dst: &out_str,
        by: "server",
        ..Default::default()
    });

    let mut recycled = false;
    let mut recycle_error: Option<String> = None;
    if job.recycle_originals {
        match crate::recycle::recycle_path(&input) {
            Ok(()) => {
                recycled = true;
                crate::audit::record(crate::audit::Entry {
                    op: "recycle",
                    disposition: "recycle",
                    src: &src_vec,
                    by: "server",
                    ..Default::default()
                });
            }
            Err(e) => {
                recycle_error = Some(e.to_string());
                crate::audit::record(crate::audit::Entry {
                    op: "recycle",
                    disposition: "recycle",
                    src: &src_vec,
                    error: Some(&e.to_string()),
                    by: "server",
                    ..Default::default()
                });
            }
        }
    }

    // The parent directory's tree changed (new file, possibly recycled original).
    if let Some(parent) = input.parent() {
        state
            .scan_cache
            .lock()
            .expect("scan_cache lock")
            .invalidate(&parent.to_string_lossy());
    }

    FileOutcome::Done { out_path: out_str, new_bytes, recycled, recycle_error, tagged, diag }
}

/// Build a human error message for a non-zero encoder exit from its diagnostics:
/// the exit code, a trimmed tail of stderr (the part most likely to name the
/// real failure), and the full command line for reproduction.
fn encoder_error_message(diag: &EncodeDiag) -> String {
    let code = match diag.exit_code {
        Some(c) => format!("encoder exited with code {c}"),
        None => "encoder terminated without an exit code".to_string(),
    };
    let mut msg = code;
    let tail = diag.stderr_tail.trim();
    if !tail.is_empty() {
        // Surface the last ~400 chars of stderr inline; the full tail still goes
        // to the CSV `stderr_excerpt` column and the verbose debug log.
        let snippet = if tail.len() > 400 {
            let start = tail.len() - 400;
            format!("…{}", &tail[start..])
        } else {
            tail.to_string()
        };
        let snippet = snippet.replace(['\r', '\n'], " ");
        msg.push_str(" — ");
        msg.push_str(snippet.trim());
    }
    if !diag.command.is_empty() {
        msg.push_str(&format!(" [command: {}]", diag.command));
    }
    msg
}

/// Output path beside the original: `name [COMPRESSED].ext` (zip → `.zip`).
fn output_path(input: &Path, kind: FileKind) -> PathBuf {
    let parent = input.parent().unwrap_or_else(|| Path::new("."));
    let stem = input
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "output".to_string());
    let ext = match kind {
        FileKind::Other => "zip".to_string(),
        _ => input
            .extension()
            .map(|e| e.to_string_lossy().into_owned())
            .unwrap_or_default(),
    };
    let name = if ext.is_empty() {
        format!("{stem} [COMPRESSED]")
    } else {
        format!("{stem} [COMPRESSED].{ext}")
    };
    parent.join(name)
}

// ── Pipelines ──────────────────────────────────────────────────────────────

/// Diagnostics captured while running an encoder (or the built-in zip): the full
/// command line, the real process exit code (when one was produced), and a
/// bounded tail of the encoder's stderr. Threaded all the way out to the CSV log
/// and the verbose debug log so a failure is explainable.
#[derive(Default, Clone)]
pub(crate) struct EncodeDiag {
    pub(crate) command: String,
    pub(crate) exit_code: Option<i32>,
    pub(crate) stderr_tail: String,
}

/// Outcome of running an external encoder child.
enum EncodeResult {
    /// Child ran to completion; `success` is true when it exited 0. `diag`
    /// carries the command line, exit code and captured stderr tail.
    Done { success: bool, diag: EncodeDiag },
    /// Job was cancelled; the child was killed.
    Cancelled,
    /// The child could not be spawned. `command` is the line we tried to run.
    Spawn { error: String, command: String },
}

/// HandBrake video pipeline. Presets map to a quality (RF) + optional downscale;
/// progress is parsed from the encoder's `xx.x %` lines.
fn run_handbrake(
    job: &Arc<CompressJob>,
    index: usize,
    hb: &Path,
    input: &Path,
    out: &Path,
    preset: &str,
) -> EncodeResult {
    // RF (lower = higher quality / larger), plus an optional height cap.
    let (quality, max_height): (&str, Option<&str>) = match preset {
        "max" => ("30", Some("480")),
        "high" => ("20", None),
        _ => ("24", Some("1080")), // balanced
    };
    let mut cmd = Command::new(hb);
    cmd.arg("-i").arg(input).arg("-o").arg(out);
    cmd.args(["-e", "x264", "-q", quality, "-E", "av_aac", "-B", "160", "--optimize"]);
    if let Some(h) = max_height {
        cmd.args(["--maxHeight", h, "--keep-display-aspect"]);
    }
    run_child(job, index, cmd)
}

/// ffmpeg image pipeline. Presets map to a JPEG-style quality (`-q:v`, lower =
/// better) plus an optional long-edge cap; a `comment=COMPRESSED` metadata tag
/// is embedded where the container supports it. The output extension is kept the
/// same as the input so the codec is chosen by ffmpeg from the name.
fn run_ffmpeg_image(
    job: &Arc<CompressJob>,
    index: usize,
    ff: &Path,
    input: &Path,
    out: &Path,
    preset: &str,
) -> EncodeResult {
    let (quality, scale): (&str, Option<&str>) = match preset {
        "max" => ("12", Some("1280")),
        "high" => ("3", None),
        _ => ("6", Some("1920")), // balanced
    };
    let mut cmd = Command::new(ff);
    cmd.arg("-y").arg("-i").arg(input);
    if let Some(edge) = scale {
        // Cap the long edge while preserving aspect; never upscale.
        cmd.args([
            "-vf",
            &format!("scale='if(gt(iw,ih),min({edge},iw),-2)':'if(gt(iw,ih),-2,min({edge},ih))'"),
        ]);
    }
    cmd.args(["-q:v", quality, "-metadata", "comment=COMPRESSED"]);
    cmd.arg(out);
    run_child(job, index, cmd)
}

/// ImageMagick fallback image pipeline.
fn run_magick_image(
    job: &Arc<CompressJob>,
    index: usize,
    magick: &Path,
    input: &Path,
    out: &Path,
    preset: &str,
) -> EncodeResult {
    let (quality, resize): (&str, Option<&str>) = match preset {
        "max" => ("60", Some("1280000@")),
        "high" => ("92", None),
        _ => ("80", Some("3686400@")), // balanced (~1920x1920 area cap)
    };
    let mut cmd = Command::new(magick);
    cmd.arg(input);
    if let Some(area) = resize {
        cmd.args(["-resize", &format!("{area}>")]);
    }
    cmd.args(["-quality", quality, "-set", "comment", "COMPRESSED"]);
    cmd.arg(out);
    run_child(job, index, cmd)
}

/// Lossless zip pipeline for non-media files (built-in, no external tool). Runs
/// inline (no child), so cancellation is observed between files rather than mid-zip.
fn run_zip(job: &Arc<CompressJob>, index: usize, input: &Path, out: &Path) -> EncodeResult {
    let f = &job.files[index];
    f.pct.store(10, Ordering::Relaxed);
    job.emit(ev_progress(index, 10));
    let command = format!("zip (deflate, built-in) {} -> {}", input.display(), out.display());
    match crate::archive::compress(&[input.to_string_lossy().into_owned()], out) {
        Ok(()) => {
            f.pct.store(100, Ordering::Relaxed);
            job.emit(ev_progress(index, 100));
            EncodeResult::Done {
                success: true,
                diag: EncodeDiag { command, exit_code: Some(0), stderr_tail: String::new() },
            }
        }
        Err(e) => EncodeResult::Spawn { error: e, command },
    }
}

/// Render a [`Command`] as a readable single-line string for the logs (program
/// plus each argument, quoting any argument that contains whitespace).
fn command_to_string(cmd: &Command) -> String {
    let mut s = cmd.get_program().to_string_lossy().into_owned();
    for arg in cmd.get_args() {
        let a = arg.to_string_lossy();
        s.push(' ');
        if a.is_empty() || a.contains(char::is_whitespace) {
            s.push('"');
            s.push_str(&a);
            s.push('"');
        } else {
            s.push_str(&a);
        }
    }
    s
}

/// Spawn `cmd` as the job's active child, drain stdout silently, parse `%`
/// progress from stderr, and poll until exit or cancellation. The child handle
/// is stored on the job so `cancel` can `kill()` it.
fn run_child(job: &Arc<CompressJob>, index: usize, mut cmd: Command) -> EncodeResult {
    use std::process::Stdio;
    compress_tools::no_window(&mut cmd);
    // Capture the full command line before spawning so it is available for the
    // logs whether the child runs, fails, or can't even be spawned.
    let command = command_to_string(&cmd);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return EncodeResult::Spawn {
                error: format!("failed to start encoder: {e}"),
                command,
            };
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *job.child.lock().expect("child lock") = Some(child);

    // Drain stdout so the pipe can never fill and block the child.
    let out_handle = stdout.map(|mut pipe| {
        std::thread::spawn(move || {
            use std::io::Read;
            let mut sink = Vec::new();
            let _ = pipe.read_to_end(&mut sink);
        })
    });

    // Parse percentage from stderr (HandBrake/ffmpeg both report there) and
    // accumulate a bounded tail of the non-progress lines so a failure can be
    // explained. The thread returns the captured tail when it finishes.
    let err_handle = stderr.map(|pipe| {
        let job = Arc::clone(job);
        std::thread::spawn(move || read_progress(pipe, &job, index))
    });

    // Poll for completion / cancellation. Track the real exit status so the exit
    // code can be recorded.
    let mut cancelled = false;
    let exit_status: Option<std::process::ExitStatus> = loop {
        if job.cancel.load(Ordering::SeqCst) {
            if let Some(c) = job.child.lock().expect("child lock").as_mut() {
                let _ = c.kill();
            }
            cancelled = true;
            break None;
        }
        let poll = {
            let mut guard = job.child.lock().expect("child lock");
            match guard.as_mut() {
                // None means the handle vanished unexpectedly — treat as failure.
                None => break None,
                Some(c) => match c.try_wait() {
                    Ok(Some(st)) => Some(st),
                    Ok(None) => None,
                    // try_wait errored — treat as failure with no code.
                    Err(_) => break None,
                },
            }
        };
        match poll {
            Some(st) => break Some(st),
            None => std::thread::sleep(std::time::Duration::from_millis(60)),
        }
    };

    // Reap the child and clear the handle; readers finish once the pipes close.
    if let Some(mut c) = job.child.lock().expect("child lock").take() {
        let _ = c.wait();
    }
    if let Some(h) = out_handle {
        let _ = h.join();
    }
    let stderr_tail = err_handle
        .map(|h| h.join().unwrap_or_default())
        .unwrap_or_default();

    if cancelled {
        return EncodeResult::Cancelled;
    }
    let (success, exit_code) = match exit_status {
        Some(st) => (st.success(), st.code()),
        None => (false, None),
    };
    EncodeResult::Done {
        success,
        diag: EncodeDiag { command, exit_code, stderr_tail },
    }
}

/// Maximum number of non-progress stderr lines kept in the failure tail.
const STDERR_TAIL_LINES: usize = 50;
/// Maximum byte budget for the captured stderr tail (~8 KB).
const STDERR_TAIL_BYTES: usize = 8 * 1024;

/// Read encoder stderr, emitting a `progress` event each time the integer
/// percentage advances, while keeping a bounded tail (last ~50 non-progress
/// lines / ~8 KB) of everything else so a non-zero exit can be explained.
/// Returns the captured tail (newline-joined). Reads raw bytes and splits on
/// `\r`/`\n` because HandBrake rewrites its progress line with carriage returns.
fn read_progress<R: std::io::Read>(mut pipe: R, job: &Arc<CompressJob>, index: usize) -> String {
    use std::collections::VecDeque;
    let mut buf = [0u8; 4096];
    let mut line = String::new();
    let mut last_pct: i64 = -1;
    let mut tail: VecDeque<String> = VecDeque::new();
    let mut tail_bytes = 0usize;

    let commit = |line: &str, tail: &mut VecDeque<String>, tail_bytes: &mut usize| {
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            return;
        }
        // Progress lines are pure noise in a failure tail — they are emitted live
        // and excluded here so genuine error text survives the bound.
        if parse_percent(line).is_some() {
            return;
        }
        *tail_bytes += trimmed.len() + 1;
        tail.push_back(trimmed.to_string());
        while tail.len() > STDERR_TAIL_LINES || *tail_bytes > STDERR_TAIL_BYTES {
            if let Some(removed) = tail.pop_front() {
                *tail_bytes = tail_bytes.saturating_sub(removed.len() + 1);
            } else {
                break;
            }
        }
    };

    loop {
        let n = match pipe.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for &b in &buf[..n] {
            if b == b'\n' || b == b'\r' {
                if let Some(p) = parse_percent(&line) {
                    let pi = p.round().clamp(0.0, 100.0) as i64;
                    if pi != last_pct {
                        last_pct = pi;
                        job.files[index].pct.store(pi as u64, Ordering::Relaxed);
                        job.emit(ev_progress(index, pi as u64));
                    }
                }
                commit(&line, &mut tail, &mut tail_bytes);
                line.clear();
            } else {
                line.push(b as char);
                if line.len() > 4096 {
                    // Over-long line with no terminator: commit what we have so a
                    // pathological stream can't grow `line` without bound.
                    commit(&line, &mut tail, &mut tail_bytes);
                    line.clear();
                }
            }
        }
    }
    // Flush any trailing partial line.
    commit(&line, &mut tail, &mut tail_bytes);

    tail.into_iter().collect::<Vec<_>>().join("\n")
}

/// Extract a percentage from a line like `Encoding: task 1 of 1, 42.53 %`.
fn parse_percent(line: &str) -> Option<f64> {
    let bytes = line.as_bytes();
    let pct_pos = line.rfind('%')?;
    let mut end = pct_pos;
    while end > 0 && bytes[end - 1] == b' ' {
        end -= 1;
    }
    let mut start = end;
    while start > 0 {
        let c = bytes[start - 1];
        if c.is_ascii_digit() || c == b'.' {
            start -= 1;
        } else {
            break;
        }
    }
    if start == end {
        return None;
    }
    line[start..end].parse::<f64>().ok()
}

// ── [COMPRESSED] sidecar tag ─────────────────────────────────────────────────

/// Add a `COMPRESSED` tag for `path` to the shared tags store
/// (`%APPDATA%\FileTree\tags.json`). Read-modify-write is serialized with a
/// process-wide lock so concurrent jobs don't clobber each other's edits.
fn add_compressed_tag(path: &str) {
    use std::sync::Mutex as StdMutex;
    static LOCK: StdMutex<()> = StdMutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let text = crate::tags::load_tags_json();
    let items = crate::json::parse(&text)
        .and_then(|v| v.get("items").and_then(|a| a.as_array()).map(|a| a.to_vec()))
        .unwrap_or_default();

    let mut out: Vec<(String, Vec<String>, Option<String>)> = Vec::new();
    let mut found = false;
    for it in &items {
        let p = it.get("path").and_then(|v| v.as_str()).unwrap_or("");
        if p.is_empty() {
            continue;
        }
        let mut tags: Vec<String> = it
            .get("tags")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();
        let color = it.get("color").and_then(|v| v.as_str()).map(|s| s.to_string());
        if paths_eq(p, path) {
            found = true;
            if !tags.iter().any(|t| t == "COMPRESSED") {
                tags.push("COMPRESSED".to_string());
            }
        }
        out.push((p.to_string(), tags, color));
    }
    if !found {
        out.push((path.to_string(), vec!["COMPRESSED".to_string()], None));
    }

    let mut body = String::from("{\"items\":[");
    for (i, (p, tags, color)) in out.iter().enumerate() {
        if i > 0 {
            body.push(',');
        }
        body.push_str("{\"path\":");
        push_json_string(&mut body, p);
        body.push_str(",\"tags\":[");
        for (j, t) in tags.iter().enumerate() {
            if j > 0 {
                body.push(',');
            }
            push_json_string(&mut body, t);
        }
        body.push(']');
        if let Some(c) = color {
            body.push_str(",\"color\":");
            push_json_string(&mut body, c);
        }
        body.push('}');
    }
    body.push_str("]}");
    let _ = crate::tags::save_tags(body.as_bytes());
}

fn paths_eq(a: &str, b: &str) -> bool {
    a.replace('\\', "/").eq_ignore_ascii_case(&b.replace('\\', "/"))
}

// ── Manifest + JSON serialization ────────────────────────────────────────────

fn write_manifest(job: &CompressJob) {
    let _ = std::fs::create_dir_all(jobs_dir());
    let mut s = String::with_capacity(256 + job.files.len() * 96);
    s.push_str("{\"id\":");
    push_json_string(&mut s, &job.id);
    s.push_str(",\"status\":");
    push_json_string(&mut s, &job.status.lock().expect("status lock"));
    s.push_str(",\"preset\":");
    push_json_string(&mut s, &job.preset);
    s.push_str(",\"recycleOriginals\":");
    s.push_str(if job.recycle_originals { "true" } else { "false" });
    s.push_str(",\"tagFilename\":");
    s.push_str(if job.tag_filename { "true" } else { "false" });
    s.push_str(",\"total\":");
    s.push_str(&job.total.to_string());
    s.push_str(",\"savedBytes\":");
    s.push_str(&job.saved_bytes.load(Ordering::Relaxed).to_string());
    s.push_str(",\"files\":[");
    for (i, f) in job.files.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        push_file_json(&mut s, f);
    }
    s.push_str("]}");
    let _ = std::fs::write(&job.manifest_path, s);
}

fn push_file_json(s: &mut String, f: &FileState) {
    s.push_str("{\"index\":");
    s.push_str(&f.index.to_string());
    s.push_str(",\"path\":");
    push_json_string(s, &f.path);
    s.push_str(",\"kind\":");
    push_json_string(s, f.kind.as_str());
    s.push_str(",\"status\":");
    push_json_string(s, &f.status.lock().expect("status lock"));
    s.push_str(",\"pct\":");
    s.push_str(&f.pct.load(Ordering::Relaxed).to_string());
    s.push_str(",\"origBytes\":");
    s.push_str(&f.orig_bytes.load(Ordering::Relaxed).to_string());
    s.push_str(",\"newBytes\":");
    s.push_str(&f.new_bytes.load(Ordering::Relaxed).to_string());
    s.push_str(",\"recycled\":");
    s.push_str(if f.recycled.load(Ordering::Relaxed) { "true" } else { "false" });
    s.push_str(",\"outPath\":");
    push_json_string(s, &f.out_path.lock().expect("out lock"));
    s.push_str(",\"error\":");
    match f.error.lock().expect("err lock").as_ref() {
        Some(e) => push_json_string(s, e),
        None => s.push_str("null"),
    }
    s.push('}');
}

/// Full job JSON for the poll endpoint (`GET /api/compress-jobs/<id>`).
pub(crate) fn job_full_json(job: &CompressJob) -> String {
    let mut s = String::with_capacity(256 + job.files.len() * 96);
    s.push_str("{\"id\":");
    push_json_string(&mut s, &job.id);
    s.push_str(",\"status\":");
    push_json_string(&mut s, &job.status.lock().expect("status lock"));
    s.push_str(",\"total\":");
    s.push_str(&job.total.to_string());
    s.push_str(",\"savedBytes\":");
    s.push_str(&job.saved_bytes.load(Ordering::Relaxed).to_string());
    s.push_str(",\"files\":[");
    for (i, f) in job.files.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        push_file_json(&mut s, f);
    }
    s.push_str("]}");
    s
}

/// One row for the list endpoint (`GET /api/compress-jobs`), derived from either
/// a live registry job or a persisted manifest.
struct JobSummary {
    id: String,
    status: String,
    preset: String,
    total: usize,
    done: usize,
    errors: usize,
    skipped: usize,
    pending: usize,
    saved_bytes: u64,
    created_at: u64,
    updated_at: u64,
    /// Currently tracked + not finished in THIS process (i.e. encoding now).
    active: bool,
    /// Has remaining (non-`done`) work and isn't actively running — covers
    /// cancelled, errored, and "running" manifests orphaned by a restart.
    resumable: bool,
}

/// Job ids are `<unixMs>-<counter>`; the prefix is the creation time.
fn created_at_from_id(id: &str) -> u64 {
    id.split('-').next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0)
}

/// Manifest file's last-modified time in epoch ms (0 when unavailable). Doubles
/// as the job's "last updated" since the worker rewrites it after every file.
fn manifest_mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn summary_from_live(job: &CompressJob) -> JobSummary {
    let (mut done, mut errors, mut skipped) = (0usize, 0usize, 0usize);
    for f in &job.files {
        match f.status.lock().expect("status lock").as_str() {
            "done" => done += 1,
            "error" => errors += 1,
            "skipped" => skipped += 1,
            _ => {}
        }
    }
    let total = job.total;
    let pending = total.saturating_sub(done + errors + skipped);
    let active = !job.finished.load(Ordering::SeqCst);
    // On resume the worker re-runs everything that isn't `done` (skipped/error/
    // pending all re-run), so remaining work = total - done.
    let remaining = total.saturating_sub(done);
    let created = created_at_from_id(&job.id);
    let mtime = manifest_mtime_ms(&job.manifest_path);
    JobSummary {
        id: job.id.clone(),
        status: job.status.lock().expect("status lock").clone(),
        preset: job.preset.clone(),
        total,
        done,
        errors,
        skipped,
        pending,
        saved_bytes: job.saved_bytes.load(Ordering::Relaxed),
        created_at: created,
        updated_at: if mtime > 0 { mtime } else { created },
        active,
        resumable: !active && remaining > 0,
    }
}

fn summary_from_manifest(id: &str, path: &Path) -> Option<JobSummary> {
    let text = std::fs::read_to_string(path).ok()?;
    let root = crate::json::parse(&text)?;
    let status = root.get("status").and_then(|v| v.as_str()).unwrap_or("error").to_string();
    let preset = root.get("preset").and_then(|v| v.as_str()).unwrap_or("balanced").to_string();
    let saved_bytes = root.get("savedBytes").and_then(|v| v.as_u64()).unwrap_or(0);
    let files = root.get("files").and_then(|v| v.as_array());
    let total = root
        .get("total")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or_else(|| files.map(|a| a.len()).unwrap_or(0));
    let (mut done, mut errors, mut skipped) = (0usize, 0usize, 0usize);
    if let Some(files) = files {
        for f in files {
            match f.get("status").and_then(|v| v.as_str()).unwrap_or("pending") {
                "done" => done += 1,
                "error" => errors += 1,
                "skipped" => skipped += 1,
                _ => {}
            }
        }
    }
    let pending = total.saturating_sub(done + errors + skipped);
    let remaining = total.saturating_sub(done);
    Some(JobSummary {
        id: id.to_string(),
        status,
        preset,
        total,
        done,
        errors,
        skipped,
        pending,
        saved_bytes,
        created_at: created_at_from_id(id),
        updated_at: manifest_mtime_ms(path),
        // Not in this process's registry ⇒ never actively encoding here; it is
        // resumable whenever any file still needs work.
        active: false,
        resumable: remaining > 0,
    })
}

fn push_summary_json(s: &mut String, j: &JobSummary) {
    s.push_str("{\"id\":");
    push_json_string(s, &j.id);
    s.push_str(",\"status\":");
    push_json_string(s, &j.status);
    s.push_str(",\"preset\":");
    push_json_string(s, &j.preset);
    s.push_str(",\"total\":");
    s.push_str(&j.total.to_string());
    s.push_str(",\"done\":");
    s.push_str(&j.done.to_string());
    s.push_str(",\"errors\":");
    s.push_str(&j.errors.to_string());
    s.push_str(",\"skipped\":");
    s.push_str(&j.skipped.to_string());
    s.push_str(",\"pending\":");
    s.push_str(&j.pending.to_string());
    s.push_str(",\"savedBytes\":");
    s.push_str(&j.saved_bytes.to_string());
    s.push_str(",\"createdAt\":");
    s.push_str(&j.created_at.to_string());
    s.push_str(",\"updatedAt\":");
    s.push_str(&j.updated_at.to_string());
    s.push_str(",\"active\":");
    s.push_str(if j.active { "true" } else { "false" });
    s.push_str(",\"resumable\":");
    s.push_str(if j.resumable { "true" } else { "false" });
    s.push('}');
}

/// List every job for `GET /api/compress-jobs`: the live in-memory registry
/// (authoritative for jobs running in this process) merged with on-disk
/// manifests under `%APPDATA%\FileTree\jobs\` (so jobs left over from a previous
/// session show up as interrupted/resumable). Newest first.
pub(crate) fn list_jobs_json(state: &AppState) -> String {
    let mut summaries: Vec<JobSummary> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    {
        let jobs = state.compress_jobs.lock().expect("compress_jobs lock");
        for job in jobs.values() {
            seen.insert(job.id.clone());
            summaries.push(summary_from_live(job));
        }
    }
    if let Ok(rd) = std::fs::read_dir(jobs_dir()) {
        for entry in rd.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
            if !is_safe_job_id(stem) || seen.contains(stem) {
                continue;
            }
            if let Some(sum) = summary_from_manifest(stem, &path) {
                summaries.push(sum);
            }
        }
    }
    summaries.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then(b.updated_at.cmp(&a.updated_at))
    });
    let mut body = String::from("{\"jobs\":[");
    for (i, j) in summaries.iter().enumerate() {
        if i > 0 {
            body.push(',');
        }
        push_summary_json(&mut body, j);
    }
    body.push_str("]}");
    body
}

// ── NDJSON event builders (one JSON object per line) ──────────────────────────

fn ev_job_start(id: &str, total: usize) -> String {
    let mut s = String::from("{\"type\":\"job_start\",\"jobId\":");
    push_json_string(&mut s, id);
    s.push_str(",\"total\":");
    s.push_str(&total.to_string());
    s.push_str("}\n");
    s
}

fn ev_file_start(index: usize, path: &str, kind: FileKind, orig: u64) -> String {
    let mut s = String::from("{\"type\":\"file_start\",\"index\":");
    s.push_str(&index.to_string());
    s.push_str(",\"path\":");
    push_json_string(&mut s, path);
    s.push_str(",\"kind\":");
    push_json_string(&mut s, kind.as_str());
    s.push_str(",\"origBytes\":");
    s.push_str(&orig.to_string());
    s.push_str("}\n");
    s
}

fn ev_progress(index: usize, pct: u64) -> String {
    format!("{{\"type\":\"progress\",\"index\":{index},\"pct\":{pct}}}\n")
}

fn ev_file_done(
    index: usize,
    out_path: &str,
    orig: u64,
    new_bytes: u64,
    saved: u64,
    recycled: bool,
    status: &str,
) -> String {
    let mut s = String::from("{\"type\":\"file_done\",\"index\":");
    s.push_str(&index.to_string());
    s.push_str(",\"outPath\":");
    push_json_string(&mut s, out_path);
    s.push_str(",\"origBytes\":");
    s.push_str(&orig.to_string());
    s.push_str(",\"newBytes\":");
    s.push_str(&new_bytes.to_string());
    s.push_str(",\"savedBytes\":");
    s.push_str(&saved.to_string());
    s.push_str(",\"recycled\":");
    s.push_str(if recycled { "true" } else { "false" });
    s.push_str(",\"status\":");
    push_json_string(&mut s, status);
    s.push_str("}\n");
    s
}

fn ev_error(index: usize, path: &str, error: &str) -> String {
    let mut s = String::from("{\"type\":\"error\",\"index\":");
    s.push_str(&index.to_string());
    s.push_str(",\"path\":");
    push_json_string(&mut s, path);
    s.push_str(",\"error\":");
    push_json_string(&mut s, error);
    s.push_str("}\n");
    s
}

fn ev_done(id: &str, done: usize, errors: usize, saved: u64) -> String {
    let mut s = String::from("{\"type\":\"done\",\"jobId\":");
    push_json_string(&mut s, id);
    s.push_str(",\"done\":");
    s.push_str(&done.to_string());
    s.push_str(",\"errors\":");
    s.push_str(&errors.to_string());
    s.push_str(",\"savedBytes\":");
    s.push_str(&saved.to_string());
    s.push_str("}\n");
    s
}

