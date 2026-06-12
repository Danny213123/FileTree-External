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

    let mut done_count = 0usize;
    let mut error_count = 0usize;

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

        let outcome = process_file(&state, &job, i, &hb, &img, img_kind);
        let f = &job.files[i];
        let orig = f.orig_bytes.load(Ordering::Relaxed);
        match outcome {
            FileOutcome::Done { out_path, new_bytes, recycled } => {
                f.new_bytes.store(new_bytes, Ordering::Relaxed);
                f.recycled.store(recycled, Ordering::Relaxed);
                *f.out_path.lock().expect("out lock") = out_path.clone();
                *f.status.lock().expect("status lock") = "done".to_string();
                f.pct.store(100, Ordering::Relaxed);
                let saved = orig.saturating_sub(new_bytes);
                job.saved_bytes.fetch_add(saved, Ordering::Relaxed);
                done_count += 1;
                job.emit(ev_file_done(i, &out_path, orig, new_bytes, saved, recycled, "done"));
            }
            FileOutcome::Skipped { new_bytes } => {
                f.new_bytes.store(new_bytes, Ordering::Relaxed);
                *f.status.lock().expect("status lock") = "skipped".to_string();
                f.pct.store(100, Ordering::Relaxed);
                job.emit(ev_file_done(i, "", orig, new_bytes, 0, false, "skipped_no_gain"));
            }
            FileOutcome::Error(msg) => {
                *f.error.lock().expect("err lock") = Some(msg.clone());
                *f.status.lock().expect("status lock") = "error".to_string();
                error_count += 1;
                job.emit(ev_error(i, &f.path, &msg));
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
    job.emit(ev_done(&job.id, done_count, error_count, total_saved));
    job.finished.store(true, Ordering::SeqCst);
    job.events_cv.notify_all();
}

/// Result of one file's pipeline.
enum FileOutcome {
    Done { out_path: String, new_bytes: u64, recycled: bool },
    /// Output produced but not smaller than the original (deleted, original kept).
    Skipped { new_bytes: u64 },
    Error(String),
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
        return FileOutcome::Error("source file no longer exists".to_string());
    }
    let orig = job.files[index].orig_bytes.load(Ordering::Relaxed);
    let out = output_path(&input, kind);

    // Run the pipeline for this file kind.
    let encode = match kind {
        FileKind::Video => match hb.path.as_ref() {
            Some(p) => run_handbrake(job, index, p, &input, &out, &job.preset),
            None => return FileOutcome::Error(
                "HandBrakeCLI not found — install it to compress video".to_string(),
            ),
        },
        FileKind::Image => match (img.path.as_ref(), img_kind) {
            (Some(p), Some(ImageKind::Ffmpeg)) => {
                run_ffmpeg_image(job, index, p, &input, &out, &job.preset)
            }
            (Some(p), Some(ImageKind::ImageMagick)) => {
                run_magick_image(job, index, p, &input, &out, &job.preset)
            }
            _ => return FileOutcome::Error(
                "No image encoder (ffmpeg/ImageMagick) found".to_string(),
            ),
        },
        FileKind::Other => run_zip(job, index, &input, &out),
    };

    match encode {
        EncodeResult::Cancelled => {
            let _ = std::fs::remove_file(&out);
            return FileOutcome::Cancelled;
        }
        EncodeResult::Spawn(e) => return FileOutcome::Error(e),
        EncodeResult::Done(success) => {
            if !success {
                let _ = std::fs::remove_file(&out);
                return FileOutcome::Error("encoder exited with an error".to_string());
            }
        }
    }

    // Verify the output exists and is non-empty.
    let new_bytes = match std::fs::metadata(&out) {
        Ok(m) if m.len() > 0 => m.len(),
        _ => {
            let _ = std::fs::remove_file(&out);
            return FileOutcome::Error("output missing or empty after encode".to_string());
        }
    };

    // No gain → discard output, keep the original (never recycle).
    if new_bytes >= orig && orig > 0 {
        let _ = std::fs::remove_file(&out);
        return FileOutcome::Skipped { new_bytes };
    }

    let out_str = out.to_string_lossy().into_owned();

    // [COMPRESSED] sidecar metadata tag keyed to the new path (the filename
    // already carries the [COMPRESSED] suffix; media re-encodes also embed a
    // container comment where the tool supports it).
    if job.tag_filename {
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

    FileOutcome::Done { out_path: out_str, new_bytes, recycled }
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

/// Outcome of running an external encoder child.
enum EncodeResult {
    /// Child ran to completion; `true` when it exited 0.
    Done(bool),
    /// Job was cancelled; the child was killed.
    Cancelled,
    /// The child could not be spawned.
    Spawn(String),
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
    match crate::archive::compress(&[input.to_string_lossy().into_owned()], out) {
        Ok(()) => {
            f.pct.store(100, Ordering::Relaxed);
            job.emit(ev_progress(index, 100));
            EncodeResult::Done(true)
        }
        Err(e) => EncodeResult::Spawn(e),
    }
}

/// Spawn `cmd` as the job's active child, drain stdout silently, parse `%`
/// progress from stderr, and poll until exit or cancellation. The child handle
/// is stored on the job so `cancel` can `kill()` it.
fn run_child(job: &Arc<CompressJob>, index: usize, mut cmd: Command) -> EncodeResult {
    use std::process::Stdio;
    compress_tools::no_window(&mut cmd);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return EncodeResult::Spawn(format!("failed to start encoder: {e}")),
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

    // Parse percentage from stderr (HandBrake/ffmpeg both report there).
    let err_handle = stderr.map(|pipe| {
        let job = Arc::clone(job);
        std::thread::spawn(move || read_progress(pipe, &job, index))
    });

    // Poll for completion / cancellation.
    let result = loop {
        if job.cancel.load(Ordering::SeqCst) {
            if let Some(c) = job.child.lock().expect("child lock").as_mut() {
                let _ = c.kill();
            }
            break EncodeResult::Cancelled;
        }
        let poll = {
            let mut guard = job.child.lock().expect("child lock");
            match guard.as_mut() {
                // None means the handle vanished unexpectedly — treat as failure.
                None => Some(false),
                Some(c) => match c.try_wait() {
                    Ok(Some(st)) => Some(st.success()),
                    Ok(None) => None,
                    Err(_) => Some(false),
                },
            }
        };
        match poll {
            Some(success) => break EncodeResult::Done(success),
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
    if let Some(h) = err_handle {
        let _ = h.join();
    }
    result
}

/// Read encoder stderr, emitting a `progress` event each time the integer
/// percentage advances. Reads raw bytes and splits on `\r`/`\n` because
/// HandBrake rewrites its progress line with carriage returns.
fn read_progress<R: std::io::Read>(mut pipe: R, job: &Arc<CompressJob>, index: usize) {
    let mut buf = [0u8; 4096];
    let mut line = String::new();
    let mut last_pct: i64 = -1;
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
                line.clear();
            } else {
                line.push(b as char);
                if line.len() > 4096 {
                    line.clear();
                }
            }
        }
    }
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

/// Compact summary for the list endpoint (`GET /api/compress-jobs`).
pub(crate) fn job_summary_json(job: &CompressJob) -> String {
    let mut done = 0usize;
    let mut errors = 0usize;
    for f in &job.files {
        match f.status.lock().expect("status lock").as_str() {
            "done" => done += 1,
            "error" => errors += 1,
            _ => {}
        }
    }
    let mut s = String::with_capacity(192);
    s.push_str("{\"id\":");
    push_json_string(&mut s, &job.id);
    s.push_str(",\"status\":");
    push_json_string(&mut s, &job.status.lock().expect("status lock"));
    s.push_str(",\"total\":");
    s.push_str(&job.total.to_string());
    s.push_str(",\"done\":");
    s.push_str(&done.to_string());
    s.push_str(",\"errors\":");
    s.push_str(&errors.to_string());
    s.push_str(",\"savedBytes\":");
    s.push_str(&job.saved_bytes.load(Ordering::Relaxed).to_string());
    s.push('}');
    s
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

