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
use crate::io::{acquire_compress, CompressLane, LockRecover};
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

/// Classify a path by extension.
///
/// Audio is deliberately NOT classified as `Video`: HandBrake is a *video*
/// transcoder and an audio-only input makes it fail with "no title found", so
/// routing audio there produced spurious per-file errors. Audio is treated as
/// `Other` instead — the built-in store/zip pipeline — where already-compact
/// audio (mp3/aac/ogg/flac/m4a, all in [`is_already_compressed_ext`]) is cleanly
/// recorded as a no-gain skip and only genuinely compressible audio (e.g. WAV)
/// is losslessly zipped. No external tool is required, so the outcome is always
/// coherent regardless of whether ffmpeg/HandBrake are installed.
pub(crate) fn classify(path: &Path) -> FileKind {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "mp4" | "mkv" | "mov" | "avi" | "wmv" | "flv" | "webm" | "m4v" | "mpg" | "mpeg" => {
            FileKind::Video
        }
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
    /// What actually happened to the ORIGINAL after a successful, verified
    /// compress: `"recycled"`, `"deleted"`, or `"kept"` (empty until terminal /
    /// for non-success outcomes). Distinct from the requested
    /// [`OriginalAction`]: a Recycle that fails leaves the original in place and
    /// records `"kept"`.
    pub(crate) disposition: Mutex<String>,
    pub(crate) out_path: Mutex<String>,
    pub(crate) error: Mutex<Option<String>>,
    /// Precise outcome code (see [`Reason`]) so interrupted/old runs render an
    /// exact per-file outcome in the In Progress tab. Empty until terminal.
    pub(crate) reason: Mutex<String>,
    /// Wall-clock encode time for this file in ms (0 until done/skipped/error).
    pub(crate) duration_ms: AtomicU64,
    /// The genuine encoder/codec-params actually used (e.g. `nvenc_h265 q=26
    /// preset=quality`), so the In Progress tab shows GPU vs CPU at a glance even
    /// for a live run. Empty until terminal.
    pub(crate) encoder: Mutex<String>,
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
            disposition: Mutex::new(String::new()),
            out_path: Mutex::new(String::new()),
            error: Mutex::new(None),
            reason: Mutex::new(String::new()),
            duration_ms: AtomicU64::new(0),
            encoder: Mutex::new(String::new()),
        }
    }
}

/// What to do with the ORIGINAL file after its compressed replacement has been
/// produced AND deep-verified. Replaces the old `recycle_originals: bool` so the
/// user gets an explicit, safe-by-default choice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OriginalAction {
    /// Send the original to the Recycle Bin (recoverable). The default.
    Recycle,
    /// Permanently delete the original (no Recycle Bin). Irreversible — gated in
    /// the UI with a warning and only ever runs after verification passes.
    Delete,
    /// Leave the original in place; the new `[COMPRESSED]` file coexists.
    Keep,
}

impl OriginalAction {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            OriginalAction::Recycle => "recycle",
            OriginalAction::Delete => "delete",
            OriginalAction::Keep => "keep",
        }
    }

    /// Parse the request/manifest string. Unknown values fall back to the safe,
    /// recoverable default (`Recycle`).
    pub(crate) fn from_str(s: &str) -> OriginalAction {
        match s.trim().to_ascii_lowercase().as_str() {
            "delete" => OriginalAction::Delete,
            "keep" => OriginalAction::Keep,
            _ => OriginalAction::Recycle,
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
    pub(crate) original_action: OriginalAction,
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
    /// Minimum original size (bytes) to attempt compression. Files smaller than
    /// this are skipped (`SkippedTooSmall`) untouched — small files, especially
    /// videos with too few frames, rarely shrink. 0 = no minimum (compress all).
    pub(crate) min_size_bytes: u64,
    /// Custom preset video resolution cap (px height). 0 = original (no cap).
    pub(crate) custom_max_height: u32,
    /// Custom preset video quality (RF base). 0 = use the default (26).
    pub(crate) custom_quality: u32,
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
        let mut events = self.events.lock_recover();
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
    pub(crate) original_action: OriginalAction,
    pub(crate) tag_filename: bool,
    /// 0 ⇒ "auto" (hardware-derived); otherwise the requested worker count.
    pub(crate) concurrency: usize,
    pub(crate) encoder: String,
    pub(crate) use_gpu: bool,
    pub(crate) codec: String,
    /// -1 ⇒ default; otherwise 0..=9 Deflate level.
    pub(crate) zip_level: i64,
    /// Minimum original size (bytes) to attempt compression; smaller files are
    /// skipped untouched. 0 = no minimum (compress all).
    pub(crate) min_size_bytes: u64,
    /// Custom preset video resolution cap (px height). 0 = original (no cap).
    /// Only consulted when the preset is `custom`.
    pub(crate) custom_max_height: u32,
    /// Custom preset video quality (RF base). 0 = use the default (26). Only
    /// consulted when the preset is `custom`.
    pub(crate) custom_quality: u32,
}

impl Default for CompressOptions {
    fn default() -> Self {
        CompressOptions {
            original_action: OriginalAction::Recycle,
            tag_filename: true,
            concurrency: 0,
            encoder: "auto".to_string(),
            use_gpu: true,
            codec: "h264".to_string(),
            zip_level: -1,
            min_size_bytes: 0,
            custom_max_height: 0,
            custom_quality: 0,
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
            "h264" | "h265" | "av1" => c.to_string(),
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
        original_action: opts.original_action,
        tag_filename: opts.tag_filename,
        concurrency: opts.resolved_concurrency(),
        encoder: CompressOptions::norm_encoder(&opts.encoder),
        use_gpu: opts.use_gpu,
        codec: CompressOptions::norm_codec(&opts.codec),
        zip_level: opts.resolved_zip_level(),
        min_size_bytes: opts.min_size_bytes,
        custom_max_height: opts.custom_max_height,
        custom_quality: opts.custom_quality,
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
/// Re-validate that the external encoders a (to-be-resumed) job still needs are
/// available, BEFORE spawning the worker. Done files are skipped on resume, so
/// only the not-yet-done files' kinds matter. Returns an actionable error when a
/// required tool is missing — far better than spawning a job that then reports
/// `error_tool_missing` on every remaining video/image. `None` ⇒ good to resume.
pub(crate) fn revalidate_job_tools(job: &CompressJob) -> Option<String> {
    let mut needs_video = false;
    let mut needs_image = false;
    for f in &job.files {
        if f.status.lock_recover().as_str() == "done" {
            continue; // already compressed; will be skipped on resume
        }
        match f.kind {
            FileKind::Video => needs_video = true,
            FileKind::Image => needs_image = true,
            FileKind::Other => {} // built-in zip, no external tool
        }
    }
    if needs_video && !compress_tools::detect_handbrake().found {
        return Some(
            "HandBrake is required to resume this job's remaining video files, but HandBrakeCLI was not found. Install it (or set FILETREE_HANDBRAKE) and try again.".to_string(),
        );
    }
    if needs_image && !compress_tools::detect_image().0.found {
        return Some(
            "An image encoder (ffmpeg or ImageMagick) is required to resume this job's remaining image files, but none was found.".to_string(),
        );
    }
    None
}

pub(crate) fn job_from_manifest(id: &str) -> Option<Arc<CompressJob>> {
    if !is_safe_job_id(id) {
        return None;
    }
    let manifest_path = jobs_dir().join(format!("{id}.json"));
    let text = std::fs::read_to_string(&manifest_path).ok()?;
    let root = crate::json::parse(&text)?;

    let preset = root.get("preset").and_then(|v| v.as_str()).unwrap_or("balanced");
    // Tri-state disposition with back-compat: prefer the new `originalAction`
    // string; if absent, derive from the legacy `recycleOriginals` boolean
    // (true => Recycle, false => Keep) so older manifests resume unchanged.
    let original_action = match root.get("originalAction").and_then(|v| v.as_str()) {
        Some(s) => OriginalAction::from_str(s),
        None => {
            let legacy = root.get("recycleOriginals").and_then(|v| v.as_bool()).unwrap_or(true);
            if legacy { OriginalAction::Recycle } else { OriginalAction::Keep }
        }
    };
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
    let min_size_bytes = root
        .get("minSizeBytes")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let custom_max_height = root
        .get("customMaxHeight")
        .and_then(|v| v.as_u64())
        .map(|n| n as u32)
        .unwrap_or(0);
    let custom_quality = root
        .get("customQuality")
        .and_then(|v| v.as_u64())
        .map(|n| n as u32)
        .unwrap_or(0);
    let opts = CompressOptions {
        original_action,
        tag_filename,
        concurrency,
        encoder,
        use_gpu,
        codec,
        zip_level,
        min_size_bytes,
        custom_max_height,
        custom_quality,
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
            if let Some(d) = f.get("disposition").and_then(|v| v.as_str()) {
                *state.disposition.lock_recover() = d.to_string();
            }
            if let Some(op) = f.get("outPath").and_then(|v| v.as_str()) {
                *state.out_path.lock_recover() = op.to_string();
            }
            if let Some(r) = f.get("reason").and_then(|v| v.as_str()) {
                *state.reason.lock_recover() = r.to_string();
            }
            if let Some(e) = f.get("encoder").and_then(|v| v.as_str()) {
                *state.encoder.lock_recover() = e.to_string();
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
        original_action,
        tag_filename,
        concurrency: opts.resolved_concurrency(),
        encoder: CompressOptions::norm_encoder(&opts.encoder),
        use_gpu: opts.use_gpu,
        codec: CompressOptions::norm_codec(&opts.codec),
        zip_level: opts.resolved_zip_level(),
        min_size_bytes: opts.min_size_bytes,
        custom_max_height: opts.custom_max_height,
        custom_quality: opts.custom_quality,
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
        "max" | "more" | "balanced" | "high" | "custom" => p.to_string(),
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
    hw: &compress_tools::GpuHardware,
) -> VideoEncoder {
    let av1 = codec == "av1";
    let h265 = codec == "h265";
    // CPU software encoder per codec: SVT-AV1 for AV1, x265 for HEVC (when the
    // build exposes it), else x264.
    let cpu = || VideoEncoder {
        hb: if av1 {
            "svt_av1".to_string()
        } else if h265 && caps.x265 {
            "x265".to_string()
        } else {
            "x264".to_string()
        },
        lane: CompressLane::VideoCpu,
        is_gpu: false,
    };
    let gpu = |hb: &str| VideoEncoder { hb: hb.to_string(), lane: CompressLane::Gpu, is_gpu: true };
    let suffix = if av1 { "av1" } else if h265 { "h265" } else { "h264" };
    let tok = |vendor: &str| -> String { format!("{vendor}_{suffix}") };

    if !use_gpu || encoder == "x264" {
        return cpu();
    }

    // Whether we should attempt a vendor's HW encoder. We deliberately treat an
    // empty `-h` cap as "unknown" rather than "absent": the build the user runs
    // omits the tokens from redirected help even though NVENC works. So a vendor
    // is attempted when its `-h` token is present OR its physical adapter exists.
    // A failed attempt now falls back to CPU *loudly* (see run_video), so this
    // never silently wastes work — and we still avoid attempts when there is no
    // matching adapter at all (unless the user explicitly picked that vendor).
    //
    // AV1 is gated more tightly: only fairly recent GPUs encode AV1, so the mere
    // presence of an adapter does NOT imply AV1 support. We require the `-h` AV1
    // token; absent that, AV1 stays on the CPU SVT-AV1 encoder (no wasted GPU
    // attempt that would just fall back).
    let (nvenc_ok, qsv_ok, vce_ok) = if av1 {
        (caps.nvenc_av1, caps.qsv_av1, caps.vce_av1)
    } else {
        (
            caps.nvenc_h264 || caps.nvenc_h265 || hw.nvidia,
            caps.qsv_h264 || caps.qsv_h265 || hw.intel,
            caps.vce_h264 || caps.vce_h265 || hw.amd,
        )
    };

    // Explicit vendor pick: honor it even with no adapter detected (the user
    // asked for it; the loud fallback explains any failure).
    match encoder {
        "nvenc" => return gpu(&tok("nvenc")),
        "qsv" => return gpu(&tok("qsv")),
        "vce" => return gpu(&tok("vce")),
        _ => {} // "auto" (and anything else) → preference order below
    }

    // Auto: prefer NVENC, then QSV, then VCE — but only for a vendor whose
    // adapter/token is actually present, so a GPU-less box stays on CPU.
    if nvenc_ok { return gpu(&tok("nvenc")); }
    if qsv_ok { return gpu(&tok("qsv")); }
    if vce_ok { return gpu(&tok("vce")); }
    cpu()
}

/// Quality value + optional height cap for a video encoder at a preset. The
/// quality scale differs per encoder family: x264/x265 use RF, NVENC uses CQ and
/// QSV uses ICQ (all passed via HandBrake's `-q`), so the numbers are tuned per
/// family to land at comparable visual quality. Also returns the
/// `--encoder-preset` (speed/efficiency) appropriate to the family.
fn video_quality(
    hb_encoder: &str,
    preset: &str,
    custom_q: u32,
    custom_h: u32,
) -> (String, Option<String>, &'static str) {
    let gpu = hb_encoder.starts_with("nvenc")
        || hb_encoder.starts_with("qsv")
        || hb_encoder.starts_with("vce");
    // (quality, maxHeight) by preset; GPU CQ/ICQ runs a touch higher than RF for
    // a similar size since hardware encoders are less efficient per quality step.
    let (q, h): (String, Option<String>) = match (preset, gpu) {
        ("max", false) => ("30".to_string(), Some("480".to_string())),
        ("max", true) => ("32".to_string(), Some("480".to_string())),
        // "More savings": between Balanced (1080p/RF24) and Maximum (480p/RF30).
        ("more", false) => ("27".to_string(), Some("720".to_string())),
        ("more", true) => ("29".to_string(), Some("720".to_string())),
        ("high", false) => ("20".to_string(), None),
        ("high", true) => ("22".to_string(), None),
        ("custom", _) => {
            // User-chosen RF base (default 26, clamped); GPU adds +2 like the
            // other presets. Height 0 ⇒ original (no cap).
            let base = custom_quality_or_default(custom_q);
            let q = if gpu { (base + 2).min(40) } else { base };
            let h = if custom_h == 0 { None } else { Some(custom_h.to_string()) };
            (q.to_string(), h)
        }
        (_, false) => ("24".to_string(), Some("1080".to_string())),
        (_, true) => ("26".to_string(), Some("1080".to_string())),
    };
    let enc_preset = if gpu {
        "quality"
    } else if hb_encoder.starts_with("svt_av1") {
        // SVT-AV1 uses a numeric speed preset (0 slowest/best … 13 fastest).
        // Bias toward "slower but smaller" for the quality-focused presets.
        match preset {
            "max" => "9",
            "more" => "8",
            "high" => "5",
            "custom" => "7",
            _ => "7",
        }
    } else {
        match preset {
            "max" => "veryfast",
            "high" => "slow",
            // "more" and "custom" both use x264 medium.
            _ => "medium",
        }
    };
    (q, h, enc_preset)
}

/// Clamp a custom RF base into the supported 16..=40 window, substituting the
/// default 26 when unset (0).
fn custom_quality_or_default(custom_q: u32) -> u32 {
    if custom_q == 0 { 26 } else { custom_q.clamp(16, 40) }
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
    custom_q: u32,
    custom_h: u32,
) -> (&'static str, String) {
    match kind {
        FileKind::Video => {
            let (q, h): (String, Option<String>) = match preset {
                "max" => ("30".to_string(), Some("480".to_string())),
                "more" => ("27".to_string(), Some("720".to_string())),
                "high" => ("20".to_string(), None),
                "custom" => {
                    let q = custom_quality_or_default(custom_q).to_string();
                    let h = if custom_h == 0 { None } else { Some(custom_h.to_string()) };
                    (q, h)
                }
                _ => ("24".to_string(), Some("1080".to_string())),
            };
            let mut s = format!("x264 rf={q}");
            if let Some(h) = h {
                s.push_str(&format!(" maxHeight={h}"));
            }
            ("handbrake", s)
        }
        FileKind::Image => match img_kind {
            Some(ImageKind::Ffmpeg) => {
                // Custom images reuse Balanced behavior (video-only scope).
                let (q, scale) = match preset {
                    "max" => ("12", Some("1280")),
                    "more" => ("9", Some("1600")),
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
                // Custom images reuse Balanced behavior (video-only scope).
                let (q, resize) = match preset {
                    "max" => ("60", Some("1280000@")),
                    "more" => ("72", Some("2560000@")),
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
///
/// `run_job` is wrapped in a top-level [`catch_unwind`]: the per-file pipeline
/// has its OWN panic isolation (see the worker loop), but the orchestration
/// around it — tool detection at startup, the schedule build, the reconcile/
/// finalize tail, the manifest write — runs on this thread OUTSIDE that per-file
/// catch. Were any of it to panic, the job thread would die with files left in
/// `pending`/`running` FOREVER and the job never marked finished (no `done`
/// event, `finished` never set) — i.e. the job "ends early" with most files
/// stuck pending, the exact early-termination failure. The guard below
/// guarantees the job is ALWAYS finalized: every non-terminal file is reconciled
/// to a terminal internal error and the job is closed out, so no panic anywhere
/// in the runner can ever strand the batch.
pub(crate) fn spawn_job(state: Arc<AppState>, job: Arc<CompressJob>) {
    std::thread::spawn(move || {
        let guard_job = Arc::clone(&job);
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_job(state, job)
        }));
        if let Err(payload) = outcome {
            let msg = panic_message(payload.as_ref());
            crate::compress_debug::log_force(&format!(
                "[panic] job={} run_job orchestration panicked: {msg} — force-finalizing so no file is left pending",
                guard_job.id
            ));
            force_finalize_job(&guard_job);
        }
    });
}

/// Safety net invoked only when [`run_job`] itself panicked (an orchestration
/// fault, distinct from a per-file panic which the worker loop already handles).
/// Reconciles every non-terminal file to a terminal internal error (unless the
/// job was cancelled, which legitimately leaves files pending for resume),
/// recomputes the tallies from the on-disk-equivalent file statuses, marks the
/// job finished, persists the manifest, and emits the terminal `done` event so a
/// stream reader is released. Uses poison-tolerant locks throughout so it stays
/// correct even after a panic poisoned shared state.
fn force_finalize_job(job: &Arc<CompressJob>) {
    let cancelled = job.cancel.load(Ordering::SeqCst);
    let counts = Arc::new(Counts::default());
    if !cancelled {
        for i in 0..job.files.len() {
            let st = job.files[i].status.lock_recover().clone();
            if st == "pending" || st == "running" {
                record_internal_error_guarded(
                    job,
                    i,
                    &counts,
                    "the compression job runner aborted unexpectedly; this file was force-failed so the batch could finalize",
                );
            }
        }
    }

    // Recompute the terminal tallies straight from the file statuses so the
    // event/manifest are accurate regardless of how far run_job got before it
    // panicked (the in-flight `Counts` it owned are gone with its stack).
    let (mut done, mut error, mut skipped, mut verify_failed) = (0usize, 0usize, 0usize, 0usize);
    for f in &job.files {
        match f.status.lock_recover().as_str() {
            "done" => done += 1,
            "skipped" => skipped += 1,
            "error" => {
                error += 1;
                if f.reason.lock_recover().as_str() == Reason::ErrorVerifyFailed.as_str() {
                    verify_failed += 1;
                }
            }
            _ => {}
        }
    }

    let status = if cancelled { "cancelled" } else { "error" };
    *job.status.lock_recover() = status.to_string();
    write_manifest(job);
    let total_saved = job.saved_bytes.load(Ordering::Relaxed);
    job.emit(ev_done(&job.id, done, error, skipped, verify_failed, job.total, total_saved));
    job.finished.store(true, Ordering::SeqCst);
    job.events_cv.notify_all();
}

/// Live outcome tallies shared across the parallel worker threads.
#[derive(Default)]
struct Counts {
    done: AtomicUsize,
    error: AtomicUsize,
    skipped: AtomicUsize,
    /// Subset of `error`: files whose compressed output failed the deep-verify
    /// gate (original was preserved). Surfaced separately so the UI totals can
    /// distinguish a corrupt-output rejection from other failures.
    verify_failed: AtomicUsize,
}

fn run_job(state: Arc<AppState>, job: Arc<CompressJob>) {
    job.emit(ev_job_start(&job.id, job.total));

    // Test-only fault injection for the ORCHESTRATION path (distinct from the
    // per-file injector in `process_file`): lets a test prove that a panic in
    // run_job's own setup is contained by `spawn_job`'s guard and the job still
    // finalizes with no file left pending. Compiled out of non-test builds.
    #[cfg(test)]
    if job.files.iter().any(|f| f.path.contains("__FORCE_ORCH_PANIC__")) {
        panic!("forced orchestration panic for test");
    }

    let hb = compress_tools::detect_handbrake();
    let (img, img_kind) = compress_tools::detect_image();
    // ffmpeg is the preferred output verifier (full re-decode); detect it once
    // here even when ImageMagick is the chosen image encoder, since the video
    // pipeline runs on HandBrake and wouldn't otherwise locate ffmpeg.
    let ff = compress_tools::detect_ffmpeg();
    let caps = hb
        .path
        .as_ref()
        .map(|p| compress_tools::detect_handbrake_caps(p))
        .unwrap_or_default();

    // Job-start diagnostics: preset, options, file count and which encoders were
    // detected (path + version) so a "tool missing" outcome later is unambiguous.
    if crate::compress_debug::enabled() {
        let mut l = format!(
            "[job_start] job={} preset={} originalAction={} tag={} files={} concurrency={} encoder={} codec={} useGpu={} zipLevel={} minSizeBytes={}",
            job.id, job.preset, job.original_action.as_str(), job.tag_filename, job.total,
            job.concurrency, job.encoder, job.codec, job.use_gpu, job.zip_level, job.min_size_bytes
        );
        l.push_str(&format!(" handbrake={}", tool_desc(&hb)));
        l.push_str(&format!(" image={}", tool_desc(&img)));
        if let Some(k) = img_kind {
            l.push_str(&format!(" imageKind={}", k.as_str()));
        }
        let hw = compress_tools::probe_gpu_hardware();
        let eff = compress_tools::EffectiveCaps::compute(&caps, hw);
        l.push_str(&format!(
            " gpuCaps=[nvenc:{}/{}/{} qsv:{}/{}/{} vce:{}/{}/{} x265:{}]",
            caps.nvenc_h264, caps.nvenc_h265, caps.nvenc_av1,
            caps.qsv_h264, caps.qsv_h265, caps.qsv_av1,
            caps.vce_h264, caps.vce_h265, caps.vce_av1, caps.x265
        ));
        l.push_str(&format!(
            " adapters=[nvidia:{} intel:{} amd:{}] effectiveGpu=[nvenc:{} qsv:{} vce:{}]",
            hw.nvidia, hw.intel, hw.amd, eff.nvenc, eff.qsv, eff.vce
        ));
        l.push_str(" zip=built-in");
        crate::compress_debug::log(&l);

        // Evidence dump: the exact encoder tokens THIS HandBrake build reports,
        // plus a clear note about how GPU will be attempted. Empty `-h` caps are
        // treated as "unknown": if an adapter is present we still try GPU and rely
        // on the (now loud) per-file fallback to explain any real failure.
        if let Some(p) = hb.path.as_ref() {
            crate::compress_debug::log(&format!(
                "[job_start] handbrake encoders ({}): {}",
                p.display(),
                compress_tools::handbrake_encoders_raw(p)
            ));
            if job.use_gpu && !caps.any_gpu() && eff.any_gpu() {
                crate::compress_debug::log(
                    "[job_start] NOTE: HandBrake -h reported no hardware encoder, but a GPU \
                     adapter is present — FileTree will still ATTEMPT the hardware encoder and, \
                     if it fails, fall back to CPU with the GPU error captured (reason=gpu_fallback).",
                );
            } else if job.use_gpu && !eff.any_gpu() {
                crate::compress_debug::log(
                    "[job_start] WARNING: useGpu requested but no hardware encoder token AND no \
                     GPU adapter were detected. Encoding will use CPU x264/x265. Point \
                     FILETREE_HANDBRAKE at a hardware-capable HandBrakeCLI, or drop one into the \
                     app tools dir, to enable GPU.",
                );
            }
        }
    }

    // Per-job schedule: process the largest (longest-processing) files first for
    // better tail latency, skipping anything a prior run already completed.
    let already_done = job
        .files
        .iter()
        .filter(|f| f.status.lock_recover().as_str() == "done")
        .count();
    let mut schedule: Vec<usize> = (0..job.files.len())
        .filter(|&i| job.files[i].status.lock_recover().as_str() != "done")
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
        let ff = ff.clone();
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
                // Isolate each file: a panic anywhere in the per-file pipeline
                // (e.g. an unexpected slice/parse bug on pathological encoder
                // output) is caught here so it can NEVER kill the worker and
                // abandon the rest of the batch as pending. The offending file is
                // recorded as a per-file internal error and the loop continues.
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    process_and_record(&state, &job, i, &hb, &img, &ff, img_kind, &caps, &counts)
                }));
                let stop = match result {
                    Ok(stop) => stop,
                    Err(payload) => {
                        // Recording the caught panic (manifest write, CSV row,
                        // event emit, a slice on pathological data) runs OUTSIDE
                        // the catch above, so it goes through the panic-proof
                        // recorder: a panic while recording the outcome must NEVER
                        // unwind the worker and remove it from the pool.
                        let msg = panic_message(payload.as_ref());
                        crate::compress_debug::log(&format!(
                            "[panic] job={} #{i} worker caught a panic while processing file: {msg}",
                            job.id
                        ));
                        record_internal_error_guarded(
                            &job,
                            i,
                            &counts,
                            &format!("internal error while processing this file: {msg}"),
                        );
                        false
                    }
                };
                if stop {
                    break;
                }
            }
        }));
    }
    for h in handles {
        let _ = h.join();
    }

    // Reconcile leftovers: with the per-file catch above a worker should never
    // die mid-file, but should one ever leave a file non-terminal (`pending`/
    // `running`) — a thread aborted by something catch_unwind can't intercept, or
    // a future regression — mark it as an internal error so the run NEVER reports
    // a false "done" with files silently abandoned. A cancelled job legitimately
    // leaves files pending, so skip reconciliation then.
    let mut reconciled = 0usize;
    if !job.cancel.load(Ordering::SeqCst) {
        for i in 0..job.files.len() {
            let st = job.files[i].status.lock_recover().clone();
            if st == "pending" || st == "running" {
                record_internal_error_guarded(
                    &job,
                    i,
                    &counts,
                    "worker aborted before this file completed (no per-file outcome was recorded)",
                );
                reconciled += 1;
            }
        }
    }

    let done_count = counts.done.load(Ordering::Relaxed);
    let error_count = counts.error.load(Ordering::Relaxed);
    let skipped_count = counts.skipped.load(Ordering::Relaxed);
    let verify_failed_count = counts.verify_failed.load(Ordering::Relaxed);

    // Post == pre guarantee: every input file must land in exactly one terminal
    // bucket. After the reconcile above (which converts any leftover pending/
    // running file into an error) this must hold for a non-cancelled run; log
    // loudly if it ever doesn't so a silently-abandoned file can't hide.
    let cancelled = job.cancel.load(Ordering::SeqCst);
    if !cancelled {
        let accounted = done_count + skipped_count + error_count;
        if accounted != job.total {
            crate::compress_debug::log(&format!(
                "[reconcile] job={} COUNT MISMATCH: done={done_count} + skipped={skipped_count} + error={error_count} = {accounted} != total={} (reconciled={reconciled})",
                job.id, job.total
            ));
        }
    }
    let status = if cancelled {
        "cancelled"
    } else if reconciled > 0 {
        // A worker aborted and left files behind: the run is incomplete, so report
        // `error` (resumable via Retry) rather than a misleading `done`.
        "error"
    } else if error_count > 0 && done_count == 0 {
        "error"
    } else {
        "done"
    };
    *job.status.lock_recover() = status.to_string();
    write_manifest(&job);

    let total_saved = job.saved_bytes.load(Ordering::Relaxed);
    crate::compress_debug::log(&format!(
        "[job_end] job={} done={done_count} skipped={skipped_count} error={error_count} verifyFailed={verify_failed_count} total={} saved={total_saved} status={status}",
        job.id, job.total
    ));
    job.emit(ev_done(
        &job.id,
        done_count,
        error_count,
        skipped_count,
        verify_failed_count,
        job.total,
        total_saved,
    ));
    job.finished.store(true, Ordering::SeqCst);
    job.events_cv.notify_all();
}

/// Extract a human-readable message from a caught panic payload. `panic!`
/// payloads are usually a `&'static str` or a `String`; anything else is
/// reported generically.
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic".to_string()
    }
}

/// Record a per-file internal error (caught worker panic, or a file reconciled
/// after an aborted worker): set the `FileState` to a terminal `error` with
/// [`Reason::ErrorInternal`], count it, append the CSV/debug rows, emit the live
/// error event, and persist the manifest. Uses poison-tolerant locks so this can
/// safely run after another worker panicked. Idempotent enough for reconcile:
/// only called for files not already terminal.
fn record_internal_error(job: &Arc<CompressJob>, i: usize, counts: &Counts, message: &str) {
    // Test-only one-shot: simulate a panic raised WHILE recording an outcome
    // (e.g. a slice on pathological data deep in the CSV/manifest write). Proves
    // that such a panic — which historically ran outside any catch and unwound
    // the worker — is now contained. One-shot so finalization can still record.
    #[cfg(test)]
    if TEST_RECORD_PANIC_ARMED.swap(false, Ordering::SeqCst) {
        panic!("forced panic while recording outcome (test)");
    }
    let f = &job.files[i];
    let name = file_name_of(&f.path);
    let kind_str = f.kind.as_str();
    let orig = f.orig_bytes.load(Ordering::Relaxed);

    *f.error.lock_recover() = Some(message.to_string());
    *f.status.lock_recover() = "error".to_string();
    *f.reason.lock_recover() = Reason::ErrorInternal.as_str().to_string();
    f.pct.store(0, Ordering::Relaxed);
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
        tool: "",
        codec_params: "",
        duration_ms: 0,
        out_path: "",
        recycled: false,
        error: message,
        reason: Reason::ErrorInternal.as_str(),
        exit_code: None,
        tool_version: "",
        command: "",
        stderr_excerpt: "",
    });
    crate::compress_debug::log(&format!(
        "[file] job={} #{i} path={:?} INTERNAL ERROR reason={} {message}",
        job.id,
        f.path,
        Reason::ErrorInternal.as_str(),
    ));
    job.emit(ev_error(i, &f.path, message, Reason::ErrorInternal.as_str()));
    write_manifest(job);
}

/// Test-only one-shot trigger for [`record_internal_error`] to panic, exercising
/// the "panic while recording the outcome" path.
#[cfg(test)]
pub(crate) static TEST_RECORD_PANIC_ARMED: AtomicBool = AtomicBool::new(false);

/// Panic-proof wrapper around [`record_internal_error`]: recording an outcome
/// (CSV row, manifest write, event emit, or a slice on pathological data) must
/// NEVER unwind the caller — neither a pool worker (removing it from the pool)
/// nor the finalize/reconcile pass (abandoning the rest of the batch). If the
/// rich recording panics, the file is still forced to a terminal `error` so it
/// can never be left pending.
fn record_internal_error_guarded(job: &Arc<CompressJob>, i: usize, counts: &Counts, message: &str) {
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        record_internal_error(job, i, counts, message);
    }));
    if res.is_err() {
        // Last-resort terminal marking with no rich logging (which is what
        // panicked). Poison-tolerant; idempotent enough for the reconcile sweep.
        let f = &job.files[i];
        if matches!(f.status.lock_recover().as_str(), "pending" | "running") {
            *f.error.lock_recover() = Some(message.to_string());
            *f.status.lock_recover() = "error".to_string();
            *f.reason.lock_recover() = Reason::ErrorInternal.as_str().to_string();
            counts.error.fetch_add(1, Ordering::Relaxed);
        }
    }
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
    ff: &compress_tools::ToolInfo,
    img_kind: Option<ImageKind>,
    caps: &HandbrakeCaps,
    counts: &Counts,
) -> bool {
    {
        let f = &job.files[i];
        *f.status.lock_recover() = "running".to_string();
        f.pct.store(0, Ordering::Relaxed);
        let orig = f.orig_bytes.load(Ordering::Relaxed);
        job.emit(ev_file_start(i, &f.path, f.kind, orig));
    }

    let file_start = Instant::now();
    let outcome = process_file(state, job, i, hb, img, ff, img_kind, caps);
    let duration_ms = file_start.elapsed().as_millis() as u64;
    let f = &job.files[i];
    let orig = f.orig_bytes.load(Ordering::Relaxed);
    let name = file_name_of(&f.path);
    let kind_str = f.kind.as_str();
    f.duration_ms.store(duration_ms, Ordering::Relaxed);

    // Fallback tool/params for outcomes that never spawned an encoder; the live
    // path overrides these from the genuine encoder via EncodeMeta.
    let (fallback_tool, fallback_params) =
        pipeline_params(f.kind, &job.preset, img_kind, job.custom_quality, job.custom_max_height);
    let fallback_version = match f.kind {
        FileKind::Video => hb.version.as_deref().unwrap_or(""),
        FileKind::Image => img.version.as_deref().unwrap_or(""),
        FileKind::Other => "built-in",
    };

    let mut stop = false;
    match outcome {
        FileOutcome::Done { out_path, new_bytes, recycled, disposition, disposition_error, tagged, diag, meta } => {
            let tool = if meta.tool.is_empty() { fallback_tool } else { meta.tool.as_str() };
            let codec_params = if meta.codec_params.is_empty() { fallback_params.clone() } else { meta.codec_params.clone() };
            let tool_version = if meta.tool_version.is_empty() { fallback_version } else { meta.tool_version.as_str() };
            // A successful encode that followed a failed GPU attempt is recorded
            // as a distinct `gpu_fallback` outcome, carrying the GPU failure detail
            // so it's never a silent CPU run.
            let reason = if meta.gpu_fallback.is_some() { Reason::GpuFallback } else { Reason::Success };
            let fallback_detail = meta.gpu_fallback.clone().unwrap_or_default();
            f.new_bytes.store(new_bytes, Ordering::Relaxed);
            f.recycled.store(recycled, Ordering::Relaxed);
            *f.disposition.lock_recover() = disposition.to_string();
            *f.out_path.lock_recover() = out_path.clone();
            *f.status.lock_recover() = "done".to_string();
            *f.reason.lock_recover() = reason.as_str().to_string();
            *f.encoder.lock_recover() = codec_params.clone();
            if !fallback_detail.is_empty() {
                *f.error.lock_recover() = Some(fallback_detail.clone());
            }
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
                error: &fallback_detail,
                reason: reason.as_str(),
                exit_code: diag.exit_code,
                tool_version,
                command: &diag.command,
                stderr_excerpt: &diag.stderr_tail,
            });
            log_throughput_debug(&job.id, i, orig, new_bytes, duration_ms, meta.fps);
            log_file_debug(
                &job.id, i, &f.path, kind_str, orig, tool, &diag, &out_path, new_bytes,
                "compressed", reason.as_str(), duration_ms, recycled,
                disposition_error.as_deref(), Some(tagged),
            );
            job.emit(ev_file_done(i, &out_path, orig, new_bytes, saved, recycled, disposition, reason.as_str(), "done"));
        }
        FileOutcome::Skipped { reason, new_bytes, diag, meta } => {
            let tool = if meta.tool.is_empty() { fallback_tool } else { meta.tool.as_str() };
            let codec_params = if meta.codec_params.is_empty() { fallback_params.clone() } else { meta.codec_params.clone() };
            let tool_version = if meta.tool_version.is_empty() { fallback_version } else { meta.tool_version.as_str() };
            f.new_bytes.store(new_bytes, Ordering::Relaxed);
            *f.status.lock_recover() = "skipped".to_string();
            *f.reason.lock_recover() = reason.as_str().to_string();
            *f.encoder.lock_recover() = codec_params.clone();
            f.pct.store(100, Ordering::Relaxed);
            counts.skipped.fetch_add(1, Ordering::Relaxed);
            crate::compress_log::append_row(&crate::compress_log::Row {
                job_id: &job.id,
                index: i,
                path: &f.path,
                name: &name,
                kind: kind_str,
                preset: &job.preset,
                status: reason.as_str(),
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
                reason: reason.as_str(),
                exit_code: diag.exit_code,
                tool_version,
                command: &diag.command,
                stderr_excerpt: &diag.stderr_tail,
            });
            log_file_debug(
                &job.id, i, &f.path, kind_str, orig, tool, &diag, "", new_bytes,
                "skipped", reason.as_str(), duration_ms, false, None, None,
            );
            job.emit(ev_file_done(i, "", orig, new_bytes, 0, false, "", reason.as_str(), "skipped"));
        }
        FileOutcome::Error { reason, message, diag, meta } => {
            let tool = if meta.tool.is_empty() { fallback_tool } else { meta.tool.as_str() };
            let codec_params = if meta.codec_params.is_empty() { fallback_params.clone() } else { meta.codec_params.clone() };
            let tool_version = if meta.tool_version.is_empty() { fallback_version } else { meta.tool_version.as_str() };
            *f.error.lock_recover() = Some(message.clone());
            *f.status.lock_recover() = "error".to_string();
            *f.reason.lock_recover() = reason.as_str().to_string();
            *f.encoder.lock_recover() = codec_params.clone();
            counts.error.fetch_add(1, Ordering::Relaxed);
            if reason == Reason::ErrorVerifyFailed {
                counts.verify_failed.fetch_add(1, Ordering::Relaxed);
            }
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
            // Always persist a compact entry for FAILURES (even when verbose debug
            // logging is off): a failing encode is exactly what a user needs the
            // log for. Rotation still caps growth.
            if !crate::compress_debug::enabled() {
                let tail = safe_tail(diag.stderr_tail.trim(), 600).replace(['\r', '\n'], " ");
                crate::compress_debug::log_force(&format!(
                    "[file_error] job={} #{i} path={:?} kind={kind_str} reason={} exit={} msg={:?}{}{}",
                    job.id,
                    f.path,
                    reason.as_str(),
                    diag.exit_code.map(|c| c.to_string()).unwrap_or_else(|| "-".to_string()),
                    message,
                    if diag.command.is_empty() { String::new() } else { format!(" cmd={:?}", diag.command) },
                    if tail.trim().is_empty() { String::new() } else { format!(" stderr_tail={:?}", tail.trim()) },
                ));
            }
            job.emit(ev_error(i, &f.path, &message, reason.as_str()));
        }
        FileOutcome::Cancelled => {
            *f.status.lock_recover() = "pending".to_string();
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
    /// The original was below the user's minimum-size threshold, so no encode was
    /// attempted (too small to meaningfully compress; e.g. a very short video).
    SkippedTooSmall,
    /// The required external encoder (HandBrake / ffmpeg / ImageMagick) is missing.
    ErrorToolMissing,
    /// The file kind has no supported pipeline. Reserved in the taxonomy; the
    /// current pipelines route every kind (other files always zip).
    #[allow(dead_code)]
    ErrorUnsupported,
    /// The encoder ran but exited non-zero (carries exit code + stderr tail).
    ErrorEncoder,
    /// The source could not be read as a valid video: HandBrake's scan phase
    /// found no readable title (e.g. `moov atom not found` / `unrecognized file
    /// type` / `0 valid title(s)` / `No title found`). This is a corrupt or
    /// incomplete source (commonly a partial/failed download), NOT an encoder or
    /// argument fault. The original is untouched (an encode failure keeps it).
    ErrorUnreadableInput,
    /// The encoder reported success but produced a missing/empty output.
    ErrorOutputEmpty,
    /// The source file no longer exists (commonly recycled by a prior run).
    ErrorSourceMissing,
    /// The source is a cloud-only placeholder (OneDrive etc.) whose data isn't
    /// downloaded locally; skipped to avoid forcing a (possibly huge) hydration.
    ErrorCloudPlaceholder,
    /// The encoder process could not be spawned at all.
    ErrorSpawn,
    /// An unexpected internal error (a caught panic in the worker, or a file left
    /// non-terminal by an aborted worker). Recorded per-file so one bad file can
    /// never silently abandon the rest of the batch.
    ErrorInternal,
    /// The encode "succeeded" and was smaller, but the produced output failed the
    /// deep-verify gate (re-decode / CRC). The corrupt output was deleted and the
    /// ORIGINAL was preserved untouched — so this is fully resumable via Retry.
    ErrorVerifyFailed,
    /// Compressed successfully, but only after a GPU encode failed and the file
    /// fell back to the CPU encoder. The GPU failure detail is carried in the
    /// file's error/message field for visibility.
    GpuFallback,
}

impl Reason {
    /// Stable snake_case code used in the CSV `reason` column, the debug log and
    /// the UI badge/tooltip mapping.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Reason::Success => "success",
            Reason::SkippedNoGain => "skipped_no_gain",
            Reason::SkippedTooSmall => "skipped_too_small",
            Reason::ErrorToolMissing => "error_tool_missing",
            Reason::ErrorUnsupported => "error_unsupported",
            Reason::ErrorEncoder => "error_encoder",
            Reason::ErrorUnreadableInput => "error_unreadable_input",
            Reason::ErrorOutputEmpty => "error_output_empty",
            Reason::ErrorSourceMissing => "error_source_missing",
            Reason::ErrorCloudPlaceholder => "error_cloud_placeholder",
            Reason::ErrorSpawn => "error_spawn",
            Reason::ErrorInternal => "error_internal",
            Reason::ErrorVerifyFailed => "error_verify_failed",
            Reason::GpuFallback => "gpu_fallback",
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
    /// Set when a hardware (GPU) encode failed and the file was re-encoded on the
    /// CPU. Carries a human description of the GPU failure (the failed `-e` token,
    /// exit code, and a tail of HandBrake's stderr) so "VRAM rose but nothing
    /// encoded" surfaces as a concrete, visible reason instead of a silent CPU run.
    gpu_fallback: Option<String>,
}

/// Result of one file's pipeline. Every terminal arm carries the [`EncodeDiag`]
/// captured during the encode (empty for outcomes that never spawned a tool, e.g.
/// a missing source or a missing encoder) plus, for errors, the precise reason.
enum FileOutcome {
    Done {
        out_path: String,
        new_bytes: u64,
        /// True only when the original was actually sent to the Recycle Bin
        /// (back-compat with the CSV/manifest `recycled` column + `file_done`).
        recycled: bool,
        /// What actually happened to the original: `"recycled"`, `"deleted"`, or
        /// `"kept"`. Distinct from the requested action (a failed Recycle/Delete
        /// degrades to `"kept"` with `disposition_error` set).
        disposition: &'static str,
        disposition_error: Option<String>,
        tagged: bool,
        diag: EncodeDiag,
        meta: EncodeMeta,
    },
    /// Output produced but not smaller than the original (deleted, original kept).
    /// Output not produced or not smaller; `reason` distinguishes a no-gain skip
    /// from a too-small (below threshold) skip. Original untouched.
    Skipped { reason: Reason, new_bytes: u64, diag: EncodeDiag, meta: EncodeMeta },
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

/// Whether `path` is a cloud-only placeholder whose contents aren't present
/// locally (OneDrive "online-only" / Files On-Demand, or any provider using the
/// same attributes). Checking metadata does NOT trigger hydration; only reading
/// the data would. Returns false off Windows.
#[cfg(windows)]
pub(crate) fn is_dehydrated_cloud_file(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_OFFLINE: u32 = 0x1000;
    const FILE_ATTRIBUTE_RECALL_ON_OPEN: u32 = 0x0004_0000;
    const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    match std::fs::metadata(path) {
        Ok(m) => {
            let a = m.file_attributes();
            a & (FILE_ATTRIBUTE_OFFLINE
                | FILE_ATTRIBUTE_RECALL_ON_OPEN
                | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS)
                != 0
        }
        Err(_) => false,
    }
}

#[cfg(not(windows))]
pub(crate) fn is_dehydrated_cloud_file(_path: &Path) -> bool {
    false
}

/// Pre-skip heuristic for image/video inputs: returns a reason string when an
/// encode is very unlikely to shrink the file, so the encoder is never spawned.
/// Extension-only (no media probe), deliberately conservative so a genuinely
/// compressible file is never skipped:
/// - any image already smaller than 32 KiB,
/// - an image already in an efficient codec (AVIF/HEIC/WebP) AND under 2 MiB,
/// - any video already smaller than 1 MiB.
fn media_pre_skip(kind: FileKind, path: &Path, orig: u64) -> Option<&'static str> {
    if orig == 0 {
        return None;
    }
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match kind {
        FileKind::Image => {
            const IMAGE_MIN_BYTES: u64 = 32 * 1024;
            const EFFICIENT_IMAGE_CAP: u64 = 2 * 1024 * 1024;
            if orig < IMAGE_MIN_BYTES {
                Some("image already small")
            } else if matches!(ext.as_str(), "avif" | "heic" | "webp")
                && orig < EFFICIENT_IMAGE_CAP
            {
                Some("already an efficient image codec")
            } else {
                None
            }
        }
        FileKind::Video => {
            const VIDEO_MIN_BYTES: u64 = 1024 * 1024;
            if orig < VIDEO_MIN_BYTES {
                Some("video already small")
            } else {
                None
            }
        }
        FileKind::Other => None,
    }
}

fn process_file(
    state: &Arc<AppState>,
    job: &Arc<CompressJob>,
    index: usize,
    hb: &compress_tools::ToolInfo,
    img: &compress_tools::ToolInfo,
    ff: &compress_tools::ToolInfo,
    img_kind: Option<ImageKind>,
    caps: &HandbrakeCaps,
) -> FileOutcome {
    let (input_str, kind) = {
        let f = &job.files[index];
        (f.path.clone(), f.kind)
    };
    // Test-only fault injection: lets a unit test drive a GENUINE per-file panic
    // through the real `run_job` worker pool (not a hand-rolled mirror) to prove
    // the `catch_unwind` isolation records it as an internal error and the pool
    // keeps going. Compiled out of all release/non-test builds.
    #[cfg(test)]
    if input_str.contains("__FORCE_PANIC__") {
        panic!("forced per-file panic for test (path={input_str})");
    }
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
    // Cloud-only placeholder (OneDrive et al.): the file exists as a stub but its
    // data isn't local. Reading it would force a (possibly huge) download, and on
    // a metered/offline connection the encode would just stall or fail. Skip it
    // with an actionable message rather than silently hydrating gigabytes.
    if is_dehydrated_cloud_file(&input) {
        return FileOutcome::Error {
            reason: Reason::ErrorCloudPlaceholder,
            message:
                "source is a cloud-only placeholder (not downloaded locally); skipped to avoid forcing a download. Set it to \"Always keep on this device\" and retry."
                    .to_string(),
            diag: EncodeDiag::default(),
            meta: EncodeMeta::default(),
        };
    }
    let orig = job.files[index].orig_bytes.load(Ordering::Relaxed);

    // Minimum-size threshold: a file below the user's minimum is too small to
    // meaningfully compress (especially a video with too few frames), so skip it
    // BEFORE any encode work — no probe, no encoder, output untouched. Recorded
    // as a terminal `skipped` (SkippedTooSmall) so it flows into the same skipped
    // bucket the post==pre count reconciliation relies on.
    if job.min_size_bytes > 0 && orig < job.min_size_bytes {
        let mut meta = EncodeMeta::default();
        meta.tool = match kind {
            FileKind::Video => "handbrake",
            FileKind::Image => "ffmpeg",
            FileKind::Other => "zip",
        }
        .to_string();
        meta.tool_version = "pre-skip".to_string();
        meta.codec_params = format!("pre-skip: below min size ({orig} < {})", job.min_size_bytes);
        return FileOutcome::Skipped {
            reason: Reason::SkippedTooSmall,
            new_bytes: orig,
            diag: EncodeDiag {
                command: format!("pre-skip (below min size {} bytes)", job.min_size_bytes),
                exit_code: Some(0),
                stderr_tail: String::new(),
            },
            meta,
        };
    }

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
            reason: Reason::SkippedNoGain,
            new_bytes: orig,
            diag: EncodeDiag { command: "pre-skip (already compressed)".to_string(), exit_code: Some(0), stderr_tail: String::new() },
            meta,
        };
    }

    // Pre-skip heuristic for media: avoid spawning an encoder when a shrink is
    // very unlikely — an image already in an efficient codec, or media already
    // small enough that the encode overhead (and the real risk of growing it)
    // isn't worth it. Recorded as a no-gain skip (same outcome the post-encode
    // size check would produce) but without the wasted encode.
    if let Some(reason) = media_pre_skip(kind, &input, orig) {
        let mut meta = EncodeMeta::default();
        meta.tool = if kind == FileKind::Video { "handbrake" } else { "ffmpeg" }.to_string();
        meta.tool_version = "pre-skip".to_string();
        meta.codec_params = format!("pre-skip: {reason}");
        return FileOutcome::Skipped {
            reason: Reason::SkippedNoGain,
            new_bytes: orig,
            diag: EncodeDiag {
                command: format!("pre-skip ({reason})"),
                exit_code: Some(0),
                stderr_tail: String::new(),
            },
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
                // A scan-phase failure (no readable title) is a corrupt/incomplete
                // INPUT, not an encoder fault — classify it distinctly so the UI is
                // truthful and the user knows to re-download rather than retry.
                if is_unreadable_input_stderr(&diag.stderr_tail) {
                    return FileOutcome::Error {
                        reason: Reason::ErrorUnreadableInput,
                        message: format!(
                            "video is corrupt or incomplete (no readable title) — the source may be a partial/failed download — {}",
                            encoder_error_message(&diag)
                        ),
                        diag,
                        meta,
                    };
                }
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
        return FileOutcome::Skipped { reason: Reason::SkippedNoGain, new_bytes, diag, meta };
    }

    // Deep-verify gate (HARD): re-decode / CRC-check the produced output BEFORE
    // any disposition of the original. A "successful" encoder exit + smaller size
    // is not proof the bytes are intact — a truncated container, a half-written
    // file, or a corrupt zip can all slip past the size check. If verification
    // fails we delete the bad output, leave the original untouched, and report a
    // resumable error so a good original is NEVER removed behind a broken copy.
    match verify_output(job, index, &out, kind, &input, hb, ff, img, img_kind) {
        Verify::Ok => {}
        Verify::Cancelled => {
            let _ = std::fs::remove_file(&out);
            return FileOutcome::Cancelled;
        }
        Verify::Failed(detail) => {
            let _ = std::fs::remove_file(&out);
            return FileOutcome::Error {
                reason: Reason::ErrorVerifyFailed,
                message: format!("compressed output failed integrity verification: {detail}"),
                diag,
                meta,
            };
        }
    }

    let out_str = out.to_string_lossy().into_owned();

    // [COMPRESSED] sidecar metadata tag keyed to the new path (the filename
    // already carries the [COMPRESSED] suffix; media re-encodes also embed a
    // container comment where the tool supports it).
    let tagged = job.tag_filename;
    if tagged {
        add_compressed_tag(&out_str);
    }

    // Audit the compress, then dispose of the original per the requested action.
    // This only runs AFTER verification passed, so the original is never removed
    // behind a corrupt output.
    let src_vec = [input_str.clone()];
    crate::audit::record(crate::audit::Entry {
        op: "compress",
        src: &src_vec,
        dst: &out_str,
        by: "server",
        ..Default::default()
    });

    // Tri-state disposition of the verified original.
    //  - Recycle: send to the Recycle Bin (recoverable).
    //  - Delete:  permanent removal via std::fs (no Shell API), irreversible.
    //  - Keep:    leave the original in place alongside the new file.
    // A failed Recycle/Delete is non-fatal: the compressed file is still good, so
    // the file is reported Done but the original is recorded as "kept" with the
    // error surfaced. `recycled` (the legacy bool) is true only on a real recycle.
    let mut recycled = false;
    let mut disposition: &'static str = "kept";
    let mut disposition_error: Option<String> = None;
    match job.original_action {
        OriginalAction::Recycle => match crate::recycle::recycle_path(&input) {
            Ok(()) => {
                recycled = true;
                disposition = "recycled";
                crate::audit::record(crate::audit::Entry {
                    op: "recycle",
                    disposition: "recycle",
                    src: &src_vec,
                    by: "server",
                    ..Default::default()
                });
            }
            Err(e) => {
                disposition_error = Some(e.to_string());
                crate::audit::record(crate::audit::Entry {
                    op: "recycle",
                    disposition: "recycle",
                    src: &src_vec,
                    error: Some(&e.to_string()),
                    by: "server",
                    ..Default::default()
                });
            }
        },
        OriginalAction::Delete => match crate::recycle::delete_permanent(&input) {
            Ok(()) => {
                disposition = "deleted";
                crate::audit::record(crate::audit::Entry {
                    op: "delete",
                    disposition: "delete",
                    src: &src_vec,
                    by: "server",
                    ..Default::default()
                });
            }
            Err(e) => {
                disposition_error = Some(e.to_string());
                crate::audit::record(crate::audit::Entry {
                    op: "delete",
                    disposition: "delete",
                    src: &src_vec,
                    error: Some(&e.to_string()),
                    by: "server",
                    ..Default::default()
                });
            }
        },
        OriginalAction::Keep => {
            disposition = "kept";
        }
    }

    // The parent directory's tree changed (new file, possibly recycled/deleted
    // original).
    if let Some(parent) = input.parent() {
        state
            .scan_cache
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .invalidate(&parent.to_string_lossy());
    }

    FileOutcome::Done { out_path: out_str, new_bytes, recycled, disposition, disposition_error, tagged, diag, meta }
}

// ── Deep output verification (the post-encode integrity gate) ─────────────────

/// Result of [`verify_output`].
enum Verify {
    /// Output decoded / CRC-checked clean.
    Ok,
    /// Output is corrupt/incomplete; carries a human-readable detail.
    Failed(String),
    /// The job was cancelled during verification.
    Cancelled,
}

/// Captured result of a short verification subprocess.
struct VerifyRun {
    cancelled: bool,
    /// False when the helper couldn't even be spawned (tool absent).
    spawned: bool,
    success: bool,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Spawn a verification helper (`ffmpeg`/`HandBrakeCLI`/`magick`) as the job's
/// active child for `index` so a cancel kills it, capturing BOTH stdout and
/// stderr to the end. Unlike [`run_child`] it keeps stdout (tools like
/// `identify` print results there) and emits no progress events. Respects the
/// job cancel flag while polling.
fn run_verify_capture(job: &Arc<CompressJob>, index: usize, mut cmd: Command) -> VerifyRun {
    use std::io::Read;
    use std::process::Stdio;
    compress_tools::no_window(&mut cmd);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => {
            return VerifyRun {
                cancelled: false,
                spawned: false,
                success: false,
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
            };
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    job.children.lock_recover().insert(index, child);

    let out_handle = stdout.map(|mut pipe| {
        std::thread::spawn(move || {
            let mut s = Vec::new();
            let _ = pipe.read_to_end(&mut s);
            s
        })
    });
    let err_handle = stderr.map(|mut pipe| {
        std::thread::spawn(move || {
            let mut s = Vec::new();
            let _ = pipe.read_to_end(&mut s);
            s
        })
    });

    let mut cancelled = false;
    let exit_status: Option<std::process::ExitStatus> = loop {
        if job.cancel.load(Ordering::SeqCst) {
            if let Some(c) = job.children.lock_recover().get_mut(&index) {
                let _ = c.kill();
            }
            cancelled = true;
            break None;
        }
        let poll = {
            let mut guard = job.children.lock_recover();
            match guard.get_mut(&index) {
                None => break None,
                Some(c) => match c.try_wait() {
                    Ok(Some(st)) => Some(st),
                    Ok(None) => None,
                    Err(_) => break None,
                },
            }
        };
        match poll {
            Some(st) => break Some(st),
            None => std::thread::sleep(std::time::Duration::from_millis(40)),
        }
    };
    if let Some(mut c) = job.children.lock_recover().remove(&index) {
        let _ = c.wait();
    }
    let stdout = out_handle.map(|h| h.join().unwrap_or_default()).unwrap_or_default();
    let stderr = err_handle.map(|h| h.join().unwrap_or_default()).unwrap_or_default();
    let (success, exit_code) = match exit_status {
        Some(st) => (st.success(), st.code()),
        None => (false, None),
    };
    VerifyRun {
        cancelled,
        spawned: true,
        success,
        exit_code,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    }
}

/// Deep-verify a just-produced compressed output BEFORE the original is disposed
/// of. Re-decodes media (ffmpeg, falling back to a HandBrake `--scan`), decodes
/// images (ImageMagick `identify -regard-warnings`, falling back to ffmpeg) and
/// confirms dimensions match the original, and CRC-checks zip archives. Returns
/// [`Verify::Failed`] with a detail on any integrity problem, [`Verify::Cancelled`]
/// if the job was cancelled, else [`Verify::Ok`]. When no suitable verifier tool
/// is available it accepts (it can't *prove* corruption) rather than blocking an
/// otherwise-valid run.
#[allow(clippy::too_many_arguments)]
fn verify_output(
    job: &Arc<CompressJob>,
    index: usize,
    out: &Path,
    kind: FileKind,
    orig: &Path,
    hb: &compress_tools::ToolInfo,
    ff: &compress_tools::ToolInfo,
    img: &compress_tools::ToolInfo,
    img_kind: Option<ImageKind>,
) -> Verify {
    if job.cancel.load(Ordering::SeqCst) {
        return Verify::Cancelled;
    }
    match kind {
        FileKind::Video => verify_media(job, index, out, orig, ff, hb),
        FileKind::Image => verify_image(job, index, out, orig, ff, img, img_kind),
        // Audio also routes here (classified Other) and so flows through the same
        // archive CRC check as every other zipped file — coherent and complete.
        FileKind::Other => match crate::archive::verify_archive(out) {
            Ok(()) => Verify::Ok,
            Err(e) => Verify::Failed(format!("zip CRC/structure check failed: {e}")),
        },
    }
}

/// Verify a re-encoded video by full re-decode. ffmpeg is preferred
/// (`-v error -xerror -i <out> -f null -`): any non-zero exit OR any stderr is a
/// failure. Without ffmpeg, a HandBrake `--scan` must report at least one title.
/// On success the probed duration is sanity-checked against the original.
fn verify_media(
    job: &Arc<CompressJob>,
    index: usize,
    out: &Path,
    orig: &Path,
    ff: &compress_tools::ToolInfo,
    hb: &compress_tools::ToolInfo,
) -> Verify {
    if let Some(ffmpeg) = ff.path.as_ref() {
        let mut cmd = Command::new(ffmpeg);
        cmd.args(["-v", "error", "-xerror", "-i"]).arg(out).args(["-f", "null", "-"]);
        let run = run_verify_capture(job, index, cmd);
        if run.cancelled {
            return Verify::Cancelled;
        }
        if run.spawned {
            if !run.success {
                return Verify::Failed(format!(
                    "ffmpeg re-decode exited {}: {}",
                    run.exit_code.map(|c| c.to_string()).unwrap_or_else(|| "signal".into()),
                    safe_tail(run.stderr.trim(), 400)
                ));
            }
            let errtail = run.stderr.trim();
            if !errtail.is_empty() {
                return Verify::Failed(format!("ffmpeg reported decode errors: {}", safe_tail(errtail, 400)));
            }
            // Duration sanity check (best-effort: only fails on a clear mismatch).
            if let (Some(od), Some(nd)) = (
                probe_duration_secs(job, index, ffmpeg, orig),
                probe_duration_secs(job, index, ffmpeg, out),
            ) {
                if od > 0.5 {
                    let diff = (od - nd).abs();
                    let tol = (od * 0.05).max(2.0);
                    if diff > tol {
                        return Verify::Failed(format!(
                            "output duration {nd:.1}s differs from original {od:.1}s beyond tolerance ({tol:.1}s)"
                        ));
                    }
                }
            }
            return Verify::Ok;
        }
    }
    // ffmpeg unavailable → HandBrake scan title check.
    if let Some(hbp) = hb.path.as_ref() {
        let mut cmd = Command::new(hbp);
        cmd.args(["--scan", "-i"]).arg(out).args(["-t", "0"]);
        let run = run_verify_capture(job, index, cmd);
        if run.cancelled {
            return Verify::Cancelled;
        }
        if run.spawned {
            let combined = format!("{}\n{}", run.stdout, run.stderr);
            if handbrake_scan_title_count(&combined) >= 1 {
                return Verify::Ok;
            }
            return Verify::Failed("HandBrake scan found no valid title in the output".to_string());
        }
    }
    // No media verifier available: cannot prove corruption, so accept.
    Verify::Ok
}

/// Verify a re-encoded image by decoding it and confirming its dimensions match
/// the original. Uses ImageMagick `identify -regard-warnings` when it is the
/// chosen tool, otherwise an ffmpeg decode + dimension probe.
#[allow(clippy::too_many_arguments)]
fn verify_image(
    job: &Arc<CompressJob>,
    index: usize,
    out: &Path,
    orig: &Path,
    ff: &compress_tools::ToolInfo,
    img: &compress_tools::ToolInfo,
    img_kind: Option<ImageKind>,
) -> Verify {
    if let (Some(ImageKind::ImageMagick), Some(magick)) = (img_kind, img.path.as_ref()) {
        let nd = match magick_identify_dims(job, index, magick, out) {
            Ok(d) => d,
            Err(e) if e == "cancelled" => return Verify::Cancelled,
            Err(e) => return Verify::Failed(format!("ImageMagick rejected output: {e}")),
        };
        let od = magick_identify_dims(job, index, magick, orig).ok().flatten();
        return match (od, nd) {
            (Some(o), Some(n)) if o != n => Verify::Failed(format!(
                "output dimensions {}x{} != original {}x{}",
                n.0, n.1, o.0, o.1
            )),
            _ => Verify::Ok,
        };
    }
    if let Some(ffmpeg) = ff.path.as_ref() {
        let mut cmd = Command::new(ffmpeg);
        cmd.args(["-v", "error", "-xerror", "-i"]).arg(out).args(["-f", "null", "-"]);
        let run = run_verify_capture(job, index, cmd);
        if run.cancelled {
            return Verify::Cancelled;
        }
        if run.spawned {
            if !run.success || !run.stderr.trim().is_empty() {
                return Verify::Failed(format!(
                    "ffmpeg image decode failed: {}",
                    safe_tail(run.stderr.trim(), 400)
                ));
            }
            if let (Some(o), Some(n)) = (
                ffmpeg_image_dims(job, index, ffmpeg, orig),
                ffmpeg_image_dims(job, index, ffmpeg, out),
            ) {
                if o != n {
                    return Verify::Failed(format!(
                        "output dimensions {}x{} != original {}x{}",
                        n.0, n.1, o.0, o.1
                    ));
                }
            }
            return Verify::Ok;
        }
    }
    Verify::Ok
}

/// Run `magick identify -regard-warnings -format "%w %h"` on `file`. A corrupt
/// image trips a warning that `-regard-warnings` promotes to a non-zero exit.
/// Returns the parsed `(width, height)` of the first frame, `Ok(None)` if dims
/// couldn't be parsed (still a clean decode), or `Err` on failure/cancel.
fn magick_identify_dims(
    job: &Arc<CompressJob>,
    index: usize,
    magick: &Path,
    file: &Path,
) -> Result<Option<(u64, u64)>, String> {
    let mut cmd = Command::new(magick);
    cmd.arg("identify").arg("-regard-warnings").args(["-format", "%w %h\\n"]).arg(file);
    let run = run_verify_capture(job, index, cmd);
    if run.cancelled {
        return Err("cancelled".to_string());
    }
    if !run.spawned {
        return Err("could not start ImageMagick identify".to_string());
    }
    if !run.success {
        return Err(format!(
            "identify exit {}: {}",
            run.exit_code.map(|c| c.to_string()).unwrap_or_else(|| "signal".into()),
            safe_tail(run.stderr.trim(), 300)
        ));
    }
    Ok(parse_dims_pair(&run.stdout))
}

/// Probe image dimensions with `ffmpeg -hide_banner -i <file>` (parsed from the
/// Video stream line). Best-effort; `None` when unavailable/unparseable.
fn ffmpeg_image_dims(
    job: &Arc<CompressJob>,
    index: usize,
    ffmpeg: &Path,
    file: &Path,
) -> Option<(u64, u64)> {
    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-hide_banner").arg("-i").arg(file);
    let run = run_verify_capture(job, index, cmd);
    if run.cancelled || !run.spawned {
        return None;
    }
    parse_stream_dims(&run.stderr)
}

/// Probe a media file's duration in seconds via `ffmpeg -hide_banner -i <file>`
/// (ffmpeg exits non-zero with no output specified, but still prints the
/// `Duration:` line we parse). Best-effort; `None` when unavailable/unparseable.
fn probe_duration_secs(
    job: &Arc<CompressJob>,
    index: usize,
    ffmpeg: &Path,
    file: &Path,
) -> Option<f64> {
    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-hide_banner").arg("-i").arg(file);
    let run = run_verify_capture(job, index, cmd);
    if run.cancelled || !run.spawned {
        return None;
    }
    parse_ffmpeg_duration(&run.stderr)
}

/// Parse `Duration: HH:MM:SS.ss` out of ffmpeg's stderr into seconds.
fn parse_ffmpeg_duration(s: &str) -> Option<f64> {
    let idx = s.find("Duration:")?;
    let rest = s[idx + "Duration:".len()..].trim_start();
    let token: String = rest.chars().take_while(|c| !c.is_whitespace() && *c != ',').collect();
    if token.starts_with("N/A") {
        return None;
    }
    let parts: Vec<&str> = token.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h: f64 = parts[0].parse().ok()?;
    let m: f64 = parts[1].parse().ok()?;
    let sec: f64 = parts[2].parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + sec)
}

/// Parse the first `WxH` from an ffmpeg `Video:` stream line in stderr.
fn parse_stream_dims(s: &str) -> Option<(u64, u64)> {
    for line in s.lines() {
        if !line.contains("Video:") {
            continue;
        }
        for tok in line.split(|c: char| c == ' ' || c == ',' || c == '[' || c == '(') {
            if let Some((w, h)) = tok.split_once('x') {
                let h_digits: String = h.chars().take_while(|c| c.is_ascii_digit()).collect();
                if let (Ok(w), Ok(h)) = (w.parse::<u64>(), h_digits.parse::<u64>()) {
                    if w > 0 && h > 0 {
                        return Some((w, h));
                    }
                }
            }
        }
    }
    None
}

/// Parse `"<w> <h>"` (first line) from `identify` output.
fn parse_dims_pair(s: &str) -> Option<(u64, u64)> {
    let line = s.lines().find(|l| !l.trim().is_empty())?;
    let mut it = line.split_whitespace();
    let w: u64 = it.next()?.parse().ok()?;
    let h: u64 = it.next()?.parse().ok()?;
    Some((w, h))
}

/// Count HandBrake `--scan` titles from its log output (one `+ title N:` header
/// per detected title).
fn handbrake_scan_title_count(s: &str) -> usize {
    s.lines().filter(|l| l.trim_start().starts_with("+ title ")).count()
}

/// Return at most the last `max` bytes of `s`, snapped UP to the nearest UTF-8
/// char boundary so the slice can never split a multi-byte codepoint. Encoder
/// stderr routinely contains non-ASCII (localized messages, accented file names),
/// so naive `&s[s.len()-max..]` slicing panics — and a panic here used to poison
/// a shared lock and cascade across the whole worker pool.
fn safe_tail(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut start = s.len() - max;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

/// Detect a HandBrake/ffmpeg scan-phase failure in an encoder's stderr tail: a
/// corrupt or incomplete source with no readable title (commonly a partial or
/// failed download), as opposed to an encoder or argument fault. Matches the
/// known signatures case-insensitively. Pure so it is unit-testable.
fn is_unreadable_input_stderr(stderr_tail: &str) -> bool {
    let t = stderr_tail.to_ascii_lowercase();
    const SIGNATURES: [&str; 4] = [
        "no title found",
        "0 valid title",
        "unrecognized file type",
        "moov atom not found",
    ];
    SIGNATURES.iter().any(|s| t.contains(s))
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
            format!("…{}", safe_tail(tail, 400))
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

    let hw = compress_tools::probe_gpu_hardware();
    let mut enc = select_video_encoder(&job.encoder, &job.codec, job.use_gpu, caps, hw);
    // Up-front token validation for CPU/software encoders (x265, svt_av1): if the
    // installed build doesn't expose the chosen token, downgrade to x264 now
    // rather than spawning a doomed encode. GPU tokens are deliberately left
    // alone — they may be "assumed" from a detected adapter even when absent from
    // the `-h` parse, and a genuine runtime GPU failure is still caught by the
    // GPU→CPU fallback below. The two layers compose.
    if !enc.is_gpu {
        let valid = validate_encoder_token(&enc.hb, caps);
        if valid != enc.hb {
            crate::compress_debug::log(&format!(
                "[encoder_validate] job={} #{index} encoder '{}' not supported by this HandBrake build; using x264",
                job.id, enc.hb
            ));
            enc.hb = valid.to_string();
        }
    }
    let result = run_handbrake(job, index, hb, input, out, &job.preset, &enc, meta);

    // GPU encode failed → retry once on CPU, capturing WHY the GPU failed so it
    // becomes a visible `gpu_fallback` outcome (real HandBrake stderr) instead of
    // a silent CPU run. A spawn failure of the GPU attempt is also a fallback.
    if enc.is_gpu {
        let gpu_failure: Option<String> = match &result {
            EncodeResult::Done { success: false, diag, .. } => {
                Some(format!(
                    "GPU encoder {} failed ({}); fell back to CPU{}",
                    enc.hb,
                    match diag.exit_code {
                        Some(c) => format!("exit {c}"),
                        None => "no exit code".to_string(),
                    },
                    fallback_stderr_suffix(&diag.stderr_tail),
                ))
            }
            EncodeResult::Spawn { error, .. } => {
                Some(format!("GPU encoder {} could not start ({error}); fell back to CPU", enc.hb))
            }
            _ => None,
        };
        if let Some(detail) = gpu_failure {
            crate::compress_debug::log(&format!(
                "[gpu_fallback] job={} #{index} {detail}",
                job.id
            ));
            meta.gpu_fallback = Some(detail);
            let _ = std::fs::remove_file(out);
            // Fall back to the CPU software encoder for the chosen codec, itself
            // validated against the build (e.g. svt_av1 → x264 when SVT-AV1 isn't
            // present) so the fallback can't be doomed too.
            let mut cpu = cpu_fallback_encoder(&job.codec, caps);
            let valid = validate_encoder_token(&cpu.hb, caps);
            if valid != cpu.hb {
                crate::compress_debug::log(&format!(
                    "[encoder_validate] job={} #{index} CPU fallback '{}' not supported; using x264",
                    job.id, cpu.hb
                ));
                cpu.hb = valid.to_string();
            }
            // run_handbrake overwrites meta.codec_params with the CPU encoder, so
            // `meta` ends up reflecting the genuine encoder actually used.
            return run_handbrake(job, index, hb, input, out, &job.preset, &cpu, meta);
        }
    }
    result
}

/// The CPU software encoder to retry on after a GPU encode fails, chosen by the
/// job's target codec: SVT-AV1 for AV1, x265 for H.265 when the build supports
/// it (else x264), x264 otherwise. Always a CPU lane, never GPU — this is the
/// guaranteed-available fallback.
fn cpu_fallback_encoder(codec: &str, caps: &HandbrakeCaps) -> VideoEncoder {
    VideoEncoder {
        hb: if codec == "av1" {
            "svt_av1".to_string()
        } else if codec == "h265" && caps.x265 {
            "x265".to_string()
        } else {
            "x264".to_string()
        },
        lane: CompressLane::VideoCpu,
        is_gpu: false,
    }
}

/// Compact, single-line suffix of a GPU encoder's stderr tail for the
/// `gpu_fallback` message (the full tail still reaches the CSV/debug log).
fn fallback_stderr_suffix(tail: &str) -> String {
    let t = tail.trim();
    if t.is_empty() {
        return String::new();
    }
    let snippet = safe_tail(t, 300);
    format!(" — {}", snippet.replace(['\r', '\n'], " ").trim())
}

/// True when `out`'s extension is in the MP4 family (mp4/m4v/mov), the only
/// containers whose muxer accepts HandBrake's `--optimize` (faststart) flag.
/// MKV/WebM/AVI etc. reject it, so it must be gated on this.
fn is_mp4_family(out: &Path) -> bool {
    matches!(
        out.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("mp4") | Some("m4v") | Some("mov")
    )
}

/// Whether a HandBrake `-e` token is supported by the installed build, per the
/// detected caps. `x264` is the always-present software baseline (HandBrake
/// always ships it), so it is the guaranteed-valid fallback. An unknown token is
/// treated as unsupported so the caller downgrades rather than spawning a doomed
/// encode. NOTE: GPU tokens here reflect the `-h` parse only; the caller applies
/// this check to CPU tokens and leaves GPU attempts to the runtime GPU→CPU
/// fallback (so an "assumed from adapter" GPU encode is still attempted).
fn encoder_token_supported(token: &str, caps: &HandbrakeCaps) -> bool {
    match token {
        "x264" => true,
        "x265" => caps.x265,
        "svt_av1" => caps.svt_av1,
        "nvenc_h264" => caps.nvenc_h264,
        "nvenc_h265" => caps.nvenc_h265,
        "nvenc_av1" => caps.nvenc_av1,
        "qsv_h264" => caps.qsv_h264,
        "qsv_h265" => caps.qsv_h265,
        "qsv_av1" => caps.qsv_av1,
        "vce_h264" => caps.vce_h264,
        "vce_h265" => caps.vce_h265,
        "vce_av1" => caps.vce_av1,
        _ => false,
    }
}

/// Resolve a chosen `-e` token to one the build actually supports: returns the
/// token unchanged when supported, else `x264` (the guaranteed-available CPU
/// baseline). Pure so it is unit-testable.
fn validate_encoder_token<'a>(token: &'a str, caps: &HandbrakeCaps) -> &'a str {
    if encoder_token_supported(token, caps) { token } else { "x264" }
}

/// Assemble the HandBrake CLI argument vector for one encode. PURE (no spawn) so
/// the argument logic is unit-testable without HandBrake installed.
///
/// `minimal` produces the guaranteed-valid retry arg set used after a
/// first-attempt non-zero exit: input/output/encoder/quality/preset plus a
/// downscale only when one is requested — and crucially NO audio, `--optimize`,
/// or `--encopts` flags (the arg families most prone to compatibility drift).
///
/// In the normal (non-minimal) set the audio block uses passthrough with an AAC
/// fallback and DOES NOT pass a global `-B` bitrate alongside `-E copy` (that
/// combination is invalid and HandBrake rejects it at job setup — the v1.13.0
/// regression that failed every video). `--optimize` is emitted only for
/// MP4-family outputs.
fn build_handbrake_args(
    input: &Path,
    out: &Path,
    encoder: &str,
    quality: &str,
    enc_preset: &str,
    max_height: Option<&str>,
    is_gpu: bool,
    cpu_threads: Option<usize>,
    minimal: bool,
) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    let push = |a: &mut Vec<String>, s: &str| a.push(s.to_string());
    push(&mut a, "-i");
    a.push(input.to_string_lossy().into_owned());
    push(&mut a, "-o");
    a.push(out.to_string_lossy().into_owned());
    push(&mut a, "-e");
    push(&mut a, encoder);
    push(&mut a, "-q");
    push(&mut a, quality);
    push(&mut a, "--encoder-preset");
    push(&mut a, enc_preset);

    if !minimal {
        // Audio: re-encode every track to 160 kbps AAC. This is the proven
        // pre-v1.13.0 behavior — the audio savings are what tip an
        // already-compressed video net-smaller once NVENC leaves the video stream
        // roughly size-neutral. v1.13.0 switched to `-E copy` passthrough, which
        // removed those savings and made files finish as no-gain; we restore the
        // re-encode here. `-B` IS valid with a real encoder (`av_aac`) — it is
        // only invalid alongside `-E copy` (the v1.13.4 crash fix). A flat 160k
        // can marginally grow audio already below 160k, which matches the
        // long-working pre-regression behavior and is acceptable.
        push(&mut a, "-E");
        push(&mut a, "av_aac");
        push(&mut a, "-B");
        push(&mut a, "160");
        // --optimize (mp4 faststart) is MP4/M4V/MOV-only.
        if is_mp4_family(out) {
            push(&mut a, "--optimize");
        }
        if !is_gpu {
            if let Some(t) = cpu_threads {
                // CPU tuning: let x264/x265 use the box's threads (the lane cap
                // bounds concurrent encodes, so this won't oversubscribe).
                push(&mut a, "--encopts");
                a.push(format!("threads={t}"));
            }
        }
    }
    if let Some(h) = max_height {
        push(&mut a, "--maxHeight");
        push(&mut a, h);
        push(&mut a, "--keep-display-aspect");
    }
    a
}

/// Whether a first encode attempt should be retried with the minimal arg set:
/// only when it ran to completion but exited non-zero AND the job wasn't
/// cancelled. A spawn failure (missing binary) or a cancel is never retried.
/// Pure so the retry trigger is unit-testable without spawning HandBrake.
fn should_retry_minimal(result: &EncodeResult, cancelled: bool) -> bool {
    matches!(result, EncodeResult::Done { success: false, .. }) && !cancelled
}

/// HandBrake video pipeline for a resolved encoder. Presets map to a quality
/// (RF/CQ/ICQ) + optional downscale + `--encoder-preset`; progress + fps are
/// parsed from the encoder output. Acquires the encoder's global-budget lane for
/// the duration of the encode (released on return). On a non-zero first exit it
/// retries ONCE with a minimal, guaranteed-valid arg set (no audio/optimize/
/// encopts flags) so any future arg-compatibility drift degrades to a plain
/// encode instead of a hard failure.
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
    let (quality, max_height, enc_preset) =
        video_quality(&enc.hb, preset, job.custom_quality, job.custom_max_height);
    let max_height = max_height.as_deref();

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

    let cpu_threads = if enc.is_gpu {
        None
    } else {
        Some(std::thread::available_parallelism().map(|c| c.get()).unwrap_or(4))
    };
    let args = build_handbrake_args(
        input, out, &enc.hb, &quality, enc_preset, max_height, enc.is_gpu, cpu_threads, false,
    );
    let mut cmd = Command::new(hb);
    cmd.args(&args);
    let result = run_child(job, index, cmd);

    // Retry once with the minimal arg set if the first attempt exited non-zero
    // (and we weren't cancelled). This strips exactly the audio/optimize/encopts
    // families most likely to be rejected by an arg-compat mismatch, so a build
    // that chokes on them still produces a plain encode instead of failing.
    if should_retry_minimal(&result, job.cancel.load(Ordering::Relaxed)) {
        crate::compress_debug::log(&format!(
            "[hb_retry] job={} #{index} first attempt exited non-zero; retrying with minimal args (encoder={})",
            job.id, enc.hb
        ));
        let _ = std::fs::remove_file(out);
        let margs = build_handbrake_args(
            input, out, &enc.hb, &quality, enc_preset, max_height, enc.is_gpu, None, true,
        );
        let mut cmd2 = Command::new(hb);
        cmd2.args(&margs);
        return run_child(job, index, cmd2);
    }
    result
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
        "more" => ("9", Some("1600")),
        "high" => ("3", None),
        _ => ("6", Some("1920")), // balanced (and custom, video-only scope)
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
        "more" => ("72", Some("2560000@")),
        "high" => ("92", None),
        _ => ("80", Some("3686400@")), // balanced (and custom, video-only scope)
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

/// Epoch milliseconds (monotonic-enough for inactivity bookkeeping).
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Maximum time an encoder child may produce NO output before it is treated as
/// hung and killed. A real HandBrake/ffmpeg encode emits progress to stderr
/// continuously (sub-second), and even the scan phase is chatty, so a multi-
/// minute silence means the child is stuck on a pathological/corrupt input
/// (HandBrake can spin forever on some truncated streams instead of exiting).
/// Without this watchdog such a child blocks its worker FOREVER; after
/// `concurrency` hung files every worker is stuck, the pool stops, and the job
/// never finalizes — the whole batch is abandoned mid-run. Generous by default
/// (10 min) so it can never kill a legitimately-progressing encode; overridable
/// via `FILETREE_ENCODE_INACTIVITY_MS` (used by tests to shrink it).
fn encode_inactivity_limit_ms() -> u64 {
    std::env::var("FILETREE_ENCODE_INACTIVITY_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(10 * 60 * 1000)
}

/// Spawn `cmd` as the job's active child, drain stdout silently, parse `%`
/// progress from stderr, and poll until exit or cancellation. The child handle
/// is stored on the job so `cancel` can `kill()` it. A per-file inactivity
/// watchdog kills a child that produces NO output for
/// [`encode_inactivity_limit_ms`] (a hung/corrupt input), so a single bad file
/// can never permanently remove its worker from the pool.
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
    job.children.lock_recover().insert(index, child);

    // Last time the child produced ANY output, in epoch ms. The reader threads
    // bump it on every chunk; the poll loop kills the child if it goes silent for
    // longer than the inactivity limit (a hung/corrupt input).
    let last_activity = Arc::new(AtomicU64::new(now_ms()));

    // Drain stdout so the pipe can never fill and block the child.
    let out_handle = stdout.map(|mut pipe| {
        let last_activity = Arc::clone(&last_activity);
        std::thread::spawn(move || {
            use std::io::Read;
            let mut buf = [0u8; 8192];
            loop {
                match pipe.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => last_activity.store(now_ms(), Ordering::Relaxed),
                }
            }
        })
    });

    // Parse percentage + fps from stderr (HandBrake/ffmpeg both report there) and
    // accumulate a bounded tail of the non-progress lines so a failure can be
    // explained. The thread returns the captured tail + parsed fps.
    let err_handle = stderr.map(|pipe| {
        let job = Arc::clone(job);
        let last_activity = Arc::clone(&last_activity);
        std::thread::spawn(move || read_progress(pipe, &job, index, &last_activity))
    });

    // Poll for completion / cancellation / inactivity. Track the real exit status
    // so the exit code can be recorded.
    let inactivity_limit = encode_inactivity_limit_ms();
    let mut cancelled = false;
    let mut timed_out = false;
    let exit_status: Option<std::process::ExitStatus> = loop {
        if job.cancel.load(Ordering::SeqCst) {
            if let Some(c) = job.children.lock_recover().get_mut(&index) {
                let _ = c.kill();
            }
            cancelled = true;
            break None;
        }
        // Inactivity watchdog: a child that has produced no output for longer
        // than the limit is stuck on a pathological input. Kill it so its worker
        // is freed and the file ends as a terminal error instead of hanging the
        // whole pool forever.
        if now_ms().saturating_sub(last_activity.load(Ordering::Relaxed)) > inactivity_limit {
            if let Some(c) = job.children.lock_recover().get_mut(&index) {
                let _ = c.kill();
            }
            timed_out = true;
            break None;
        }
        let poll = {
            let mut guard = job.children.lock_recover();
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
    if let Some(mut c) = job.children.lock_recover().remove(&index) {
        let _ = c.wait();
    }
    if let Some(h) = out_handle {
        let _ = h.join();
    }
    let (mut stderr_tail, fps) = err_handle
        .map(|h| h.join().unwrap_or_default())
        .unwrap_or_default();

    if cancelled {
        return EncodeResult::Cancelled;
    }
    if timed_out {
        // A hung child: report a terminal, non-success encode (the worker
        // continues to the next file). The note is appended so the failure is
        // explained in the CSV/debug logs.
        let secs = inactivity_limit / 1000;
        let note = format!(
            "[filetree] encoder produced no output for {secs}s and was killed as a likely hang (corrupt or unreadable input)"
        );
        stderr_tail = if stderr_tail.trim().is_empty() {
            note
        } else {
            format!("{stderr_tail}\n{note}")
        };
        return EncodeResult::Done {
            success: false,
            diag: EncodeDiag { command, exit_code: None, stderr_tail },
            fps,
        };
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
fn read_progress<R: std::io::Read>(
    mut pipe: R,
    job: &Arc<CompressJob>,
    index: usize,
    last_activity: &AtomicU64,
) -> (String, Option<f64>) {
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
        // Any output resets the inactivity watchdog: the child is alive and
        // working, so it must not be killed as a hang.
        last_activity.store(now_ms(), Ordering::Relaxed);
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
    push_json_string(&mut s, &job.status.lock_recover());
    s.push_str(",\"preset\":");
    push_json_string(&mut s, &job.preset);
    s.push_str(",\"originalAction\":");
    push_json_string(&mut s, job.original_action.as_str());
    // Keep the legacy boolean too so a downgraded/older reader still honors the
    // recoverable-vs-destroy intent (Delete maps to recycle=false there).
    s.push_str(",\"recycleOriginals\":");
    s.push_str(if matches!(job.original_action, OriginalAction::Recycle) { "true" } else { "false" });
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
    s.push_str(",\"minSizeBytes\":");
    s.push_str(&job.min_size_bytes.to_string());
    s.push_str(",\"customMaxHeight\":");
    s.push_str(&job.custom_max_height.to_string());
    s.push_str(",\"customQuality\":");
    s.push_str(&job.custom_quality.to_string());
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
    push_json_string(s, &f.status.lock_recover());
    s.push_str(",\"pct\":");
    s.push_str(&f.pct.load(Ordering::Relaxed).to_string());
    s.push_str(",\"origBytes\":");
    s.push_str(&f.orig_bytes.load(Ordering::Relaxed).to_string());
    s.push_str(",\"newBytes\":");
    s.push_str(&f.new_bytes.load(Ordering::Relaxed).to_string());
    s.push_str(",\"recycled\":");
    s.push_str(if f.recycled.load(Ordering::Relaxed) { "true" } else { "false" });
    s.push_str(",\"disposition\":");
    push_json_string(s, &f.disposition.lock_recover());
    s.push_str(",\"outPath\":");
    push_json_string(s, &f.out_path.lock_recover());
    s.push_str(",\"error\":");
    match f.error.lock_recover().as_ref() {
        Some(e) => push_json_string(s, e),
        None => s.push_str("null"),
    }
    // Enriched per-file outcome fields so interrupted/old runs show precise
    // results in the In Progress tab without re-reading the CSV log.
    let orig = f.orig_bytes.load(Ordering::Relaxed);
    let newb = f.new_bytes.load(Ordering::Relaxed);
    let saved = orig.saturating_sub(newb);
    s.push_str(",\"reason\":");
    push_json_string(s, &f.reason.lock_recover());
    s.push_str(",\"encoder\":");
    push_json_string(s, &f.encoder.lock_recover());
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
    push_json_string(&mut s, &job.status.lock_recover());
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
            let disposition = f.get("disposition").and_then(|v| v.as_str()).unwrap_or("");
            let recycled = f.get("recycled").and_then(|v| v.as_bool()).unwrap_or(false);
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
            s.push_str(",\"disposition\":");
            push_json_string(&mut s, disposition);
            s.push_str(",\"recycled\":");
            s.push_str(if recycled { "true" } else { "false" });
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
    /// Subset of `errors`: outputs rejected by the deep-verify gate (original
    /// preserved). Surfaced so UI totals can sum to `total` while distinguishing
    /// a corrupt-output rejection from other failures.
    verify_failed: usize,
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
    let (mut done, mut errors, mut skipped, mut verify_failed) = (0usize, 0usize, 0usize, 0usize);
    for f in &job.files {
        match f.status.lock_recover().as_str() {
            "done" => done += 1,
            "error" => {
                errors += 1;
                if f.reason.lock_recover().as_str() == Reason::ErrorVerifyFailed.as_str() {
                    verify_failed += 1;
                }
            }
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
        status: job.status.lock_recover().clone(),
        preset: job.preset.clone(),
        total,
        done,
        errors,
        skipped,
        verify_failed,
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
    let (mut done, mut errors, mut skipped, mut verify_failed) = (0usize, 0usize, 0usize, 0usize);
    if let Some(files) = files {
        for f in files {
            match f.get("status").and_then(|v| v.as_str()).unwrap_or("pending") {
                "done" => done += 1,
                "error" => {
                    errors += 1;
                    if f.get("reason").and_then(|v| v.as_str()) == Some(Reason::ErrorVerifyFailed.as_str()) {
                        verify_failed += 1;
                    }
                }
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
        verify_failed,
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
    s.push_str(",\"verifyFailed\":");
    s.push_str(&j.verify_failed.to_string());
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
        let jobs = state.compress_jobs.lock_recover();
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
    disposition: &str,
    reason: &str,
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
    s.push_str(",\"disposition\":");
    push_json_string(&mut s, disposition);
    s.push_str(",\"reason\":");
    push_json_string(&mut s, reason);
    s.push_str(",\"status\":");
    push_json_string(&mut s, status);
    s.push_str("}\n");
    s
}

fn ev_error(index: usize, path: &str, error: &str, reason: &str) -> String {
    let mut s = String::from("{\"type\":\"error\",\"index\":");
    s.push_str(&index.to_string());
    s.push_str(",\"path\":");
    push_json_string(&mut s, path);
    s.push_str(",\"error\":");
    push_json_string(&mut s, error);
    s.push_str(",\"reason\":");
    push_json_string(&mut s, reason);
    s.push_str("}\n");
    s
}

fn ev_done(
    id: &str,
    done: usize,
    errors: usize,
    skipped: usize,
    verify_failed: usize,
    total: usize,
    saved: u64,
) -> String {
    let mut s = String::from("{\"type\":\"done\",\"jobId\":");
    push_json_string(&mut s, id);
    s.push_str(",\"done\":");
    s.push_str(&done.to_string());
    s.push_str(",\"errors\":");
    s.push_str(&errors.to_string());
    s.push_str(",\"skipped\":");
    s.push_str(&skipped.to_string());
    s.push_str(",\"verifyFailed\":");
    s.push_str(&verify_failed.to_string());
    s.push_str(",\"total\":");
    s.push_str(&total.to_string());
    s.push_str(",\"savedBytes\":");
    s.push_str(&saved.to_string());
    s.push_str("}\n");
    s
}

#[cfg(test)]
mod encoder_tests {
    use super::*;
    use crate::compress_tools::{GpuHardware, HandbrakeCaps};

    fn no_gpu() -> GpuHardware {
        GpuHardware::default()
    }

    #[test]
    fn av1_falls_back_to_svt_av1_without_hw_token() {
        // No AV1 -h token and no GPU adapter ⇒ CPU SVT-AV1, regardless of use_gpu.
        let caps = HandbrakeCaps::default();
        let enc = select_video_encoder("auto", "av1", true, &caps, &no_gpu());
        assert_eq!(enc.hb, "svt_av1");
        assert!(!enc.is_gpu);
    }

    #[test]
    fn av1_uses_nvenc_av1_when_token_present() {
        let caps = HandbrakeCaps { nvenc_av1: true, ..Default::default() };
        let enc = select_video_encoder("auto", "av1", true, &caps, &no_gpu());
        assert_eq!(enc.hb, "nvenc_av1");
        assert!(enc.is_gpu);
    }

    #[test]
    fn av1_adapter_without_token_stays_cpu() {
        // A recent-ish requirement: a mere NVIDIA adapter must NOT imply AV1 HW
        // support (only newer GPUs encode AV1), so AV1 stays on CPU here.
        let caps = HandbrakeCaps::default();
        let hw = GpuHardware { nvidia: true, ..Default::default() };
        let enc = select_video_encoder("auto", "av1", true, &caps, &hw);
        assert_eq!(enc.hb, "svt_av1");
        assert!(!enc.is_gpu);
    }

    #[test]
    fn h264_adapter_inference_still_attempts_gpu() {
        // H.264/H.265 keep the lenient adapter-based inference.
        let caps = HandbrakeCaps::default();
        let hw = GpuHardware { nvidia: true, ..Default::default() };
        let enc = select_video_encoder("auto", "h264", true, &caps, &hw);
        assert_eq!(enc.hb, "nvenc_h264");
        assert!(enc.is_gpu);
    }

    #[test]
    fn explicit_x264_or_no_gpu_is_cpu() {
        let caps = HandbrakeCaps { x265: true, ..Default::default() };
        let hw = GpuHardware { nvidia: true, ..Default::default() };
        assert_eq!(select_video_encoder("x264", "h264", true, &caps, &hw).hb, "x264");
        assert_eq!(select_video_encoder("auto", "h265", false, &caps, &hw).hb, "x265");
    }

    #[test]
    fn cpu_fallback_encoder_by_codec() {
        // The GPU→CPU fallback never returns a GPU encoder and maps each codec to
        // its guaranteed CPU software encoder.
        let no_x265 = HandbrakeCaps::default();
        let with_x265 = HandbrakeCaps { x265: true, ..Default::default() };

        let av1 = cpu_fallback_encoder("av1", &no_x265);
        assert_eq!(av1.hb, "svt_av1");
        assert!(!av1.is_gpu);

        // H.265 only uses x265 when the build actually supports it; else x264.
        assert_eq!(cpu_fallback_encoder("h265", &with_x265).hb, "x265");
        assert_eq!(cpu_fallback_encoder("h265", &no_x265).hb, "x264");

        let h264 = cpu_fallback_encoder("h264", &with_x265);
        assert_eq!(h264.hb, "x264");
        assert!(!h264.is_gpu);
    }

    #[test]
    fn handbrake_args_audio_reencode_aac_160() {
        use std::path::Path;
        // Restored pre-v1.13.0 behavior: audio is RE-ENCODED to 160k AAC (the
        // savings that tip an already-compressed video net-smaller), NOT passed
        // through. `-B` is valid here because it accompanies a real encoder
        // (av_aac) — it is only invalid alongside `-E copy`.
        let args = build_handbrake_args(
            Path::new("in.mkv"), Path::new("out.mkv"), "x264", "24", "medium",
            None, false, Some(8), false,
        );
        // `-E av_aac` is immediately followed by `-B 160`.
        let e_pos = args.iter().position(|a| a == "-E").expect("-E present");
        assert_eq!(args[e_pos + 1], "av_aac", "audio encoder is av_aac (re-encode)");
        assert_eq!(args[e_pos + 2], "-B");
        assert_eq!(args[e_pos + 3], "160");
        // The old passthrough form is gone.
        assert!(!args.iter().any(|a| a == "copy"), "audio must not be passthrough");
        assert!(!args.iter().any(|a| a == "--audio-copy-mask"));
        // --optimize remains mp4-family-only (mkv output ⇒ absent).
        assert!(!args.iter().any(|a| a == "--optimize"), "mkv output gets no --optimize");
    }

    #[test]
    fn video_quality_more_and_custom_presets() {
        // "More savings": CPU RF 27 / GPU CQ 29, both capped at 720p.
        let (q, h, p) = video_quality("x264", "more", 0, 0);
        assert_eq!(q, "27");
        assert_eq!(h.as_deref(), Some("720"));
        assert_eq!(p, "medium");
        let (q, h, p) = video_quality("nvenc_h264", "more", 0, 0);
        assert_eq!(q, "29");
        assert_eq!(h.as_deref(), Some("720"));
        assert_eq!(p, "quality");
        // SVT-AV1 "more" uses speed 8.
        let (_, _, p) = video_quality("svt_av1", "more", 0, 0);
        assert_eq!(p, "8");

        // Custom honors the supplied quality + height; GPU adds +2.
        let (q, h, p) = video_quality("x264", "custom", 22, 1440);
        assert_eq!(q, "22");
        assert_eq!(h.as_deref(), Some("1440"));
        assert_eq!(p, "medium");
        let (q, h, _) = video_quality("nvenc_h264", "custom", 22, 1440);
        assert_eq!(q, "24"); // +2 for GPU
        assert_eq!(h.as_deref(), Some("1440"));
        // Custom height 0 ⇒ original (no cap); quality 0 ⇒ default 26.
        let (q, h, _) = video_quality("x264", "custom", 0, 0);
        assert_eq!(q, "26");
        assert_eq!(h, None);
        // Custom SVT-AV1 uses speed 7.
        let (_, _, p) = video_quality("svt_av1", "custom", 0, 0);
        assert_eq!(p, "7");
    }

    #[test]
    fn normalize_preset_accepts_more_and_custom() {
        assert_eq!(normalize_preset("more"), "more");
        assert_eq!(normalize_preset("custom"), "custom");
        assert_eq!(normalize_preset("max"), "max");
        assert_eq!(normalize_preset("balanced"), "balanced");
        assert_eq!(normalize_preset("high"), "high");
        // Junk still falls back to the safe default.
        assert_eq!(normalize_preset("nonsense"), "balanced");
        assert_eq!(normalize_preset(""), "balanced");
    }

    #[test]
    fn handbrake_args_optimize_only_for_mp4_family() {
        use std::path::Path;
        let has_optimize = |out: &str| {
            build_handbrake_args(
                Path::new("in.x"), Path::new(out), "x264", "24", "medium", None, false, Some(4), false,
            )
            .iter()
            .any(|a| a == "--optimize")
        };
        // MP4 family (case-insensitive) gets faststart; others must not.
        assert!(has_optimize("v.mp4"));
        assert!(has_optimize("v.m4v"));
        assert!(has_optimize("v.MOV"));
        assert!(!has_optimize("v.mkv"));
        assert!(!has_optimize("v.webm"));
        assert!(!has_optimize("v.avi"));
        assert!(!has_optimize("v"));
    }

    #[test]
    fn handbrake_minimal_args_strip_audio_optimize_encopts() {
        use std::path::Path;
        // The retry arg set is the guaranteed-valid minimum: encoder/quality/preset
        // and (when downscaling) maxHeight — but no audio, optimize, or encopts.
        let args = build_handbrake_args(
            Path::new("in.mp4"), Path::new("out.mp4"), "x264", "24", "medium",
            Some("1080"), false, Some(8), true,
        );
        assert!(!args.iter().any(|a| a == "-E"), "minimal set has no audio flags");
        assert!(!args.iter().any(|a| a == "--optimize"), "minimal set has no --optimize");
        assert!(!args.iter().any(|a| a == "--encopts"), "minimal set has no --encopts");
        assert!(args.windows(2).any(|w| w[0] == "-e" && w[1] == "x264"));
        assert!(args.windows(2).any(|w| w[0] == "-q" && w[1] == "24"));
        assert!(args.windows(2).any(|w| w[0] == "--encoder-preset" && w[1] == "medium"));
        // Downscale is preserved (it's correctness, not a risky flag family).
        assert!(args.windows(2).any(|w| w[0] == "--maxHeight" && w[1] == "1080"));
        assert!(args.iter().any(|a| a == "--keep-display-aspect"));
    }

    #[test]
    fn handbrake_cpu_threads_only_when_present_and_cpu() {
        use std::path::Path;
        // GPU encodes never get --encopts threads; CPU encodes do when a count is given.
        let gpu = build_handbrake_args(
            Path::new("i.mp4"), Path::new("o.mp4"), "nvenc_h264", "26", "quality", None, true, None, false,
        );
        assert!(!gpu.iter().any(|a| a == "--encopts"));
        let cpu = build_handbrake_args(
            Path::new("i.mp4"), Path::new("o.mp4"), "x264", "24", "medium", None, false, Some(6), false,
        );
        assert!(cpu.windows(2).any(|w| w[0] == "--encopts" && w[1] == "threads=6"));
    }

    #[test]
    fn unsupported_encoder_token_resolves_to_x264() {
        // x264 is the always-present baseline; svt_av1/x265 depend on the build.
        let bare = HandbrakeCaps::default();
        assert_eq!(validate_encoder_token("x264", &bare), "x264");
        assert_eq!(validate_encoder_token("svt_av1", &bare), "x264", "no SVT-AV1 in build");
        assert_eq!(validate_encoder_token("x265", &bare), "x264", "no x265 in build");
        assert_eq!(validate_encoder_token("totally_unknown", &bare), "x264");
        // Supported tokens pass through unchanged.
        let rich = HandbrakeCaps { x265: true, svt_av1: true, nvenc_h264: true, ..Default::default() };
        assert_eq!(validate_encoder_token("x265", &rich), "x265");
        assert_eq!(validate_encoder_token("svt_av1", &rich), "svt_av1");
        assert_eq!(validate_encoder_token("nvenc_h264", &rich), "nvenc_h264");
    }

    #[test]
    fn scan_failure_stderr_classifies_as_unreadable_input() {
        // A real corrupt/incomplete download produces a HandBrake scan failure
        // (moov atom → unrecognized type → 0 valid titles → no title), which must
        // map to the dedicated unreadable-input reason, not a generic encoder fault.
        let sample = "libav: moov atom not found\n\
                      Unrecognized file type\n\
                      No title found.\n";
        assert!(is_unreadable_input_stderr(sample));
        assert_eq!(
            if is_unreadable_input_stderr(sample) { Reason::ErrorUnreadableInput } else { Reason::ErrorEncoder }.as_str(),
            "error_unreadable_input",
        );
        // Case-insensitive + each signature on its own triggers.
        assert!(is_unreadable_input_stderr("MOOV ATOM NOT FOUND"));
        assert!(is_unreadable_input_stderr("scan: 0 valid title(s) found"));
        assert!(is_unreadable_input_stderr("hb_scan: unrecognized file type"));
        // A genuine encoder error (e.g. a codec/preset gripe) is NOT misclassified.
        assert!(!is_unreadable_input_stderr("x264 [error]: invalid preset 'bogus'"));
        assert!(!is_unreadable_input_stderr(""));
    }

    #[test]
    fn minimal_retry_triggers_only_on_noncancelled_nonzero_exit() {
        let fail = EncodeResult::Done { success: false, diag: EncodeDiag::default(), fps: None };
        let ok = EncodeResult::Done { success: true, diag: EncodeDiag::default(), fps: None };
        let spawn = EncodeResult::Spawn { error: "x".into(), command: "y".into() };
        // Non-zero exit, not cancelled → retry.
        assert!(should_retry_minimal(&fail, false));
        // Cancelled, or success, or spawn failure → never retry.
        assert!(!should_retry_minimal(&fail, true));
        assert!(!should_retry_minimal(&ok, false));
        assert!(!should_retry_minimal(&spawn, false));
        assert!(!should_retry_minimal(&EncodeResult::Cancelled, false));
    }

    #[test]
    fn media_pre_skip_rules() {
        use std::path::Path;
        // Efficient codec under the cap → skipped; large stays.
        assert!(media_pre_skip(FileKind::Image, Path::new("a.webp"), 500 * 1024).is_some());
        assert!(media_pre_skip(FileKind::Image, Path::new("a.webp"), 8 * 1024 * 1024).is_none());
        // Tiny image of any type → skipped.
        assert!(media_pre_skip(FileKind::Image, Path::new("a.png"), 4 * 1024).is_some());
        // Normal JPEG → not skipped.
        assert!(media_pre_skip(FileKind::Image, Path::new("a.jpg"), 800 * 1024).is_none());
        // Small video → skipped; larger video → not.
        assert!(media_pre_skip(FileKind::Video, Path::new("a.mp4"), 500 * 1024).is_some());
        assert!(media_pre_skip(FileKind::Video, Path::new("a.mp4"), 50 * 1024 * 1024).is_none());
        // Zero size is unknown → never pre-skip.
        assert!(media_pre_skip(FileKind::Image, Path::new("a.webp"), 0).is_none());
    }
}

/// Integration tests for the manifest persistence + resume round-trip. These
/// drive the real [`write_manifest`] / [`job_from_manifest`] pair through a
/// temporary `APPDATA`/`HOME` so the on-disk `jobs/` directory is isolated.
#[cfg(test)]
mod manifest_tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// `jobs_dir()` reads `APPDATA`/`HOME` at call time, and Rust runs tests in
    /// the same process concurrently, so env-mutating tests must be serialized.
    static ENV_LOCK: StdMutex<()> = StdMutex::new(());

    /// Env var that `jobs_dir()` keys off on this platform.
    const HOME_VAR: &str = if cfg!(windows) { "APPDATA" } else { "HOME" };

    /// Point `jobs_dir()` at a fresh temp directory and return it. The returned
    /// guard restores the previous env value on drop.
    fn redirect_home() -> (PathBuf, EnvGuard) {
        let prev = std::env::var_os(HOME_VAR);
        let dir = std::env::temp_dir().join(format!(
            "ft-manifest-test-{}-{}",
            std::process::id(),
            new_job_id()
        ));
        std::fs::create_dir_all(&dir).expect("temp home");
        // SAFETY: serialized by ENV_LOCK; no other thread reads/writes env here.
        unsafe { std::env::set_var(HOME_VAR, &dir) };
        (dir, EnvGuard { prev })
    }

    struct EnvGuard {
        prev: Option<std::ffi::OsString>,
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            // SAFETY: serialized by ENV_LOCK.
            unsafe {
                match &self.prev {
                    Some(v) => std::env::set_var(HOME_VAR, v),
                    None => std::env::remove_var(HOME_VAR),
                }
            }
        }
    }

    #[test]
    fn manifest_round_trip_preserves_options() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (home, _restore) = redirect_home();

        let opts = CompressOptions {
            original_action: OriginalAction::Delete,
            tag_filename: true,
            concurrency: 4,
            encoder: "qsv".to_string(),
            use_gpu: false,
            codec: "h265".to_string(),
            zip_level: 3,
            min_size_bytes: 2_000_000,
            custom_max_height: 720,
            custom_quality: 28,
        };
        let job = create_job(
            &["a.mp4".to_string(), "b.png".to_string(), "c.txt".to_string()],
            "high",
            &opts,
        );
        write_manifest(&job);

        let back = job_from_manifest(&job.id).expect("manifest reloads");
        assert_eq!(back.preset, "high");
        assert_eq!(back.original_action, OriginalAction::Delete);
        assert_eq!(back.min_size_bytes, 2_000_000);
        assert!(back.tag_filename);
        assert_eq!(back.concurrency, 4);
        assert_eq!(back.encoder, "qsv");
        assert!(!back.use_gpu);
        assert_eq!(back.codec, "h265");
        assert_eq!(back.zip_level, 3);
        assert_eq!(back.custom_max_height, 720);
        assert_eq!(back.custom_quality, 28);
        assert_eq!(back.total, 3);
        // Kinds survive the round-trip.
        assert_eq!(back.files[0].kind, FileKind::Video);
        assert_eq!(back.files[1].kind, FileKind::Image);
        assert_eq!(back.files[2].kind, FileKind::Other);

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn resume_preserves_done_resets_rest_and_carries_saved() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (home, _restore) = redirect_home();

        let job = create_job(
            &["v.mp4".to_string(), "i.png".to_string()],
            "balanced",
            &CompressOptions::default(),
        );
        // Simulate file 0 having completed in a prior (interrupted) run.
        *job.files[0].status.lock().unwrap() = "done".to_string();
        job.files[0].orig_bytes.store(1000, Ordering::Relaxed);
        job.files[0].new_bytes.store(400, Ordering::Relaxed);
        job.files[0].recycled.store(true, Ordering::Relaxed);
        *job.files[0].out_path.lock().unwrap() = "v.mp4".to_string();
        *job.files[0].reason.lock().unwrap() = "success".to_string();
        *job.files[0].encoder.lock().unwrap() = "x264".to_string();
        // File 1 was still mid-flight: mark it running so we prove it resets.
        *job.files[1].status.lock().unwrap() = "running".to_string();
        write_manifest(&job);

        let back = job_from_manifest(&job.id).expect("manifest reloads");
        // Done file is preserved verbatim and skipped on resume.
        assert_eq!(*back.files[0].status.lock().unwrap(), "done");
        assert_eq!(back.files[0].new_bytes.load(Ordering::Relaxed), 400);
        assert!(back.files[0].recycled.load(Ordering::Relaxed));
        assert_eq!(*back.files[0].reason.lock().unwrap(), "success");
        assert_eq!(*back.files[0].encoder.lock().unwrap(), "x264");
        // The not-yet-done file is reset to pending so the worker re-runs it.
        assert_eq!(*back.files[1].status.lock().unwrap(), "pending");
        // Saved bytes from the completed file are carried into the resumed job.
        assert_eq!(back.saved_bytes.load(Ordering::Relaxed), 600);

        let _ = std::fs::remove_dir_all(&home);
    }

    /// The core regression test for the 116→39 halt: a worker that panics WHILE
    /// HOLDING a shared lock (the exact poisoning scenario) must not take the
    /// pool down. The panicking file is recorded as a per-file internal error and
    /// every other file in the batch still completes — and the poisoned shared
    /// lock is still usable by the other workers (recovered, not propagated).
    #[test]
    fn panicking_file_does_not_halt_batch() {
        use std::panic::AssertUnwindSafe;
        use std::sync::atomic::{AtomicUsize, Ordering as O};
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (home, _restore) = redirect_home();

        // Three files; index 1 will panic mid-processing. Real files aren't
        // needed (we drive the loop directly), but give them sizes so the run is
        // representative.
        let job = create_job(
            &["a.bin".to_string(), "b.bin".to_string(), "c.bin".to_string()],
            "balanced",
            &CompressOptions::default(),
        );
        for f in &job.files {
            f.orig_bytes.store(10, Ordering::Relaxed);
        }

        let counts = Arc::new(Counts::default());
        let schedule = Arc::new(vec![0usize, 1, 2]);
        let cursor = Arc::new(AtomicUsize::new(0));

        // This mirrors run_job's worker loop (catch_unwind + record_internal_error)
        // exactly, exercising the real resilience helpers.
        let mut handles = Vec::new();
        for _ in 0..3 {
            let job = Arc::clone(&job);
            let counts = Arc::clone(&counts);
            let schedule = Arc::clone(&schedule);
            let cursor = Arc::clone(&cursor);
            handles.push(std::thread::spawn(move || loop {
                let k = cursor.fetch_add(1, O::Relaxed);
                if k >= schedule.len() {
                    break;
                }
                let i = schedule[k];
                let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                    let f = &job.files[i];
                    *f.status.lock_recover() = "running".to_string();
                    if i == 1 {
                        // Panic WHILE holding the shared events lock → poisons it.
                        // The old `.lock().expect(...)` everywhere else would then
                        // cascade-panic; `lock_recover` must keep the pool alive.
                        let _held = job.events.lock_recover();
                        panic!("boom while holding events lock");
                    }
                    // A normal success path also touches the shared events lock.
                    job.emit(ev_file_done(i, "", 10, 10, 0, false, "", "success", "done"));
                    *f.status.lock_recover() = "done".to_string();
                    counts.done.fetch_add(1, O::Relaxed);
                }));
                if let Err(payload) = result {
                    let msg = panic_message(payload.as_ref());
                    // This itself locks the now-poisoned events lock via job.emit.
                    record_internal_error(&job, i, &counts, &msg);
                }
            }));
        }
        for h in handles {
            let _ = h.join();
        }

        // The batch did NOT halt: 2 done, 1 internal error, nothing left pending.
        assert_eq!(counts.done.load(Ordering::Relaxed), 2);
        assert_eq!(counts.error.load(Ordering::Relaxed), 1);
        assert_eq!(*job.files[0].status.lock_recover(), "done");
        assert_eq!(*job.files[2].status.lock_recover(), "done");
        assert_eq!(*job.files[1].status.lock_recover(), "error");
        assert_eq!(*job.files[1].reason.lock_recover(), "error_internal");
        // The poisoned shared lock is still usable (would panic pre-fix).
        job.emit(ev_done(&job.id, 2, 1, 0, 0, 3, 0));

        let _ = std::fs::remove_dir_all(&home);
    }

    /// End-to-end early-termination guard: drive the REAL [`run_job`] worker pool
    /// over a batch where many files fail per-file (nonexistent sources →
    /// `ErrorSourceMissing`) interleaved with good compressible files. A per-file
    /// error must NOT abort the worker, the pool, or the job: EVERY input must end
    /// in a terminal state (done/skipped/error) with NONE left "pending"/"running",
    /// and the job must actually finish (not stop early). This is the regression
    /// test for the "job ends early, ~75% stuck pending" report.
    #[test]
    fn run_job_does_not_terminate_early_when_files_fail() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (home, _restore) = redirect_home();

        let dir = std::env::temp_dir()
            .join(format!("ft-earlyexit-{}-{}", std::process::id(), new_job_id()));
        std::fs::create_dir_all(&dir).expect("tmp dir");

        // 24 files: every other one is a nonexistent source that fails per-file.
        // The good ones are highly compressible `.bin` (built-in zip pipeline, no
        // external tool needed) so they reach a terminal done/skipped offline.
        let payload = vec![b'A'; 8 * 1024];
        let mut paths: Vec<String> = Vec::new();
        for n in 0..12 {
            let good = dir.join(format!("good{n}.bin"));
            std::fs::write(&good, &payload).expect("write good");
            paths.push(good.to_string_lossy().into_owned());
            // A source that does not exist → per-file ErrorSourceMissing.
            paths.push(dir.join(format!("missing{n}.bin")).to_string_lossy().into_owned());
        }
        let total = paths.len();

        // Keep originals (non-destructive); force concurrency=1 so a hypothetical
        // early `break` on a non-cancel condition would strand the remainder —
        // the most sensitive arrangement for catching an early-exit regression.
        let opts = CompressOptions {
            original_action: OriginalAction::Keep,
            concurrency: 1,
            ..CompressOptions::default()
        };
        let job = create_job(&paths, "balanced", &opts);

        // Force the FAILING (nonexistent) files to sort FIRST in the schedule by
        // giving them the largest sizes — the schedule orders by size desc. With
        // concurrency=1 this means the worker hits the failures BEFORE the good
        // files, so any early `break`/abort on a per-file failure would strand the
        // good files that follow (the exact "rest of the batch left pending" bug).
        for (i, f) in job.files.iter().enumerate() {
            // Odd indices are the nonexistent sources (see the loop above).
            f.orig_bytes
                .store(if i % 2 == 1 { 10_000_000 } else { 8 * 1024 }, Ordering::Relaxed);
        }

        run_job(test_state(), Arc::clone(&job));

        // The job actually finished and was NOT (spuriously) cancelled.
        assert!(job.finished.load(Ordering::SeqCst), "job must finish");
        assert_ne!(*job.status.lock_recover(), "cancelled", "no cancel happened");

        // EVERY file reached a terminal state — none left pending/running.
        let mut pending = Vec::new();
        let (mut done, mut skipped, mut errors) = (0usize, 0usize, 0usize);
        for (i, f) in job.files.iter().enumerate() {
            match f.status.lock_recover().as_str() {
                "done" => done += 1,
                "skipped" => skipped += 1,
                "error" => errors += 1,
                other => pending.push(format!("#{i}={other}")),
            }
        }
        assert!(
            pending.is_empty(),
            "every input must reach a terminal state; left behind: {pending:?}"
        );
        assert_eq!(done + skipped + errors, total, "post==pre: all files accounted for");

        // The batch did NOT halt at the first failure: all 12 nonexistent files
        // are errors AND all 12 good files progressed past their failing peers.
        assert_eq!(errors, 12, "all nonexistent sources must be terminal errors");
        assert_eq!(done + skipped, 12, "all good files must reach done/skipped");

        // The live summary the UI reads must show zero pending after completion.
        let sum = summary_from_live(&job);
        assert_eq!(sum.pending, 0, "no file may linger as pending in the summary");
        assert_eq!(sum.done + sum.skipped + sum.errors, sum.total);

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// End-to-end panic isolation through the REAL [`run_job`] worker pool: some
    /// files panic mid-pipeline (via the `#[cfg(test)]` fault injector). A panic
    /// must NOT kill the worker, poison the pool, or abandon the rest of the batch
    /// as pending — each panicking file is recorded as a terminal `error_internal`
    /// and EVERY other file still reaches a terminal state with the job finishing.
    /// With `concurrency=1` and the panicking files scheduled FIRST, a broken
    /// `catch_unwind` would strand all the good files (done==0); this asserts they
    /// all complete.
    #[test]
    fn run_job_isolates_panicking_files_and_finishes_batch() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (home, _restore) = redirect_home();

        let dir = std::env::temp_dir()
            .join(format!("ft-panic-iso-{}-{}", std::process::id(), new_job_id()));
        std::fs::create_dir_all(&dir).expect("tmp dir");

        let payload = vec![b'A'; 8 * 1024];
        let mut paths: Vec<String> = Vec::new();
        for n in 0..8 {
            // A real, compressible file whose NAME trips the panic injector.
            let boom = dir.join(format!("__FORCE_PANIC__{n}.bin"));
            std::fs::write(&boom, &payload).expect("write boom");
            paths.push(boom.to_string_lossy().into_owned());
            // A normal compressible file that must still complete.
            let good = dir.join(format!("good{n}.bin"));
            std::fs::write(&good, &payload).expect("write good");
            paths.push(good.to_string_lossy().into_owned());
        }
        let total = paths.len();

        let opts = CompressOptions {
            original_action: OriginalAction::Keep,
            concurrency: 1,
            ..CompressOptions::default()
        };
        let job = create_job(&paths, "balanced", &opts);

        // Panicking files schedule FIRST (largest), so a single worker meets them
        // before any good file — the most sensitive layout for an isolation bug.
        for (i, f) in job.files.iter().enumerate() {
            f.orig_bytes
                .store(if i % 2 == 0 { 10_000_000 } else { 8 * 1024 }, Ordering::Relaxed);
        }

        run_job(test_state(), Arc::clone(&job));

        assert!(job.finished.load(Ordering::SeqCst), "job must finish");
        assert_ne!(*job.status.lock_recover(), "cancelled", "no cancel happened");

        let mut pending = Vec::new();
        let (mut done, mut skipped, mut internal_errors, mut other_errors) = (0, 0, 0, 0);
        for (i, f) in job.files.iter().enumerate() {
            let st = f.status.lock_recover().clone();
            let reason = f.reason.lock_recover().clone();
            match st.as_str() {
                "done" => done += 1,
                "skipped" => skipped += 1,
                "error" if reason == Reason::ErrorInternal.as_str() => internal_errors += 1,
                "error" => other_errors += 1,
                other => pending.push(format!("#{i}={other}")),
            }
        }
        assert!(pending.is_empty(), "no file may be left pending/running: {pending:?}");
        assert_eq!(done + skipped + internal_errors + other_errors, total);
        // All 8 panicking files were caught and recorded as internal errors…
        assert_eq!(internal_errors, 8, "every panicking file must be error_internal");
        // …and the 8 good files that FOLLOW them in the schedule still completed —
        // proving the panic did not halt the pool (would be 0 if isolation broke).
        assert_eq!(done + skipped, 8, "all good files must reach a terminal success");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Orchestration-level safety net: if [`run_job`] ITSELF panics (a fault in
    /// job setup/finalize, OUTSIDE the per-file `catch_unwind`), the bare worker
    /// thread used to die and leave every file stuck `pending` with the job never
    /// finalized — the "job ends early, files stuck pending" report. [`spawn_job`]
    /// now wraps the runner so the job is ALWAYS finalized: no file is left
    /// pending and `finished` is set even on an orchestration panic.
    #[test]
    fn orchestration_panic_still_finalizes_job() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (home, _restore) = redirect_home();

        let dir = std::env::temp_dir()
            .join(format!("ft-orch-{}-{}", std::process::id(), new_job_id()));
        std::fs::create_dir_all(&dir).expect("tmp dir");

        // Real files; one name trips the orchestration-panic injector at the very
        // top of run_job (before any file is even scheduled).
        let payload = vec![b'A'; 4096];
        let mut paths = Vec::new();
        let boom = dir.join("__FORCE_ORCH_PANIC__.bin");
        std::fs::write(&boom, &payload).unwrap();
        paths.push(boom.to_string_lossy().into_owned());
        for n in 0..5 {
            let p = dir.join(format!("f{n}.bin"));
            std::fs::write(&p, &payload).unwrap();
            paths.push(p.to_string_lossy().into_owned());
        }
        let total = paths.len();

        let job = create_job(&paths, "balanced", &CompressOptions::default());
        spawn_job(test_state(), Arc::clone(&job));

        // Wait (bounded) for the guard to finalize the job.
        let mut waited = 0;
        while !job.finished.load(Ordering::SeqCst) && waited < 5000 {
            std::thread::sleep(std::time::Duration::from_millis(25));
            waited += 25;
        }
        assert!(job.finished.load(Ordering::SeqCst), "job must be finalized even after an orchestration panic");

        // No file may be left pending/running; the job did not silently abandon
        // the batch. (run_job panicked before scheduling, so all are force-failed.)
        let pending = job
            .files
            .iter()
            .filter(|f| matches!(f.status.lock_recover().as_str(), "pending" | "running"))
            .count();
        assert_eq!(pending, 0, "no file may remain pending after force-finalize");
        let terminal = job
            .files
            .iter()
            .filter(|f| matches!(f.status.lock_recover().as_str(), "done" | "skipped" | "error"))
            .count();
        assert_eq!(terminal, total, "every file must reach a terminal state");
        assert_eq!(*job.status.lock_recover(), "error", "an aborted run finalizes as a resumable error");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Concurrency-exhaustion regression: with a worker pool (concurrency=4) and
    /// MORE panicking files than workers, a "one dead worker per bad file" bug
    /// would stall the batch once every worker had exited. Every file must reach a
    /// terminal state and the job must finish.
    #[test]
    fn run_job_more_panicking_files_than_workers_still_completes() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (home, _restore) = redirect_home();

        let dir = std::env::temp_dir()
            .join(format!("ft-exhaust-{}-{}", std::process::id(), new_job_id()));
        std::fs::create_dir_all(&dir).expect("tmp dir");

        let payload = vec![b'A'; 8 * 1024];
        let mut paths: Vec<String> = Vec::new();
        // 12 panicking files (> the 4 workers) scheduled first, then 6 good files.
        for n in 0..12 {
            let boom = dir.join(format!("__FORCE_PANIC__{n}.bin"));
            std::fs::write(&boom, &payload).expect("write boom");
            paths.push(boom.to_string_lossy().into_owned());
        }
        for n in 0..6 {
            let good = dir.join(format!("good{n}.bin"));
            std::fs::write(&good, &payload).expect("write good");
            paths.push(good.to_string_lossy().into_owned());
        }
        let total = paths.len();

        let opts = CompressOptions {
            original_action: OriginalAction::Keep,
            concurrency: 4,
            ..CompressOptions::default()
        };
        let job = create_job(&paths, "balanced", &opts);
        // Panicking files largest ⇒ scheduled first (sort is size desc).
        for (i, f) in job.files.iter().enumerate() {
            f.orig_bytes
                .store(if i < 12 { 10_000_000 } else { 8 * 1024 }, Ordering::Relaxed);
        }

        run_job(test_state(), Arc::clone(&job));

        assert!(job.finished.load(Ordering::SeqCst), "job must finish");
        let pending = job
            .files
            .iter()
            .filter(|f| matches!(f.status.lock_recover().as_str(), "pending" | "running"))
            .count();
        assert_eq!(pending, 0, "no file may be left pending with a pool of workers");
        let terminal = job
            .files
            .iter()
            .filter(|f| matches!(f.status.lock_recover().as_str(), "done" | "skipped" | "error"))
            .count();
        assert_eq!(terminal, total, "every file must reach a terminal state");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A panic raised WHILE RECORDING a file's outcome (the `Err`-arm recording
    /// runs outside the per-file `catch_unwind`) must not unwind the worker and
    /// remove it from the pool. Drives the real `run_job` with concurrency=1: file
    /// A panics in the pipeline (caught), then its outcome-recording panics too
    /// (one-shot injector). Before the fix the worker thread died there and the
    /// good file B that follows was stranded (reconciled to `error`); after the
    /// fix the SAME worker survives and processes B to `done`.
    #[test]
    fn worker_survives_panic_while_recording_outcome() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (home, _restore) = redirect_home();

        let dir = std::env::temp_dir()
            .join(format!("ft-recpanic-{}-{}", std::process::id(), new_job_id()));
        std::fs::create_dir_all(&dir).expect("tmp dir");

        let payload = vec![b'A'; 8 * 1024];
        let boom = dir.join("__FORCE_PANIC__a.bin");
        std::fs::write(&boom, &payload).expect("write boom");
        let good = dir.join("good.bin");
        std::fs::write(&good, &payload).expect("write good");
        let paths = vec![
            boom.to_string_lossy().into_owned(),
            good.to_string_lossy().into_owned(),
        ];

        let opts = CompressOptions {
            original_action: OriginalAction::Keep,
            concurrency: 1,
            ..CompressOptions::default()
        };
        let job = create_job(&paths, "balanced", &opts);
        // A scheduled first (largest); B follows.
        job.files[0].orig_bytes.store(10_000_000, Ordering::Relaxed);
        job.files[1].orig_bytes.store(8 * 1024, Ordering::Relaxed);

        // Arm the one-shot so the FIRST outcome-recording (the worker's Err-arm
        // recording for A) panics.
        TEST_RECORD_PANIC_ARMED.store(true, Ordering::SeqCst);
        run_job(test_state(), Arc::clone(&job));
        TEST_RECORD_PANIC_ARMED.store(false, Ordering::SeqCst);

        assert!(job.finished.load(Ordering::SeqCst), "job must finish");
        // The crux: B (scheduled AFTER the record-panic) was processed by the SAME
        // worker — it did NOT die. Pre-fix this would be "error" (reconciled).
        assert_eq!(
            *job.files[1].status.lock_recover(),
            "done",
            "good file after a record-panic must be processed by the worker, not stranded"
        );
        // A is terminal too, and nothing is left pending.
        assert_eq!(*job.files[0].status.lock_recover(), "error");
        let pending = job
            .files
            .iter()
            .filter(|f| matches!(f.status.lock_recover().as_str(), "pending" | "running"))
            .count();
        assert_eq!(pending, 0, "no file may be left pending");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The inactivity watchdog: a child that produces NO output for longer than
    /// the limit (a hung/corrupt input) is killed and reported as a terminal
    /// non-success encode, so it can never block its worker forever. Drives the
    /// real `run_child` with a genuinely silent, long-running subprocess and a
    /// shrunk limit; without the watchdog this call would block for the full
    /// sleep (≈30 s) instead of returning in ~the limit.
    #[cfg(windows)]
    #[test]
    fn run_child_times_out_on_silent_hung_child() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (home, _restore) = redirect_home();

        let prev = std::env::var_os("FILETREE_ENCODE_INACTIVITY_MS");
        // SAFETY: serialized by ENV_LOCK.
        unsafe { std::env::set_var("FILETREE_ENCODE_INACTIVITY_MS", "1500") };

        let job = create_job(&["hang.bin".to_string()], "balanced", &CompressOptions::default());
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"]);

        let start = Instant::now();
        let result = run_child(&job, 0, cmd);
        let elapsed = start.elapsed();

        // SAFETY: serialized by ENV_LOCK.
        unsafe {
            match prev {
                Some(v) => std::env::set_var("FILETREE_ENCODE_INACTIVITY_MS", v),
                None => std::env::remove_var("FILETREE_ENCODE_INACTIVITY_MS"),
            }
        }

        assert!(
            elapsed.as_secs() < 12,
            "watchdog must kill the hung child quickly; took {elapsed:?}"
        );
        match result {
            EncodeResult::Done { success, diag, .. } => {
                assert!(!success, "a hung+killed child must be a non-success encode");
                assert!(
                    diag.stderr_tail.contains("killed") || diag.stderr_tail.contains("no output"),
                    "stderr tail must explain the timeout, got: {:?}",
                    diag.stderr_tail
                );
            }
            _ => panic!("expected Done(success=false) from the watchdog"),
        }

        let _ = std::fs::remove_dir_all(&home);
    }

    // ── Post-compression safety workflow tests ────────────────────────────────

    /// Build a one-file job whose single file is `FileKind::Other`, for driving
    /// `verify_output` through the zip/archive path without spawning encoders.
    fn other_job() -> Arc<CompressJob> {
        create_job(&["x.bin".to_string()], "balanced", &CompressOptions::default())
    }

    fn empty_tool() -> compress_tools::ToolInfo {
        compress_tools::ToolInfo::default()
    }

    /// (a) A corrupt/truncated compressed output is rejected by the deep-verify
    /// gate and the ORIGINAL is left untouched. Exercises the real
    /// `verify_output` wiring for the zip pipeline (and `Reason::ErrorVerifyFailed`
    /// classification by status).
    #[test]
    fn corrupt_output_is_rejected_and_original_preserved() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (home, _restore) = redirect_home();

        let dir = std::env::temp_dir().join(format!("ft-verify-{}-{}", std::process::id(), new_job_id()));
        std::fs::create_dir_all(&dir).expect("tmp dir");
        let original = dir.join("data.txt");
        std::fs::write(&original, b"the original payload that must survive").expect("write original");
        let archive = dir.join("data [COMPRESSED].zip");
        crate::archive::compress_with_level(&[original.to_string_lossy().into_owned()], &archive, 6)
            .expect("zip created");

        let job = other_job();

        // A well-formed archive passes.
        assert!(matches!(
            verify_output(&job, 0, &archive, FileKind::Other, &original, &empty_tool(), &empty_tool(), &empty_tool(), None),
            Verify::Ok
        ));

        // Truncate the archive to corrupt it, then it must FAIL and the original
        // must still exist (the disposition step never runs on a failed verify).
        let bytes = std::fs::read(&archive).unwrap();
        std::fs::write(&archive, &bytes[..bytes.len() / 2]).expect("truncate");
        assert!(matches!(
            verify_output(&job, 0, &archive, FileKind::Other, &original, &empty_tool(), &empty_tool(), &empty_tool(), None),
            Verify::Failed(_)
        ));
        assert!(original.exists(), "original must be preserved when verification fails");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// (b) "Delete permanently" removes the original (no Recycle Bin) — the
    /// disposition helper used after a verify pass. (c) "Keep" leaves it alone.
    #[test]
    fn delete_permanent_removes_and_keep_leaves_original() {
        let dir = std::env::temp_dir().join(format!("ft-dispo-{}-{}", std::process::id(), new_job_id()));
        std::fs::create_dir_all(&dir).expect("tmp dir");

        // Delete permanently.
        let to_delete = dir.join("gone.txt");
        std::fs::write(&to_delete, b"bye").unwrap();
        crate::recycle::delete_permanent(&to_delete).expect("delete_permanent");
        assert!(!to_delete.exists(), "Delete must permanently remove the original");

        // Keep: nothing is invoked, so the file simply remains.
        let kept = dir.join("stays.txt");
        std::fs::write(&kept, b"stay").unwrap();
        assert_eq!(OriginalAction::Keep.as_str(), "keep");
        assert!(kept.exists(), "Keep must leave the original in place");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (d) Counts reconcile to the total on a mixed batch, and the verify-failed
    /// subset is tallied from `error_verify_failed`. Drives `summary_from_manifest`
    /// on a hand-built manifest with one of every terminal outcome.
    #[test]
    fn counts_reconcile_to_total_on_mixed_batch() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (home, _restore) = redirect_home();

        let id = new_job_id();
        let path = jobs_dir().join(format!("{id}.json"));
        std::fs::create_dir_all(jobs_dir()).unwrap();
        // 5 files: done, skipped, plain error, verify-failed error, pending.
        let manifest = format!(
            "{{\"id\":\"{id}\",\"status\":\"error\",\"preset\":\"balanced\",\"originalAction\":\"delete\",\"total\":5,\"savedBytes\":600,\"files\":[\
             {{\"index\":0,\"path\":\"a\",\"kind\":\"other\",\"status\":\"done\",\"reason\":\"success\",\"disposition\":\"deleted\",\"origBytes\":1000,\"newBytes\":400}},\
             {{\"index\":1,\"path\":\"b\",\"kind\":\"other\",\"status\":\"skipped\",\"reason\":\"skipped_no_gain\",\"origBytes\":10,\"newBytes\":10}},\
             {{\"index\":2,\"path\":\"c\",\"kind\":\"video\",\"status\":\"error\",\"reason\":\"error_encoder\",\"origBytes\":50,\"newBytes\":0}},\
             {{\"index\":3,\"path\":\"d\",\"kind\":\"video\",\"status\":\"error\",\"reason\":\"error_verify_failed\",\"origBytes\":80,\"newBytes\":0}},\
             {{\"index\":4,\"path\":\"e\",\"kind\":\"other\",\"status\":\"pending\",\"origBytes\":5,\"newBytes\":0}}\
             ]}}"
        );
        std::fs::write(&path, manifest).unwrap();

        let sum = summary_from_manifest(&id, &path).expect("summary");
        assert_eq!(sum.total, 5);
        assert_eq!(sum.done, 1);
        assert_eq!(sum.skipped, 1);
        assert_eq!(sum.errors, 2);
        assert_eq!(sum.verify_failed, 1, "verify-failed is tallied from error_verify_failed");
        assert_eq!(sum.pending, 1);
        // Every file is accounted for: done + skipped + errors + pending == total.
        assert_eq!(sum.done + sum.skipped + sum.errors + sum.pending, sum.total);
        // The back-compat boolean disposition derivation also round-trips.
        let job = job_from_manifest(&id).expect("job reload");
        assert_eq!(job.original_action, OriginalAction::Delete);

        let _ = std::fs::remove_dir_all(&home);
    }

    /// The legacy `recycleOriginals` boolean still drives disposition when no
    /// `originalAction` is present (true => Recycle, false => Keep).
    #[test]
    fn legacy_recycle_originals_maps_to_action() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (home, _restore) = redirect_home();

        for (legacy, expect) in [("true", OriginalAction::Recycle), ("false", OriginalAction::Keep)] {
            let id = new_job_id();
            let path = jobs_dir().join(format!("{id}.json"));
            std::fs::create_dir_all(jobs_dir()).unwrap();
            let manifest = format!(
                "{{\"id\":\"{id}\",\"status\":\"done\",\"preset\":\"balanced\",\"recycleOriginals\":{legacy},\"total\":1,\"files\":[\
                 {{\"index\":0,\"path\":\"a\",\"kind\":\"other\",\"status\":\"pending\",\"origBytes\":1,\"newBytes\":0}}]}}"
            );
            std::fs::write(&path, manifest).unwrap();
            let job = job_from_manifest(&id).expect("job reload");
            assert_eq!(job.original_action, expect);
        }

        let _ = std::fs::remove_dir_all(&home);
    }

    /// Minimal `AppState` for driving `process_file` directly in a unit test.
    fn test_state() -> Arc<AppState> {
        Arc::new(AppState {
            initial_path: std::env::temp_dir(),
            last_scan: std::sync::RwLock::new(None),
            scan_cache: std::sync::RwLock::new(crate::model::ScanCache::new()),
            icon_cache: Mutex::new(HashMap::new()),
            thumbnail_cache: Mutex::new(HashMap::new()),
            dupes_progress: Arc::new(crate::model::DupesProgress::default()),
            dupes_cancel: Arc::new(AtomicBool::new(false)),
            ignore_list: std::sync::RwLock::new(crate::model::IgnoreList::default()),
            ignore_list_path: std::env::temp_dir().join("ft-test-ignore.json"),
            hash_cache: Mutex::new(HashMap::new()),
            hash_cache_path: std::env::temp_dir().join("ft-test-hash.json"),
            auth_token: None,
            scan_roots: std::sync::RwLock::new(Vec::new()),
            compress_roots: std::sync::RwLock::new(Vec::new()),
            compress_jobs: Mutex::new(HashMap::new()),
        })
    }

    /// A file below the minimum-size threshold is skipped (`SkippedTooSmall`)
    /// before any encode: the original is untouched, no output is written, and
    /// the outcome is a terminal `skipped` (so the post==pre reconciliation still
    /// holds). Also checks summary-level reconciliation on a mixed batch.
    #[test]
    fn too_small_file_skipped_untouched_no_output() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (home, _restore) = redirect_home();

        let dir = std::env::temp_dir().join(format!("ft-minsize-{}-{}", std::process::id(), new_job_id()));
        std::fs::create_dir_all(&dir).expect("tmp dir");
        let tiny = dir.join("tiny.bin");
        std::fs::write(&tiny, b"only a few bytes").expect("write tiny");
        let before = std::fs::read(&tiny).unwrap();

        // Threshold well above the tiny file's size.
        let opts = CompressOptions { min_size_bytes: 1_000_000, ..CompressOptions::default() };
        let job = create_job(&[tiny.to_string_lossy().into_owned()], "balanced", &opts);
        let state = test_state();
        let none_tool = compress_tools::ToolInfo::default();

        let outcome = process_file(&state, &job, 0, &none_tool, &none_tool, &none_tool, None, &HandbrakeCaps::default());
        match outcome {
            FileOutcome::Skipped { reason, .. } => assert_eq!(reason.as_str(), "skipped_too_small"),
            _ => panic!("expected a SkippedTooSmall outcome"),
        }
        // Original untouched; no [COMPRESSED] output produced.
        assert!(tiny.exists(), "original must be untouched");
        assert_eq!(std::fs::read(&tiny).unwrap(), before, "original bytes unchanged");
        let out = output_path(&tiny, FileKind::Other);
        assert!(!out.exists(), "no output should be written for a too-small skip");

        // Summary-level reconciliation: a manifest with a skipped_too_small entry
        // is counted in the skipped bucket and done+skipped+error+pending==total.
        let id = new_job_id();
        let path = jobs_dir().join(format!("{id}.json"));
        std::fs::create_dir_all(jobs_dir()).unwrap();
        let manifest = format!(
            "{{\"id\":\"{id}\",\"status\":\"done\",\"preset\":\"balanced\",\"minSizeBytes\":1000000,\"total\":3,\"files\":[\
             {{\"index\":0,\"path\":\"a\",\"kind\":\"other\",\"status\":\"done\",\"reason\":\"success\",\"origBytes\":2000000,\"newBytes\":900000}},\
             {{\"index\":1,\"path\":\"b\",\"kind\":\"video\",\"status\":\"skipped\",\"reason\":\"skipped_too_small\",\"origBytes\":50,\"newBytes\":50}},\
             {{\"index\":2,\"path\":\"c\",\"kind\":\"other\",\"status\":\"skipped\",\"reason\":\"skipped_no_gain\",\"origBytes\":10,\"newBytes\":10}}\
             ]}}"
        );
        std::fs::write(&path, manifest).unwrap();
        let sum = summary_from_manifest(&id, &path).expect("summary");
        assert_eq!(sum.total, 3);
        assert_eq!(sum.done, 1);
        assert_eq!(sum.skipped, 2, "both no-gain and too-small land in skipped");
        assert_eq!(sum.errors, 0);
        assert_eq!(sum.done + sum.skipped + sum.errors + sum.pending, sum.total);
        // The threshold round-trips through the manifest.
        let back = job_from_manifest(&id).expect("job reload");
        assert_eq!(back.min_size_bytes, 1_000_000);

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The final `done` event payload carries skipped + verifyFailed + total so
    /// the UI totals can sum to the original count.
    #[test]
    fn done_event_includes_reconciled_counts() {
        let ev = ev_done("job-1", 3, 2, 1, 1, 6, 1234);
        assert!(ev.contains("\"done\":3"));
        assert!(ev.contains("\"errors\":2"));
        assert!(ev.contains("\"skipped\":1"));
        assert!(ev.contains("\"verifyFailed\":1"));
        assert!(ev.contains("\"total\":6"));
    }
}

