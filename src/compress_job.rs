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

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

use crate::compress_tools::{self, HandbrakeCaps, ImageKind};
use crate::export::push_json_string;
use crate::io::{acquire_compress, CompressLane};
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
    /// Precise outcome code (see [`Reason`]) so interrupted/old runs render an
    /// exact per-file outcome in the In Progress tab. Empty until terminal.
    pub(crate) reason: Mutex<String>,
    /// Wall-clock encode time for this file in ms (0 until done/skipped/error).
    pub(crate) duration_ms: AtomicU64,
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
            reason: Mutex::new(String::new()),
            duration_ms: AtomicU64::new(0),
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
    /// Max files this job encodes at once (its worker-pool size). Clamped to a
    /// hardware-derived default when not specified by the request.
    pub(crate) concurrency: usize,
    /// Encoder selection: `auto` | `x264` | `nvenc` | `qsv` | `vce`. `auto`
    /// picks the best available HW encoder for the codec, else CPU x264/x265.
    pub(crate) encoder: String,
    /// Whether hardware acceleration is permitted at all (gates Auto/HW picks).
    pub(crate) use_gpu: bool,
    /// Target video codec: `h264` | `h265`.
    pub(crate) codec: String,
    /// Deflate level for the zip pipeline (0-9; 0 = store).
    pub(crate) zip_level: i64,
    /// "running" | "done" | "cancelled" | "error"
    pub(crate) status: Mutex<String>,
    pub(crate) total: usize,
    pub(crate) files: Vec<FileState>,
    pub(crate) saved_bytes: AtomicU64,
    pub(crate) cancel: Arc<AtomicBool>,
    /// Handles of the encoder children currently running, keyed by file index,
    /// so `cancel` can `kill()` ALL of them (multiple files encode at once).
    /// Empty between files / for the inline zip pipeline.
    pub(crate) children: Mutex<HashMap<usize, Child>>,
    /// Serializes manifest rewrites so concurrent workers never tear the file.
    pub(crate) manifest_lock: Mutex<()>,
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

/// Performance + encoder options threaded from the POST body into the job and
/// its persisted manifest. Each field has a hardware-derived default applied by
/// [`CompressOptions::normalized`] so an older client (or resume) still works.
#[derive(Clone, Debug)]
pub(crate) struct CompressOptions {
    pub(crate) recycle_originals: bool,
    pub(crate) tag_filename: bool,
    /// 0 ⇒ "auto" (hardware-derived); otherwise the requested worker count.
    pub(crate) concurrency: usize,
    pub(crate) encoder: String,
    pub(crate) use_gpu: bool,
    pub(crate) codec: String,
    /// -1 ⇒ default; otherwise 0..=9 Deflate level.
    pub(crate) zip_level: i64,
}

impl Default for CompressOptions {
    fn default() -> Self {
        CompressOptions {
            recycle_originals: true,
            tag_filename: true,
            concurrency: 0,
            encoder: "auto".to_string(),
            use_gpu: true,
            codec: "h264".to_string(),
            zip_level: -1,
        }
    }
}

impl CompressOptions {
    fn norm_encoder(e: &str) -> String {
        match e {
            "auto" | "x264" | "nvenc" | "qsv" | "vce" => e.to_string(),
            _ => "auto".to_string(),
        }
    }
    fn norm_codec(c: &str) -> String {
        match c {
            "h264" | "h265" => c.to_string(),
            _ => "h264".to_string(),
        }
    }
    /// Default worker count: roughly half the logical cores (each video encode is
    /// itself multi-threaded), clamped to a sane range. The global CompressGate
    /// still caps total concurrent encoders across jobs.
    fn default_concurrency() -> usize {
        std::thread::available_parallelism()
            .map(|c| c.get())
            .unwrap_or(4)
            .div_ceil(2)
            .clamp(2, 8)
    }
    fn resolved_concurrency(&self) -> usize {
        if self.concurrency == 0 {
            Self::default_concurrency()
        } else {
            self.concurrency.clamp(1, 16)
        }
    }
    fn resolved_zip_level(&self) -> i64 {
        if self.zip_level < 0 { 6 } else { self.zip_level.clamp(0, 9) }
    }
}

/// Build a fresh job from a create request. Each file is classified and sized
/// (best-effort `metadata`) up front so `file_start` events carry `origBytes`.
pub(crate) fn create_job(
    paths: &[String],
    preset: &str,
    opts: &CompressOptions,
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
        recycle_originals: opts.recycle_originals,
        tag_filename: opts.tag_filename,
        concurrency: opts.resolved_concurrency(),
        encoder: CompressOptions::norm_encoder(&opts.encoder),
        use_gpu: opts.use_gpu,
        codec: CompressOptions::norm_codec(&opts.codec),
        zip_level: opts.resolved_zip_level(),
        status: Mutex::new("running".to_string()),
        total,
        files,
        saved_bytes: AtomicU64::new(0),
        cancel: Arc::new(AtomicBool::new(false)),
        children: Mutex::new(HashMap::new()),
        manifest_lock: Mutex::new(()),
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
    let concurrency = root
        .get("concurrency")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(0);
    let encoder = root.get("encoder").and_then(|v| v.as_str()).unwrap_or("auto").to_string();
    let use_gpu = root.get("useGpu").and_then(|v| v.as_bool()).unwrap_or(true);
    let codec = root.get("codec").and_then(|v| v.as_str()).unwrap_or("h264").to_string();
    let zip_level = root
        .get("zipLevel")
        .and_then(|v| v.as_f64())
        .map(|n| n as i64)
        .unwrap_or(-1);
    let opts = CompressOptions {
        recycle_originals,
        tag_filename,
        concurrency,
        encoder,
        use_gpu,
        codec,
        zip_level,
    };
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
            if let Some(r) = f.get("reason").and_then(|v| v.as_str()) {
                *state.reason.lock().expect("reason lock") = r.to_string();
            }
            state
                .duration_ms
                .store(f.get("durationMs").and_then(|v| v.as_u64()).unwrap_or(0), Ordering::Relaxed);
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
        concurrency: opts.resolved_concurrency(),
        encoder: CompressOptions::norm_encoder(&opts.encoder),
        use_gpu: opts.use_gpu,
        codec: CompressOptions::norm_codec(&opts.codec),
        zip_level: opts.resolved_zip_level(),
        status: Mutex::new("running".to_string()),
        total,
        files,
        saved_bytes: AtomicU64::new(carried_saved),
        cancel: Arc::new(AtomicBool::new(false)),
        children: Mutex::new(HashMap::new()),
        manifest_lock: Mutex::new(()),
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

/// A resolved video encoder: the HandBrake `-e` token, the global gate lane it
/// runs in, whether it is hardware-accelerated, and a short label for logs/CSV.
#[derive(Clone, Debug)]
pub(crate) struct VideoEncoder {
    /// HandBrake `-e` value, e.g. `x264`, `x265`, `nvenc_h264`, `qsv_h265`.
    pub(crate) hb: String,
    pub(crate) lane: CompressLane,
    pub(crate) is_gpu: bool,
}

/// Map the job's encoder choice + codec + detected capabilities to the concrete
/// HandBrake encoder to use. `auto` prefers a hardware encoder for the codec
/// (NVENC > QSV > VCE) when GPU use is allowed and available, otherwise the CPU
/// software encoder (x265 for HEVC, x264 for H.264). An explicit HW encoder that
/// isn't available silently falls back to CPU here (a runtime GPU failure is
/// handled separately by the per-file CPU retry).
pub(crate) fn select_video_encoder(
    encoder: &str,
    codec: &str,
    use_gpu: bool,
    caps: &HandbrakeCaps,
) -> VideoEncoder {
    let h265 = codec == "h265";
    let cpu = || VideoEncoder {
        hb: if h265 && caps.x265 { "x265".to_string() } else { "x264".to_string() },
        lane: CompressLane::VideoCpu,
        is_gpu: false,
    };
    let gpu = |hb: &str| VideoEncoder { hb: hb.to_string(), lane: CompressLane::Gpu, is_gpu: true };

    if !use_gpu || encoder == "x264" {
        return cpu();
    }
    // Pick a specific vendor encoder if requested + available.
    match encoder {
        "nvenc" => {
            if h265 && caps.nvenc_h265 { return gpu("nvenc_h265"); }
            if !h265 && caps.nvenc_h264 { return gpu("nvenc_h264"); }
        }
        "qsv" => {
            if h265 && caps.qsv_h265 { return gpu("qsv_h265"); }
            if !h265 && caps.qsv_h264 { return gpu("qsv_h264"); }
        }
        "vce" => {
            if h265 && caps.vce_h265 { return gpu("vce_h265"); }
            if !h265 && caps.vce_h264 { return gpu("vce_h264"); }
        }
        _ => {} // "auto" (and anything else) → preference order below
    }
    // Auto: prefer NVENC, then QSV, then VCE for the requested codec.
    if h265 {
        if caps.nvenc_h265 { return gpu("nvenc_h265"); }
        if caps.qsv_h265 { return gpu("qsv_h265"); }
        if caps.vce_h265 { return gpu("vce_h265"); }
    } else {
        if caps.nvenc_h264 { return gpu("nvenc_h264"); }
        if caps.qsv_h264 { return gpu("qsv_h264"); }
        if caps.vce_h264 { return gpu("vce_h264"); }
    }
    cpu()
}

/// Quality value + optional height cap for a video encoder at a preset. The
/// quality scale differs per encoder family: x264/x265 use RF, NVENC uses CQ and
/// QSV uses ICQ (all passed via HandBrake's `-q`), so the numbers are tuned per
/// family to land at comparable visual quality. Also returns the
/// `--encoder-preset` (speed/efficiency) appropriate to the family.
fn video_quality(hb_encoder: &str, preset: &str) -> (String, Option<&'static str>, &'static str) {
    let gpu = hb_encoder.starts_with("nvenc")
        || hb_encoder.starts_with("qsv")
        || hb_encoder.starts_with("vce");
    // (quality, maxHeight) by preset; GPU CQ/ICQ runs a touch higher than RF for
    // a similar size since hardware encoders are less efficient per quality step.
    let (q, h): (&str, Option<&'static str>) = match (preset, gpu) {
        ("max", false) => ("30", Some("480")),
        ("max", true) => ("32", Some("480")),
        ("high", false) => ("20", None),
        ("high", true) => ("22", None),
        (_, false) => ("24", Some("1080")),
        (_, true) => ("26", Some("1080")),
    };
    let enc_preset = if gpu {
        "quality"
    } else {
        match preset {
            "max" => "veryfast",
            "high" => "slow",
            _ => "medium",
        }
    };
    (q.to_string(), h, enc_preset)
}

/// The encoder + a human-readable codec parameter string for one file, derived
/// from its kind, the job preset and which image encoder was detected. Mirrors
/// the actual quality/scale knobs the `run_*` pipelines pass to each tool so the
/// CSV log records exactly how a file was (or would have been) encoded. This is
/// the fallback used for outcomes that never spawned an encoder; the live path
/// records the genuine encoder via [`EncodeMeta`].
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

/// Live outcome tallies shared across the parallel worker threads.
#[derive(Default)]
struct Counts {
    done: AtomicUsize,
    error: AtomicUsize,
    skipped: AtomicUsize,
}

fn run_job(state: Arc<AppState>, job: Arc<CompressJob>) {
    job.emit(ev_job_start(&job.id, job.total));

    let hb = compress_tools::detect_handbrake();
    let (img, img_kind) = compress_tools::detect_image();
    let caps = hb
        .path
        .as_ref()
        .map(|p| compress_tools::detect_handbrake_caps(p))
        .unwrap_or_default();

    // Job-start diagnostics: preset, options, file count and which encoders were
    // detected (path + version) so a "tool missing" outcome later is unambiguous.
    if crate::compress_debug::enabled() {
        let mut l = format!(
            "[job_start] job={} preset={} recycle={} tag={} files={} concurrency={} encoder={} codec={} useGpu={} zipLevel={}",
            job.id, job.preset, job.recycle_originals, job.tag_filename, job.total,
            job.concurrency, job.encoder, job.codec, job.use_gpu, job.zip_level
        );
        l.push_str(&format!(" handbrake={}", tool_desc(&hb)));
        l.push_str(&format!(" image={}", tool_desc(&img)));
        if let Some(k) = img_kind {
            l.push_str(&format!(" imageKind={}", k.as_str()));
        }
        l.push_str(&format!(
            " gpuCaps=[nvenc:{}/{} qsv:{}/{} vce:{}/{} x265:{}]",
            caps.nvenc_h264, caps.nvenc_h265, caps.qsv_h264, caps.qsv_h265,
            caps.vce_h264, caps.vce_h265, caps.x265
        ));
        l.push_str(" zip=built-in");
        crate::compress_debug::log(&l);

        // Evidence dump: the exact encoder tokens THIS HandBrake build reports,
        // plus a clear warning when the user asked for GPU but no HW encoder is
        // available (so the inevitable x264 fallback isn't silent).
        if let Some(p) = hb.path.as_ref() {
            crate::compress_debug::log(&format!(
                "[job_start] handbrake encoders ({}): {}",
                p.display(),
                compress_tools::handbrake_encoders_raw(p)
            ));
            if job.use_gpu && !caps.any_gpu() {
                crate::compress_debug::log(
                    "[job_start] WARNING: useGpu requested but this HandBrakeCLI exposes \
                     no hardware encoder (nvenc/qsv/vce). Encoding will use CPU x264/x265. \
                     Point FILETREE_HANDBRAKE at a hardware-capable HandBrakeCLI, or drop \
                     one into the app tools dir, to enable GPU.",
                );
            }
        }
    }

    // Per-job schedule: process the largest (longest-processing) files first for
    // better tail latency, skipping anything a prior run already completed.
    let already_done = job
        .files
        .iter()
        .filter(|f| f.status.lock().expect("status lock").as_str() == "done")
        .count();
    let mut schedule: Vec<usize> = (0..job.files.len())
        .filter(|&i| job.files[i].status.lock().expect("status lock").as_str() != "done")
        .collect();
    schedule.sort_by(|&a, &b| {
        job.files[b]
            .orig_bytes
            .load(Ordering::Relaxed)
            .cmp(&job.files[a].orig_bytes.load(Ordering::Relaxed))
    });

    let counts = Arc::new(Counts::default());
    counts.done.store(already_done, Ordering::Relaxed);
    let schedule = Arc::new(schedule);
    let cursor = Arc::new(AtomicUsize::new(0));

    // Bounded worker pool: `concurrency` threads draw the next scheduled index
    // from the shared cursor. The global CompressGate further caps total
    // concurrent encoders across all jobs (acquired per-file inside the pipeline).
    let nthreads = job.concurrency.clamp(1, schedule.len().max(1));
    let mut handles = Vec::with_capacity(nthreads);
    for _ in 0..nthreads {
        let state = Arc::clone(&state);
        let job = Arc::clone(&job);
        let schedule = Arc::clone(&schedule);
        let cursor = Arc::clone(&cursor);
        let counts = Arc::clone(&counts);
        let hb = hb.clone();
        let img = img.clone();
        handles.push(std::thread::spawn(move || {
            loop {
                if job.cancel.load(Ordering::SeqCst) {
                    break;
                }
                let k = cursor.fetch_add(1, Ordering::Relaxed);
                if k >= schedule.len() {
                    break;
                }
                let i = schedule[k];
                let stop = process_and_record(&state, &job, i, &hb, &img, img_kind, &caps, &counts);
                if stop {
                    break;
                }
            }
        }));
    }
    for h in handles {
        let _ = h.join();
    }

    let done_count = counts.done.load(Ordering::Relaxed);
    let error_count = counts.error.load(Ordering::Relaxed);
    let skipped_count = counts.skipped.load(Ordering::Relaxed);

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

/// Process one file and record its outcome (FileState, CSV row, debug log, live
/// event, manifest rewrite). Runs on a pool worker thread. Returns `true` when
/// the worker should stop (the job was cancelled mid-file).
fn process_and_record(
    state: &Arc<AppState>,
    job: &Arc<CompressJob>,
    i: usize,
    hb: &compress_tools::ToolInfo,
    img: &compress_tools::ToolInfo,
    img_kind: Option<ImageKind>,
    caps: &HandbrakeCaps,
    counts: &Counts,
) -> bool {
    {
        let f = &job.files[i];
        *f.status.lock().expect("status lock") = "running".to_string();
        f.pct.store(0, Ordering::Relaxed);
        let orig = f.orig_bytes.load(Ordering::Relaxed);
        job.emit(ev_file_start(i, &f.path, f.kind, orig));
    }

    let file_start = Instant::now();
    let outcome = process_file(state, job, i, hb, img, img_kind, caps);
    let duration_ms = file_start.elapsed().as_millis() as u64;
    let f = &job.files[i];
    let orig = f.orig_bytes.load(Ordering::Relaxed);
    let name = file_name_of(&f.path);
    let kind_str = f.kind.as_str();
    f.duration_ms.store(duration_ms, Ordering::Relaxed);

    // Fallback tool/params for outcomes that never spawned an encoder; the live
    // path overrides these from the genuine encoder via EncodeMeta.
    let (fallback_tool, fallback_params) = pipeline_params(f.kind, &job.preset, img_kind);
    let fallback_version = match f.kind {
        FileKind::Video => hb.version.as_deref().unwrap_or(""),
        FileKind::Image => img.version.as_deref().unwrap_or(""),
        FileKind::Other => "built-in",
    };

    let mut stop = false;
    match outcome {
        FileOutcome::Done { out_path, new_bytes, recycled, recycle_error, tagged, diag, meta } => {
            let tool = if meta.tool.is_empty() { fallback_tool } else { meta.tool.as_str() };
            let codec_params = if meta.codec_params.is_empty() { fallback_params.clone() } else { meta.codec_params.clone() };
            let tool_version = if meta.tool_version.is_empty() { fallback_version } else { meta.tool_version.as_str() };
            f.new_bytes.store(new_bytes, Ordering::Relaxed);
            f.recycled.store(recycled, Ordering::Relaxed);
            *f.out_path.lock().expect("out lock") = out_path.clone();
            *f.status.lock().expect("status lock") = "done".to_string();
            *f.reason.lock().expect("reason lock") = Reason::Success.as_str().to_string();
            f.pct.store(100, Ordering::Relaxed);
            let saved = orig.saturating_sub(new_bytes);
            job.saved_bytes.fetch_add(saved, Ordering::Relaxed);
            counts.done.fetch_add(1, Ordering::Relaxed);
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
            log_throughput_debug(&job.id, i, orig, new_bytes, duration_ms, meta.fps);
            log_file_debug(
                &job.id, i, &f.path, kind_str, orig, tool, &diag, &out_path, new_bytes,
                "compressed", Reason::Success.as_str(), duration_ms, recycled,
                recycle_error.as_deref(), Some(tagged),
            );
            job.emit(ev_file_done(i, &out_path, orig, new_bytes, saved, recycled, "done"));
        }
        FileOutcome::Skipped { new_bytes, diag, meta } => {
            let tool = if meta.tool.is_empty() { fallback_tool } else { meta.tool.as_str() };
            let codec_params = if meta.codec_params.is_empty() { fallback_params.clone() } else { meta.codec_params.clone() };
            let tool_version = if meta.tool_version.is_empty() { fallback_version } else { meta.tool_version.as_str() };
            f.new_bytes.store(new_bytes, Ordering::Relaxed);
            *f.status.lock().expect("status lock") = "skipped".to_string();
            *f.reason.lock().expect("reason lock") = Reason::SkippedNoGain.as_str().to_string();
            f.pct.store(100, Ordering::Relaxed);
            counts.skipped.fetch_add(1, Ordering::Relaxed);
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
        FileOutcome::Error { reason, message, diag, meta } => {
            let tool = if meta.tool.is_empty() { fallback_tool } else { meta.tool.as_str() };
            let codec_params = if meta.codec_params.is_empty() { fallback_params.clone() } else { meta.codec_params.clone() };
            let tool_version = if meta.tool_version.is_empty() { fallback_version } else { meta.tool_version.as_str() };
            *f.error.lock().expect("err lock") = Some(message.clone());
            *f.status.lock().expect("status lock") = "error".to_string();
            *f.reason.lock().expect("reason lock") = reason.as_str().to_string();
            counts.error.fetch_add(1, Ordering::Relaxed);
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
            stop = true;
        }
    }

    write_manifest(job);
    stop
}

/// Per-file throughput line (MB/s + encode fps + wall time) for tuning and
/// before/after benchmarking. No-op when debug logging is off.
fn log_throughput_debug(job_id: &str, index: usize, orig: u64, new_bytes: u64, duration_ms: u64, fps: Option<f64>) {
    if !crate::compress_debug::enabled() {
        return;
    }
    let secs = (duration_ms as f64 / 1000.0).max(0.001);
    let in_mbps = (orig as f64 / (1024.0 * 1024.0)) / secs;
    let out_mbps = (new_bytes as f64 / (1024.0 * 1024.0)) / secs;
    let mut l = format!(
        "[throughput] job={job_id} #{index} in={in_mbps:.2}MB/s out={out_mbps:.2}MB/s wall_ms={duration_ms}"
    );
    if let Some(f) = fps {
        l.push_str(&format!(" fps={f:.1}"));
    }
    crate::compress_debug::log(&l);
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

/// Encoder metadata for the CSV/debug record of a terminal file outcome: the
/// genuine tool + codec-parameter string actually used (which may differ from
/// the job default after a GPU→CPU fallback), its version, and (video) the
/// average encode fps parsed from the encoder's progress output.
#[derive(Default, Clone)]
struct EncodeMeta {
    tool: String,
    codec_params: String,
    tool_version: String,
    fps: Option<f64>,
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
        meta: EncodeMeta,
    },
    /// Output produced but not smaller than the original (deleted, original kept).
    Skipped { new_bytes: u64, diag: EncodeDiag, meta: EncodeMeta },
    Error { reason: Reason, message: String, diag: EncodeDiag, meta: EncodeMeta },
    /// Job cancelled mid-encode; partial output deleted, original untouched.
    Cancelled,
}

/// Extensions whose contents are already entropy-coded, so a re-zip/re-encode is
/// very unlikely to shrink them. Used by the pre-skip heuristic and to choose
/// zip "store" instead of wasting Deflate CPU.
fn is_already_compressed_ext(path: &Path) -> bool {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    matches!(
        ext.as_str(),
        "zip" | "7z" | "rar" | "gz" | "bz2" | "xz" | "zst" | "lz4" | "cab" | "tgz"
            | "jpg" | "jpeg" | "png" | "gif" | "webp" | "avif" | "heic"
            | "mp4" | "mkv" | "mov" | "m4v" | "webm" | "m4a" | "aac" | "mp3" | "ogg" | "flac"
            | "docx" | "xlsx" | "pptx"
    )
}

fn process_file(
    state: &Arc<AppState>,
    job: &Arc<CompressJob>,
    index: usize,
    hb: &compress_tools::ToolInfo,
    img: &compress_tools::ToolInfo,
    img_kind: Option<ImageKind>,
    caps: &HandbrakeCaps,
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
            meta: EncodeMeta::default(),
        };
    }
    let orig = job.files[index].orig_bytes.load(Ordering::Relaxed);
    let out = output_path(&input, kind);

    // Pre-skip heuristic for the zip pipeline: a file whose container is already
    // entropy-coded (zip/7z/jpg/mp4/office…) won't shrink under Deflate, so skip
    // spawning the zip work entirely and record it as a no-gain skip.
    if kind == FileKind::Other && is_already_compressed_ext(&input) {
        let mut meta = EncodeMeta::default();
        meta.tool = "zip".to_string();
        meta.codec_params = "store (pre-skip: already compressed)".to_string();
        meta.tool_version = "built-in".to_string();
        return FileOutcome::Skipped {
            new_bytes: orig,
            diag: EncodeDiag { command: "pre-skip (already compressed)".to_string(), exit_code: Some(0), stderr_tail: String::new() },
            meta,
        };
    }

    // Resolve the genuine encoder (so logs/CSV reflect GPU vs CPU) + run it. For
    // video a GPU encode failure falls back to CPU x264 (logged) on the same file.
    let mut meta = EncodeMeta::default();
    let encode = match kind {
        FileKind::Video => match hb.path.as_ref() {
            Some(p) => run_video(job, index, p, &input, &out, caps, hb, &mut meta),
            None => return FileOutcome::Error {
                reason: Reason::ErrorToolMissing,
                message: "HandBrake not installed - install HandBrakeCLI to compress video"
                    .to_string(),
                diag: EncodeDiag::default(),
                meta: EncodeMeta::default(),
            },
        },
        FileKind::Image => match (img.path.as_ref(), img_kind) {
            (Some(p), Some(ImageKind::Ffmpeg)) => {
                meta.tool = "ffmpeg".to_string();
                meta.tool_version = img.version.clone().unwrap_or_default();
                run_ffmpeg_image(job, index, p, &input, &out, &job.preset)
            }
            (Some(p), Some(ImageKind::ImageMagick)) => {
                meta.tool = "imagemagick".to_string();
                meta.tool_version = img.version.clone().unwrap_or_default();
                run_magick_image(job, index, p, &input, &out, &job.preset)
            }
            _ => return FileOutcome::Error {
                reason: Reason::ErrorToolMissing,
                message: "no image encoder installed - install ffmpeg or ImageMagick to compress images"
                    .to_string(),
                diag: EncodeDiag::default(),
                meta: EncodeMeta::default(),
            },
        },
        FileKind::Other => {
            meta.tool = "zip".to_string();
            meta.tool_version = "built-in".to_string();
            meta.codec_params = format!("deflate level={}", job.zip_level);
            run_zip(job, index, &input, &out, job.zip_level)
        }
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
                meta,
            };
        }
        EncodeResult::Done { success, diag, fps } => {
            meta.fps = fps;
            if !success {
                let _ = std::fs::remove_file(&out);
                return FileOutcome::Error {
                    reason: Reason::ErrorEncoder,
                    message: encoder_error_message(&diag),
                    diag,
                    meta,
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
                meta,
            };
        }
    };

    // No gain → discard output, keep the original (never recycle).
    if new_bytes >= orig && orig > 0 {
        let _ = std::fs::remove_file(&out);
        return FileOutcome::Skipped { new_bytes, diag, meta };
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

    FileOutcome::Done { out_path: out_str, new_bytes, recycled, recycle_error, tagged, diag, meta }
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
    /// carries the command line, exit code and captured stderr tail; `fps` is the
    /// average encode rate parsed from the encoder output (video only).
    Done { success: bool, diag: EncodeDiag, fps: Option<f64> },
    /// Job was cancelled; the child was killed.
    Cancelled,
    /// The child could not be spawned. `command` is the line we tried to run.
    Spawn { error: String, command: String },
}

/// Video pipeline entry: resolve the encoder (HW vs CPU), acquire the right
/// global-budget lane, run HandBrake, and — on a GPU encode failure — fall back
/// to CPU x264 on the same file (logged). Fills `meta` with the genuine encoder
/// used and its codec-parameter string for the CSV/debug record.
fn run_video(
    job: &Arc<CompressJob>,
    index: usize,
    hb: &Path,
    input: &Path,
    out: &Path,
    caps: &HandbrakeCaps,
    hb_info: &compress_tools::ToolInfo,
    meta: &mut EncodeMeta,
) -> EncodeResult {
    meta.tool = "handbrake".to_string();
    meta.tool_version = hb_info.version.clone().unwrap_or_default();

    let enc = select_video_encoder(&job.encoder, &job.codec, job.use_gpu, caps);
    let result = run_handbrake(job, index, hb, input, out, &job.preset, &enc, meta);

    // GPU encode failed → retry once on CPU x264, logged, so a flaky/maxed-out
    // hardware session doesn't fail the file outright.
    if enc.is_gpu {
        if let EncodeResult::Done { success: false, .. } = &result {
            crate::compress_debug::log(&format!(
                "[gpu_fallback] job={} #{index} encoder={} failed → retrying on CPU x264",
                job.id, enc.hb
            ));
            let _ = std::fs::remove_file(out);
            let cpu = VideoEncoder { hb: "x264".to_string(), lane: CompressLane::VideoCpu, is_gpu: false };
            return run_handbrake(job, index, hb, input, out, &job.preset, &cpu, meta);
        }
    }
    result
}

/// HandBrake video pipeline for a resolved encoder. Presets map to a quality
/// (RF/CQ/ICQ) + optional downscale + `--encoder-preset`; progress + fps are
/// parsed from the encoder output. Acquires the encoder's global-budget lane for
/// the duration of the encode (released on return).
fn run_handbrake(
    job: &Arc<CompressJob>,
    index: usize,
    hb: &Path,
    input: &Path,
    out: &Path,
    preset: &str,
    enc: &VideoEncoder,
    meta: &mut EncodeMeta,
) -> EncodeResult {
    let (quality, max_height, enc_preset) = video_quality(&enc.hb, preset);

    let mut params = format!("{} q={quality} preset={enc_preset}", enc.hb);
    if let Some(h) = max_height {
        params.push_str(&format!(" maxHeight={h}"));
    }
    meta.codec_params = params;

    // Acquire the lane permit (CPU video vs GPU session). Cancelled while queued
    // ⇒ no work done.
    let _permit = match acquire_compress(enc.lane, &job.cancel) {
        Some(p) => p,
        None => return EncodeResult::Cancelled,
    };

    let mut cmd = Command::new(hb);
    cmd.arg("-i").arg(input).arg("-o").arg(out);
    cmd.args(["-e", &enc.hb, "-q", &quality, "-E", "av_aac", "-B", "160", "--optimize"]);
    cmd.args(["--encoder-preset", enc_preset]);
    if !enc.is_gpu {
        // CPU tuning: let x264/x265 use the box's threads for this encode (the
        // lane cap bounds how many encodes run at once, so this won't oversubscribe).
        let threads = std::thread::available_parallelism().map(|c| c.get()).unwrap_or(4);
        cmd.args(["--encopts", &format!("threads={threads}")]);
    }
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
    let _permit = match acquire_compress(CompressLane::Image, &job.cancel) {
        Some(p) => p,
        None => return EncodeResult::Cancelled,
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
    let _permit = match acquire_compress(CompressLane::Image, &job.cancel) {
        Some(p) => p,
        None => return EncodeResult::Cancelled,
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
/// inline (no child), so cancellation is observed between files rather than
/// mid-zip. `level` is the Deflate level (0 stores). Acquires the zip lane.
fn run_zip(job: &Arc<CompressJob>, index: usize, input: &Path, out: &Path, level: i64) -> EncodeResult {
    let _permit = match acquire_compress(CompressLane::Zip, &job.cancel) {
        Some(p) => p,
        None => return EncodeResult::Cancelled,
    };
    let f = &job.files[index];
    f.pct.store(10, Ordering::Relaxed);
    job.emit(ev_progress(index, 10));
    let command = format!("zip (deflate level={level}, built-in) {} -> {}", input.display(), out.display());
    match crate::archive::compress_with_level(&[input.to_string_lossy().into_owned()], out, level) {
        Ok(()) => {
            f.pct.store(100, Ordering::Relaxed);
            job.emit(ev_progress(index, 100));
            EncodeResult::Done {
                success: true,
                diag: EncodeDiag { command, exit_code: Some(0), stderr_tail: String::new() },
                fps: None,
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
    // Track this child by file index so cancel can kill ALL active encoders
    // (multiple files run in parallel now).
    job.children.lock().expect("children lock").insert(index, child);

    // Drain stdout so the pipe can never fill and block the child.
    let out_handle = stdout.map(|mut pipe| {
        std::thread::spawn(move || {
            use std::io::Read;
            let mut sink = Vec::new();
            let _ = pipe.read_to_end(&mut sink);
        })
    });

    // Parse percentage + fps from stderr (HandBrake/ffmpeg both report there) and
    // accumulate a bounded tail of the non-progress lines so a failure can be
    // explained. The thread returns the captured tail + parsed fps.
    let err_handle = stderr.map(|pipe| {
        let job = Arc::clone(job);
        std::thread::spawn(move || read_progress(pipe, &job, index))
    });

    // Poll for completion / cancellation. Track the real exit status so the exit
    // code can be recorded.
    let mut cancelled = false;
    let exit_status: Option<std::process::ExitStatus> = loop {
        if job.cancel.load(Ordering::SeqCst) {
            if let Some(c) = job.children.lock().expect("children lock").get_mut(&index) {
                let _ = c.kill();
            }
            cancelled = true;
            break None;
        }
        let poll = {
            let mut guard = job.children.lock().expect("children lock");
            match guard.get_mut(&index) {
                // Missing means the handle vanished unexpectedly — treat as failure.
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

    // Reap the child and drop its handle; readers finish once the pipes close.
    if let Some(mut c) = job.children.lock().expect("children lock").remove(&index) {
        let _ = c.wait();
    }
    if let Some(h) = out_handle {
        let _ = h.join();
    }
    let (stderr_tail, fps) = err_handle
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
        fps,
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
fn read_progress<R: std::io::Read>(mut pipe: R, job: &Arc<CompressJob>, index: usize) -> (String, Option<f64>) {
    use std::collections::VecDeque;
    let mut buf = [0u8; 4096];
    let mut line = String::new();
    let mut last_pct: i64 = -1;
    let mut tail: VecDeque<String> = VecDeque::new();
    let mut tail_bytes = 0usize;
    // Last fps value seen (HandBrake `(NN.NN fps)`, ffmpeg `fps=NN`).
    let mut last_fps: Option<f64> = None;

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
                if let Some(f) = parse_fps(&line) {
                    last_fps = Some(f);
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

    (tail.into_iter().collect::<Vec<_>>().join("\n"), last_fps)
}

/// Extract an encode rate from an encoder progress line. HandBrake emits
/// `... avg 24.50 fps` / `(24.50 fps)`; ffmpeg emits `fps=24`. Best-effort.
fn parse_fps(line: &str) -> Option<f64> {
    let lower = line.to_ascii_lowercase();
    let pos = lower.find("fps")?;
    // ffmpeg style: `fps=NN`
    if let Some(eq) = lower[pos..].strip_prefix("fps=") {
        let num: String = eq.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
        return num.parse::<f64>().ok();
    }
    // HandBrake style: a number preceding `fps`. Scan backwards from `pos`.
    let bytes = lower.as_bytes();
    let mut end = pos;
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
    lower[start..end].parse::<f64>().ok()
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
    // Serialize concurrent rewrites (multiple files finish in parallel) so the
    // manifest can never be torn; recover a poisoned lock — it guards only I/O.
    let _guard = job.manifest_lock.lock().unwrap_or_else(|e| e.into_inner());
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
    s.push_str(",\"concurrency\":");
    s.push_str(&job.concurrency.to_string());
    s.push_str(",\"encoder\":");
    push_json_string(&mut s, &job.encoder);
    s.push_str(",\"useGpu\":");
    s.push_str(if job.use_gpu { "true" } else { "false" });
    s.push_str(",\"codec\":");
    push_json_string(&mut s, &job.codec);
    s.push_str(",\"zipLevel\":");
    s.push_str(&job.zip_level.to_string());
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
    // Enriched per-file outcome fields so interrupted/old runs show precise
    // results in the In Progress tab without re-reading the CSV log.
    let orig = f.orig_bytes.load(Ordering::Relaxed);
    let newb = f.new_bytes.load(Ordering::Relaxed);
    let saved = orig.saturating_sub(newb);
    s.push_str(",\"reason\":");
    push_json_string(s, &f.reason.lock().expect("reason lock"));
    s.push_str(",\"savedBytes\":");
    s.push_str(&saved.to_string());
    s.push_str(",\"pctSaved\":");
    s.push_str(&format!("{:.2}", pct_saved(orig, newb)));
    s.push_str(",\"durationMs\":");
    s.push_str(&f.duration_ms.load(Ordering::Relaxed).to_string());
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

/// Full job JSON for the poll endpoint built from a persisted manifest, so the
/// In Progress tab can lazy-load per-file detail for interrupted/old runs that
/// are no longer live in this process. Preserves the manifest's recorded
/// statuses + enriched fields (unlike `job_from_manifest`, which resets
/// non-`done` files to `pending` for resume). Returns `None` when the manifest
/// is missing/unreadable.
pub(crate) fn job_full_json_from_manifest(id: &str) -> Option<String> {
    if !is_safe_job_id(id) {
        return None;
    }
    let path = jobs_dir().join(format!("{id}.json"));
    let text = std::fs::read_to_string(&path).ok()?;
    let root = crate::json::parse(&text)?;
    let status = root.get("status").and_then(|v| v.as_str()).unwrap_or("error");
    let saved = root.get("savedBytes").and_then(|v| v.as_u64()).unwrap_or(0);
    let files = root.get("files").and_then(|v| v.as_array());
    let total = root
        .get("total")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or_else(|| files.map(|a| a.len()).unwrap_or(0));

    let mut s = String::with_capacity(256);
    s.push_str("{\"id\":");
    push_json_string(&mut s, id);
    s.push_str(",\"status\":");
    push_json_string(&mut s, status);
    s.push_str(",\"total\":");
    s.push_str(&total.to_string());
    s.push_str(",\"savedBytes\":");
    s.push_str(&saved.to_string());
    s.push_str(",\"files\":[");
    if let Some(files) = files {
        for (i, f) in files.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            // Re-emit the manifest's file object directly (it already carries the
            // enriched fields the UI needs: status, reason, savedBytes, etc.).
            let idx = f.get("index").and_then(|v| v.as_u64()).unwrap_or(i as u64);
            let path = f.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let kind = f.get("kind").and_then(|v| v.as_str()).unwrap_or("other");
            let fstatus = f.get("status").and_then(|v| v.as_str()).unwrap_or("pending");
            let pct = f.get("pct").and_then(|v| v.as_u64()).unwrap_or(0);
            let orig = f.get("origBytes").and_then(|v| v.as_u64()).unwrap_or(0);
            let newb = f.get("newBytes").and_then(|v| v.as_u64()).unwrap_or(0);
            let reason = f.get("reason").and_then(|v| v.as_str()).unwrap_or("");
            let duration = f.get("durationMs").and_then(|v| v.as_u64()).unwrap_or(0);
            let saved_b = orig.saturating_sub(newb);
            s.push_str("{\"index\":");
            s.push_str(&idx.to_string());
            s.push_str(",\"path\":");
            push_json_string(&mut s, path);
            s.push_str(",\"kind\":");
            push_json_string(&mut s, kind);
            s.push_str(",\"status\":");
            push_json_string(&mut s, fstatus);
            s.push_str(",\"pct\":");
            s.push_str(&pct.to_string());
            s.push_str(",\"origBytes\":");
            s.push_str(&orig.to_string());
            s.push_str(",\"newBytes\":");
            s.push_str(&newb.to_string());
            s.push_str(",\"error\":");
            match f.get("error").and_then(|v| v.as_str()) {
                Some(e) if !e.is_empty() => push_json_string(&mut s, e),
                _ => s.push_str("null"),
            }
            s.push_str(",\"reason\":");
            push_json_string(&mut s, reason);
            s.push_str(",\"savedBytes\":");
            s.push_str(&saved_b.to_string());
            s.push_str(",\"pctSaved\":");
            s.push_str(&format!("{:.2}", pct_saved(orig, newb)));
            s.push_str(",\"durationMs\":");
            s.push_str(&duration.to_string());
            s.push('}');
        }
    }
    s.push_str("]}");
    Some(s)
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

