//! Compression tool detection + hybrid in-app provisioning.
//!
//! The compression pipelines shell out to external encoders: `HandBrakeCLI` for
//! video and an image encoder (preferred `ffmpeg`, fallback ImageMagick's
//! `magick`) for images. Non-media files use the built-in pure-Rust zip
//! ([`crate::archive`]) and need no external tool.
//!
//! Detection looks in three places, in order: the app's own tools directory
//! (`%APPDATA%\FileTree\tools\`, where an in-app download would land or where a
//! user can drop a portable binary), a few common install locations, then the
//! system `PATH` (via `where`). The first hit wins and its `--version` line is
//! captured for the UI.
//!
//! ## Install (hybrid, with a documented deviation)
//! `POST /api/compress-tools/install` is meant to download the official binary
//! into the tools directory. Implementing a hardened HTTPS downloader + archive
//! extractor here would pull in a network/TLS dependency and is risky to do
//! blind, so this build does NOT fetch bytes itself. Instead it RE-DETECTS (so a
//! binary the user dropped into the tools dir is picked up and reported
//! `ok:true`), and otherwise returns a structured `{ok:false, error,
//! downloadUrl}` carrying the correct official URL so the UI can link the user
//! out. This is the single intentional deviation from a fully automatic install.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::export::push_json_string;

/// Apply Windows' `CREATE_NO_WINDOW` so spawning a console tool never flashes a
/// window. No-op off Windows (the rest of the crate is Windows-only anyway).
pub(crate) fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// The app's tools directory: `%APPDATA%\FileTree\tools\`. An in-app download
/// would land here, and a user can drop a portable `HandBrakeCLI.exe` /
/// `ffmpeg.exe` / `magick.exe` here to have it picked up.
pub(crate) fn tools_dir() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("FileTree")
            .join("tools")
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".config")
            .join("filetree")
            .join("tools")
    }
}

fn program_files() -> Option<PathBuf> {
    std::env::var_os("ProgramFiles").map(PathBuf::from)
}

/// Which image encoder a detected tool is, so the pipeline knows how to invoke it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ImageKind {
    Ffmpeg,
    ImageMagick,
}

impl ImageKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ImageKind::Ffmpeg => "ffmpeg",
            ImageKind::ImageMagick => "imagemagick",
        }
    }
}

/// One detected (or missing) external tool.
#[derive(Clone, Debug, Default)]
pub(crate) struct ToolInfo {
    pub(crate) found: bool,
    pub(crate) path: Option<PathBuf>,
    pub(crate) version: Option<String>,
}

/// Resolve an executable: tools dir first, then the supplied common locations,
/// then the system `PATH` via `where`. Returns the first existing file.
fn locate(exe_name: &str, common: &[PathBuf]) -> Option<PathBuf> {
    let in_tools = tools_dir().join(exe_name);
    if in_tools.is_file() {
        return Some(in_tools);
    }
    for cand in common {
        if cand.is_file() {
            return Some(cand.clone());
        }
    }
    which(exe_name)
}

/// `where <name>` → first match on PATH, if any.
fn which(name: &str) -> Option<PathBuf> {
    let mut cmd = Command::new("where");
    cmd.arg(name);
    no_window(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let first = text.lines().map(|l| l.trim()).find(|l| !l.is_empty())?;
    if first.is_empty() {
        None
    } else {
        Some(PathBuf::from(first))
    }
}

/// Run `<path> <args...>` and return the first non-empty output line as a
/// version string. Tools print to stdout or stderr depending on the tool, so
/// both are considered.
fn capture_version(path: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(path);
    cmd.args(args);
    no_window(&mut cmd);
    let out = cmd.output().ok()?;
    let mut combined = String::from_utf8_lossy(&out.stdout).into_owned();
    combined.push('\n');
    combined.push_str(&String::from_utf8_lossy(&out.stderr));
    combined
        .lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .map(|l| {
            // Keep the version line readable but bounded.
            let mut s = l.to_string();
            if s.len() > 200 {
                s.truncate(200);
            }
            s
        })
}

/// Hardware video encoders HandBrake reports as available on this machine,
/// parsed from its encoder list. Drives the Auto encoder selection, the
/// capability-gated UI picker, and hardware-only encoder selection. Software
/// tokens remain parsed for diagnostics and compatibility with older manifests.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct HandbrakeCaps {
    pub(crate) x265: bool,
    /// CPU SVT-AV1 token, retained only as capability evidence for old clients.
    pub(crate) svt_av1: bool,
    pub(crate) nvenc_h264: bool,
    pub(crate) nvenc_h265: bool,
    pub(crate) nvenc_av1: bool,
    pub(crate) qsv_h264: bool,
    pub(crate) qsv_h265: bool,
    pub(crate) qsv_av1: bool,
    pub(crate) vce_h264: bool,
    pub(crate) vce_h265: bool,
    pub(crate) vce_av1: bool,
}

impl HandbrakeCaps {
    pub(crate) fn any_gpu(&self) -> bool {
        self.nvenc_h264
            || self.nvenc_h265
            || self.nvenc_av1
            || self.qsv_h264
            || self.qsv_h265
            || self.qsv_av1
            || self.vce_h264
            || self.vce_h265
            || self.vce_av1
    }
    fn any_nvenc(&self) -> bool {
        self.nvenc_h264 || self.nvenc_h265 || self.nvenc_av1
    }
    fn any_qsv(&self) -> bool {
        self.qsv_h264 || self.qsv_h265 || self.qsv_av1
    }
    fn any_vce(&self) -> bool {
        self.vce_h264 || self.vce_h265 || self.vce_av1
    }
}

/// Effective hardware-encoder availability, combining HandBrake's (unreliable)
/// `-h` token parse with the independent physical-GPU probe. The root-cause bug
/// was treating an empty `-h` parse as "no GPU"; some HandBrake builds omit the
/// `nvenc_*`/`qsv_*`/`vce_*` tokens from redirected (non-console) help even
/// though the encoders work. Here a vendor's encoder is considered AVAILABLE
/// when EITHER the `-h` token is present OR the matching physical adapter exists,
/// and flagged "assumed" when it rests only on the adapter probe (UI hint: not
/// yet confirmed by an actual encode).
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct EffectiveCaps {
    pub(crate) nvenc: bool,
    pub(crate) qsv: bool,
    pub(crate) vce: bool,
    pub(crate) nvenc_assumed: bool,
    pub(crate) qsv_assumed: bool,
    pub(crate) vce_assumed: bool,
}

impl EffectiveCaps {
    pub(crate) fn compute(caps: &HandbrakeCaps, hw: &GpuHardware) -> EffectiveCaps {
        EffectiveCaps {
            nvenc: caps.any_nvenc() || hw.nvidia,
            qsv: caps.any_qsv() || hw.intel,
            vce: caps.any_vce() || hw.amd,
            nvenc_assumed: !caps.any_nvenc() && hw.nvidia,
            qsv_assumed: !caps.any_qsv() && hw.intel,
            vce_assumed: !caps.any_vce() && hw.amd,
        }
    }
    pub(crate) fn any_gpu(&self) -> bool {
        self.nvenc || self.qsv || self.vce
    }
}

/// GPU vendors inferred to be present (from the HandBrake encoder list). On
/// Windows the encoder set is a reliable signal: NVENC ⇒ NVIDIA, QSV ⇒ Intel,
/// VCE/AMF ⇒ AMD. Surfaced on `/api/compress-tools` to drive the Auto pick + UI.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct GpuVendors {
    pub(crate) nvidia: bool,
    pub(crate) intel: bool,
    pub(crate) amd: bool,
}

impl GpuVendors {
    fn from_caps(c: &HandbrakeCaps) -> GpuVendors {
        GpuVendors {
            nvidia: c.any_nvenc(),
            intel: c.any_qsv(),
            amd: c.any_vce(),
        }
    }
}

/// Physical GPU adapters actually present on the machine, probed independently of
/// HandBrake. This is the key signal for distinguishing "no GPU at all" from "a
/// GPU is present but the installed HandBrake build can't use it" — without it
/// the UI can only infer vendors from HandBrake's encoder list and would wrongly
/// report "no AMD GPU" on a box that has one but whose HandBrake lacks AMF.
#[derive(Clone, Debug, Default)]
pub(crate) struct GpuHardware {
    pub(crate) nvidia: bool,
    pub(crate) intel: bool,
    pub(crate) amd: bool,
    /// Human-readable adapter names (e.g. "AMD Radeon(TM) Graphics"), for the UI.
    pub(crate) names: Vec<String>,
}

/// Probe the physical display adapters on Windows and classify their vendor.
/// Uses PowerShell's CIM (`Win32_VideoController`) — always available on Windows
/// and dependency-free — and classifies each adapter name by vendor keyword.
/// Best-effort: any failure yields an empty result (the UI then just can't show
/// hardware-specific guidance). Off Windows this is always empty.
fn probe_gpu_hardware_uncached() -> GpuHardware {
    let mut hw = GpuHardware::default();
    #[cfg(windows)]
    {
        let mut cmd = Command::new("powershell");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }",
        ]);
        no_window(&mut cmd);
        if let Ok(out) = cmd.output() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let name = line.trim();
                if name.is_empty() {
                    continue;
                }
                let lower = name.to_ascii_lowercase();
                if lower.contains("nvidia")
                    || lower.contains("geforce")
                    || lower.contains("quadro")
                    || lower.contains("rtx")
                    || lower.contains("gtx")
                {
                    hw.nvidia = true;
                } else if lower.contains("amd")
                    || lower.contains("radeon")
                    || lower.contains("ati ")
                    || lower.contains("vega")
                {
                    hw.amd = true;
                } else if lower.contains("intel")
                    || lower.contains("iris")
                    || lower.contains("uhd graphics")
                    || lower.contains("hd graphics")
                    || lower.contains("arc")
                {
                    hw.intel = true;
                }
                hw.names.push(name.to_string());
            }
        }
    }
    hw
}

/// Cached physical-GPU probe. The hardware doesn't change during a session and
/// the probe spawns PowerShell, so compute it once per process.
pub(crate) fn probe_gpu_hardware() -> &'static GpuHardware {
    static CACHE: std::sync::OnceLock<GpuHardware> = std::sync::OnceLock::new();
    CACHE.get_or_init(probe_gpu_hardware_uncached)
}

/// Parse HandBrake's encoder list (`HandBrakeCLI -h`) to discover which hardware
/// encoders this build + machine actually expose. HandBrake only lists an
/// encoder when the underlying driver/hardware is usable, so presence in the
/// help text is an accurate capability signal. Best-effort: a failure to run or
/// parse yields empty caps; the pipeline still attempts hardware and fails the
/// file safely if the requested encoder is genuinely unavailable.
pub(crate) fn detect_handbrake_caps(path: &Path) -> HandbrakeCaps {
    detect_handbrake_caps_ex(path).0
}

/// Like [`detect_handbrake_caps`] but also returns whether the `-h` probe
/// actually produced parseable output (`parse_ok`). `parse_ok == false` means
/// the help text couldn't be read (spawn/exit failure or empty output) — i.e.
/// the caps are "unknown", NOT "no hardware". Callers should fall back to the
/// physical-GPU probe rather than concluding the GPU is unavailable.
pub(crate) fn detect_handbrake_caps_ex(path: &Path) -> (HandbrakeCaps, bool) {
    let (caps, parse_ok, _raw) = detect_handbrake_caps_and_raw(path);
    (caps, parse_ok)
}

/// Run `HandBrakeCLI -h` ONCE and derive everything we read from it: the
/// hardware-encoder caps, whether the help parsed, and the compact raw encoder
/// line (evidence for the panel/log). Folding these into a single spawn avoids
/// the previous triple-invocation on the (cold) `tools_json` path.
pub(crate) fn detect_handbrake_caps_and_raw(path: &Path) -> (HandbrakeCaps, bool, String) {
    let text = match run_handbrake_help(path) {
        Some(t) => t,
        None => {
            return (
                HandbrakeCaps::default(),
                false,
                "<failed to run HandBrakeCLI -h>".to_string(),
            );
        }
    };
    // parse_ok: the command produced some help text to scan. An empty capture
    // (e.g. output went somewhere we couldn't read) is "unknown", not "absent".
    let parse_ok = text.trim().len() > 16;
    let t = text.to_ascii_lowercase();
    let has = |needle: &str| t.contains(needle);
    let caps = HandbrakeCaps {
        x265: has("x265"),
        svt_av1: has("svt_av1"),
        nvenc_h264: has("nvenc_h264"),
        nvenc_h265: has("nvenc_h265"),
        nvenc_av1: has("nvenc_av1"),
        qsv_h264: has("qsv_h264"),
        qsv_h265: has("qsv_h265"),
        qsv_av1: has("qsv_av1"),
        vce_h264: has("vce_h264"),
        vce_h265: has("vce_h265"),
        vce_av1: has("vce_av1"),
    };
    (caps, parse_ok, summarize_encoder_lines(&text))
}

/// Spawn `HandBrakeCLI -h` from the binary's own folder (so a build that loads
/// sibling DLLs / probes hardware relative to its install behaves like a normal
/// launch) and return combined stdout+stderr. `None` on spawn failure.
fn run_handbrake_help(path: &Path) -> Option<String> {
    let mut cmd = Command::new(path);
    cmd.arg("-h");
    if let Some(dir) = path.parent()
        && dir.is_dir()
    {
        cmd.current_dir(dir);
    }
    no_window(&mut cmd);
    let out = cmd.output().ok()?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Some(text)
}

/// Keep only the encoder-relevant lines of `-h` output, bounded, for compact
/// logging/diagnostics.
fn summarize_encoder_lines(text: &str) -> String {
    let tokens = [
        "x264", "x265", "nvenc", "qsv", "vce", "mpeg", "av1", "vp8", "vp9", "theora", "encoder",
    ];
    let mut kept: Vec<String> = Vec::new();
    for line in text.lines() {
        let low = line.to_ascii_lowercase();
        if tokens.iter().any(|tok| low.contains(tok)) {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                kept.push(trimmed.to_string());
            }
        }
        if kept.len() >= 40 {
            break;
        }
    }
    if kept.is_empty() {
        "<no encoder lines parsed from -h output>".to_string()
    } else {
        kept.join(" | ")
    }
}

/// Capture the encoder-relevant lines from `HandBrakeCLI -h` as evidence for the
/// debug log: exactly which encoder tokens THIS build reports.
pub(crate) fn handbrake_encoders_raw(path: &Path) -> String {
    match run_handbrake_help(path) {
        Some(text) => summarize_encoder_lines(&text),
        None => "<failed to run HandBrakeCLI -h>".to_string(),
    }
}

/// Every place we look for `HandBrakeCLI`, in priority order, that actually
/// exists on disk. Order matters: an explicit override and the app's tools dir
/// win over system installs, and a `PATH` hit is the last resort. Returning ALL
/// existing candidates (not just the first) lets [`detect_handbrake`] prefer a
/// hardware-capable build when more than one HandBrake is installed — the common
/// cause of "it encodes on CPU" is FileTree resolving a different/older
/// HandBrakeCLI than the GPU-capable one the user expects.
fn handbrake_candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let push_if_file = |p: PathBuf, out: &mut Vec<PathBuf>| {
        if p.is_file() && !out.iter().any(|e| e == &p) {
            out.push(p);
        }
    };

    // 1. Explicit override: env var pointing at a HandBrakeCLI(.exe) or its dir.
    //    Lets a user force the exact GPU-capable binary their other tools use.
    if let Some(over) = std::env::var_os("FILETREE_HANDBRAKE") {
        let p = PathBuf::from(over);
        if p.is_dir() {
            push_if_file(p.join("HandBrakeCLI.exe"), &mut out);
            push_if_file(p.join("HandBrakeCLI"), &mut out);
        } else {
            push_if_file(p, &mut out);
        }
    }

    // 2. App tools dir (a binary dropped here is intentionally preferred).
    push_if_file(tools_dir().join("HandBrakeCLI.exe"), &mut out);
    push_if_file(tools_dir().join("HandBrakeCLI"), &mut out);

    // 3. Common install locations across the usual roots (incl. 32-bit Program
    //    Files and per-user installs, which the old discovery missed).
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(pf) = program_files() {
        roots.push(pf);
    }
    for var in ["ProgramFiles(x86)", "ProgramW6432", "LOCALAPPDATA"] {
        if let Some(v) = std::env::var_os(var) {
            roots.push(PathBuf::from(v));
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("Programs"));
    }
    for root in roots {
        push_if_file(root.join("HandBrake").join("HandBrakeCLI.exe"), &mut out);
        push_if_file(root.join("HandBrake").join("HandBrakeCLI"), &mut out);
    }

    // 4. PATH (system-installed / portable on PATH).
    if let Some(p) = which("HandBrakeCLI.exe").or_else(|| which("HandBrakeCLI")) {
        push_if_file(p, &mut out);
    }

    out
}

/// Detect `HandBrakeCLI` for the video pipeline. When multiple HandBrake builds
/// are present, PREFER one that actually exposes a hardware encoder so the GPU
/// path isn't lost to an older/HW-less binary that merely happens to be found
/// first. Emits a one-line diagnostic of every candidate + its caps so a
/// "running on CPU" report is debuggable from the log.
pub(crate) fn detect_handbrake() -> ToolInfo {
    let candidates = handbrake_candidates();
    if candidates.is_empty() {
        return ToolInfo::default();
    }

    // Probe each candidate's caps, preferring the first GPU-capable one. Stop as
    // soon as a GPU-capable build is found to bound the number of `-h` spawns.
    let mut chosen: Option<(PathBuf, HandbrakeCaps)> = None;
    let mut diag = String::new();
    for cand in &candidates {
        let caps = detect_handbrake_caps(cand);
        if crate::compress_debug::enabled() {
            if !diag.is_empty() {
                diag.push_str("; ");
            }
            diag.push_str(&format!(
                "{}=[nvenc:{}/{} qsv:{}/{} vce:{}/{}]",
                cand.display(),
                caps.nvenc_h264,
                caps.nvenc_h265,
                caps.qsv_h264,
                caps.qsv_h265,
                caps.vce_h264,
                caps.vce_h265
            ));
        }
        let is_gpu = caps.any_gpu();
        if chosen.is_none() || (is_gpu && !chosen.as_ref().unwrap().1.any_gpu()) {
            chosen = Some((cand.clone(), caps));
            if is_gpu {
                break;
            }
        }
    }

    let (path, _caps) = chosen.expect("non-empty candidates");
    if crate::compress_debug::enabled() {
        crate::compress_debug::log(&format!(
            "[handbrake_detect] chose {} from candidates: {}",
            path.display(),
            diag
        ));
    }
    let version = capture_version(&path, &["--version"]);
    ToolInfo {
        found: true,
        path: Some(path),
        version,
    }
}

/// Detect the image encoder. Prefers `ffmpeg`, falls back to ImageMagick
/// (`magick`). Returns the kind so the pipeline can pick the right CLI shape.
/// Locate `ffmpeg` on its own (PATH + common install dirs), independent of the
/// image-tool selection. Used by the post-compression verification gate to
/// re-decode media: ffmpeg is the preferred verifier even when ImageMagick is
/// the chosen image encoder, and the video pipeline uses HandBrake (not ffmpeg)
/// so its presence isn't implied by HandBrake detection. Returns a not-found
/// `ToolInfo` when ffmpeg isn't installed (callers fall back to HandBrake
/// `--scan`).
pub(crate) fn detect_ffmpeg() -> ToolInfo {
    let mut ffmpeg_common = Vec::new();
    if let Some(pf) = program_files() {
        ffmpeg_common.push(pf.join("ffmpeg").join("bin").join("ffmpeg.exe"));
        ffmpeg_common.push(pf.join("ffmpeg").join("ffmpeg.exe"));
    }
    if let Some(path) =
        locate("ffmpeg.exe", &ffmpeg_common).or_else(|| locate("ffmpeg", &ffmpeg_common))
    {
        let version = capture_version(&path, &["-version"]);
        ToolInfo {
            found: true,
            path: Some(path),
            version,
        }
    } else {
        ToolInfo::default()
    }
}

pub(crate) fn detect_image() -> (ToolInfo, Option<ImageKind>) {
    let ff = detect_ffmpeg();
    if ff.found {
        return (ff, Some(ImageKind::Ffmpeg));
    }

    let mut magick_common = Vec::new();
    if let Some(pf) = program_files() {
        // ImageMagick installs into a versioned dir; the PATH/where lookup is the
        // reliable hit, but try the parent too.
        magick_common.push(pf.join("ImageMagick").join("magick.exe"));
    }
    if let Some(path) =
        locate("magick.exe", &magick_common).or_else(|| locate("magick", &magick_common))
    {
        let version = capture_version(&path, &["--version"]);
        return (
            ToolInfo {
                found: true,
                path: Some(path),
                version,
            },
            Some(ImageKind::ImageMagick),
        );
    }

    (ToolInfo::default(), None)
}

/// Cached `GET /api/compress-tools` body + when it was computed. Tool detection
/// shells out to `HandBrakeCLI -h`, `ffmpeg -version`, `where`, and PowerShell
/// (`probe_gpu_hardware`), so recomputing it on every request is wasteful —
/// nothing here changes within a few seconds of normal use.
struct ToolsCache {
    json: String,
    at: Instant,
}

fn tools_cache() -> &'static Mutex<Option<ToolsCache>> {
    static CACHE: OnceLock<Mutex<Option<ToolsCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// How long a cached tool-detection snapshot stays fresh. Short enough that
/// dropping a binary into the tools dir is reflected promptly even without an
/// explicit detect, long enough to coalesce the UI's repeated polls.
const TOOLS_TTL: Duration = Duration::from_secs(15);

/// Drop any cached tool-detection snapshot so the next `tools_json()` re-detects
/// immediately. Called after an install/detect attempt so a freshly-provisioned
/// binary shows up at once rather than after the TTL.
pub(crate) fn invalidate_tools_cache() {
    if let Ok(mut guard) = tools_cache().lock() {
        *guard = None;
    }
}

/// Build the `GET /api/compress-tools` JSON body, served from a short-lived
/// cache (see [`TOOLS_TTL`]). Use [`invalidate_tools_cache`] to force a refresh.
pub(crate) fn tools_json() -> String {
    if let Ok(guard) = tools_cache().lock()
        && let Some(c) = guard.as_ref()
        && c.at.elapsed() < TOOLS_TTL
    {
        return c.json.clone();
    }
    let json = tools_json_uncached();
    if let Ok(mut guard) = tools_cache().lock() {
        *guard = Some(ToolsCache {
            json: json.clone(),
            at: Instant::now(),
        });
    }
    json
}

/// Compute the tools JSON from scratch (detection + probes). Cold path behind
/// [`tools_json`]'s cache. Runs `HandBrakeCLI -h` only once for the chosen
/// binary (caps + raw encoder list parsed from the same output).
fn tools_json_uncached() -> String {
    let hb = detect_handbrake();
    let (img, kind) = detect_image();

    let (caps, parse_ok, raw) = hb
        .path
        .as_ref()
        .map(|p| detect_handbrake_caps_and_raw(p))
        .unwrap_or((
            HandbrakeCaps::default(),
            false,
            "<HandBrakeCLI not found>".to_string(),
        ));
    let vendors = GpuVendors::from_caps(&caps);
    let hw = probe_gpu_hardware();
    let eff = EffectiveCaps::compute(&caps, hw);

    let mut s = String::with_capacity(768);
    s.push_str("{\"handbrake\":");
    push_tool(&mut s, &hb, None);
    s.push_str(",\"image\":");
    push_tool(&mut s, &img, Some(kind));
    // The built-in zip is always available (pure-Rust, compiled in).
    s.push_str(",\"zip\":{\"found\":true}");
    // Hardware-encoder capabilities parsed from `-h` (may under-report; see
    // `available` for the effective gate that also trusts the hardware probe).
    s.push_str(",\"caps\":{");
    s.push_str(&format!("\"x265\":{}", caps.x265));
    s.push_str(&format!(",\"nvencH264\":{}", caps.nvenc_h264));
    s.push_str(&format!(",\"nvencH265\":{}", caps.nvenc_h265));
    s.push_str(&format!(",\"nvencAv1\":{}", caps.nvenc_av1));
    s.push_str(&format!(",\"qsvH264\":{}", caps.qsv_h264));
    s.push_str(&format!(",\"qsvH265\":{}", caps.qsv_h265));
    s.push_str(&format!(",\"qsvAv1\":{}", caps.qsv_av1));
    s.push_str(&format!(",\"vceH264\":{}", caps.vce_h264));
    s.push_str(&format!(",\"vceH265\":{}", caps.vce_h265));
    s.push_str(&format!(",\"vceAv1\":{}", caps.vce_av1));
    s.push_str(&format!(",\"anyGpu\":{}", caps.any_gpu()));
    s.push('}');
    // Effective availability: `-h` token OR matching physical adapter present.
    // This is what the UI should gate on; `*Assumed` means "adapter-only, not yet
    // confirmed by a real encode".
    s.push_str(",\"available\":{");
    s.push_str(&format!("\"nvenc\":{}", eff.nvenc));
    s.push_str(&format!(",\"qsv\":{}", eff.qsv));
    s.push_str(&format!(",\"vce\":{}", eff.vce));
    s.push_str(&format!(",\"anyGpu\":{}", eff.any_gpu()));
    s.push_str(&format!(",\"nvencAssumed\":{}", eff.nvenc_assumed));
    s.push_str(&format!(",\"qsvAssumed\":{}", eff.qsv_assumed));
    s.push_str(&format!(",\"vceAssumed\":{}", eff.vce_assumed));
    s.push('}');
    s.push_str(",\"gpu\":{");
    s.push_str(&format!("\"nvidia\":{}", vendors.nvidia));
    s.push_str(&format!(",\"intel\":{}", vendors.intel));
    s.push_str(&format!(",\"amd\":{}", vendors.amd));
    s.push('}');
    // Physical GPU adapters present (independent of HandBrake), so the UI can say
    // "you have a GPU but HandBrake can't use it" rather than just "no GPU".
    s.push_str(",\"gpuHardware\":{");
    s.push_str(&format!("\"nvidia\":{}", hw.nvidia));
    s.push_str(&format!(",\"intel\":{}", hw.intel));
    s.push_str(&format!(",\"amd\":{}", hw.amd));
    s.push_str(",\"names\":[");
    for (i, name) in hw.names.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        push_json_string(&mut s, name);
    }
    s.push_str("]}");
    // Ground-truth evidence for the panel: did `-h` parse, and the raw encoder line.
    s.push_str(&format!(",\"handbrakeHParseOk\":{}", parse_ok));
    s.push_str(",\"handbrakeEncodersRaw\":");
    push_json_string(&mut s, &raw);
    s.push('}');
    s
}

/// Serialize one tool object. When `kind` is `Some(..)` an image-tool `kind`
/// field is emitted (`"ffmpeg"` | `"imagemagick"` | `null`).
fn push_tool(s: &mut String, info: &ToolInfo, kind: Option<Option<ImageKind>>) {
    s.push_str("{\"found\":");
    s.push_str(if info.found { "true" } else { "false" });
    s.push_str(",\"version\":");
    match &info.version {
        Some(v) => push_json_string(s, v),
        None => s.push_str("null"),
    }
    s.push_str(",\"path\":");
    match &info.path {
        Some(p) => push_json_string(s, &p.to_string_lossy()),
        None => s.push_str("null"),
    }
    if let Some(kind) = kind {
        s.push_str(",\"kind\":");
        match kind {
            Some(k) => push_json_string(s, k.as_str()),
            None => s.push_str("null"),
        }
    }
    s.push('}');
}

/// Official download URLs surfaced to the UI when a tool is missing and the
/// in-app fetch is unavailable (see module docs for the deviation note).
fn download_url(tool: &str) -> &'static str {
    match tool {
        "handbrake" => "https://handbrake.fr/downloads.php",
        // gyan.dev hosts the canonical Windows ffmpeg builds linked from
        // ffmpeg.org. ImageMagick is the documented fallback.
        "image" => "https://www.gyan.dev/ffmpeg/builds/",
        _ => "",
    }
}

/// Handle `POST /api/compress-tools/install`.
///
/// Behaviour (hybrid, see module docs): re-detect the requested tool first —
/// this picks up a binary dropped into the tools dir — and report `ok:true`
/// with its path if present. Otherwise return `ok:false` with the official
/// `downloadUrl` so the UI can link the user out. This build does not fetch
/// bytes itself (documented deviation).
pub(crate) fn install_json(tool: &str) -> String {
    // A detect/install attempt may have changed what's on disk (a binary dropped
    // into the tools dir), so drop any cached tools snapshot — the next
    // `GET /api/compress-tools` then reflects reality immediately.
    invalidate_tools_cache();
    let (found, path) = match tool {
        "handbrake" => {
            let info = detect_handbrake();
            (info.found, info.path)
        }
        "image" => {
            let (info, _kind) = detect_image();
            (info.found, info.path)
        }
        _ => {
            return "{\"ok\":false,\"error\":\"Unknown tool (expected \\\"handbrake\\\" or \\\"image\\\")\"}".to_string();
        }
    };

    let mut s = String::with_capacity(256);
    if found {
        s.push_str("{\"ok\":true,\"path\":");
        match path {
            Some(p) => push_json_string(&mut s, &p.to_string_lossy()),
            None => s.push_str("null"),
        }
        s.push('}');
    } else {
        // Ensure the tools dir exists so the user has somewhere to drop the
        // portable binary the linked download produces.
        let _ = std::fs::create_dir_all(tools_dir());
        s.push_str("{\"ok\":false,\"error\":");
        push_json_string(
            &mut s,
            &format!(
                "Automatic download is not available in this build. Download {tool} from the official site and place the executable in {}, then click Detect again.",
                tools_dir().to_string_lossy()
            ),
        );
        s.push_str(",\"downloadUrl\":");
        push_json_string(&mut s, download_url(tool));
        s.push('}');
    }
    s
}

// ── GPU encode probe (definitive hardware-only validation) ──────────────────

/// Write a tiny, valid YUV4MPEG2 (`.y4m`) clip to a temp file for a real encode
/// test. Generated in pure Rust — no bundled binary asset, no external tool —
/// and decodable by HandBrake's libav demuxer. 128×128, 8 frames of a moving
/// gradient (real content so the encoder actually does work). Returns the path.
fn write_test_clip() -> Option<PathBuf> {
    const W: usize = 128;
    const H: usize = 128;
    const FRAMES: usize = 8;
    let y_size = W * H;
    let c_size = (W / 2) * (H / 2);
    let mut data: Vec<u8> = Vec::with_capacity(64 + FRAMES * (6 + y_size + 2 * c_size));
    data.extend_from_slice(format!("YUV4MPEG2 W{W} H{H} F25:1 Ip A1:1 C420jpeg\n").as_bytes());
    for f in 0..FRAMES {
        data.extend_from_slice(b"FRAME\n");
        // Luma: a diagonal gradient that shifts per frame (gives the encoder
        // motion + detail, so a HW path that no-ops on a flat frame still runs).
        for j in 0..H {
            for i in 0..W {
                data.push(((i + j + f * 16) & 0xff) as u8);
            }
        }
        // Neutral chroma planes.
        data.extend(std::iter::repeat_n(128u8, 2 * c_size));
    }
    let path = std::env::temp_dir().join("filetree_gpuprobe.y4m");
    std::fs::write(&path, &data).ok()?;
    Some(path)
}

/// Outcome of one encode probe.
struct ProbeOutcome {
    encoder: String,
    is_gpu: bool,
    success: bool,
    ms: u128,
    out_bytes: u64,
    exit_code: Option<i32>,
    stderr_tail: String,
}

/// Run HandBrake once on the test clip with `encoder_token`, timing the encode
/// and capturing success/size/stderr. The output temp file is removed.
fn run_encode_probe(hb: &Path, src: &Path, encoder_token: &str, is_gpu: bool) -> ProbeOutcome {
    let out = std::env::temp_dir().join(format!("filetree_gpuprobe_out_{encoder_token}.mp4"));
    let _ = std::fs::remove_file(&out);
    let enc_preset = if is_gpu { "quality" } else { "veryfast" };
    let mut cmd = Command::new(hb);
    cmd.arg("-i").arg(src).arg("-o").arg(&out);
    cmd.args([
        "-e",
        encoder_token,
        "-q",
        "30",
        "--encoder-preset",
        enc_preset,
    ]);
    if let Some(dir) = hb.parent()
        && dir.is_dir()
    {
        cmd.current_dir(dir);
    }
    no_window(&mut cmd);
    let start = Instant::now();
    let result = cmd.output();
    let ms = start.elapsed().as_millis();
    let outcome = match result {
        Ok(o) => {
            let out_bytes = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
            let success = o.status.success() && out_bytes > 0;
            let mut tail = String::from_utf8_lossy(&o.stderr).into_owned();
            let trimmed = tail.trim();
            if trimmed.len() > 600 {
                tail = trimmed[trimmed.len() - 600..].to_string();
            } else {
                tail = trimmed.to_string();
            }
            ProbeOutcome {
                encoder: encoder_token.to_string(),
                is_gpu,
                success,
                ms,
                out_bytes,
                exit_code: o.status.code(),
                stderr_tail: tail,
            }
        }
        Err(e) => ProbeOutcome {
            encoder: encoder_token.to_string(),
            is_gpu,
            success: false,
            ms,
            out_bytes: 0,
            exit_code: None,
            stderr_tail: format!("failed to start HandBrakeCLI: {e}"),
        },
    };
    let _ = std::fs::remove_file(&out);
    outcome
}

fn push_probe_fields(s: &mut String, p: &ProbeOutcome) {
    s.push_str("\"encoder\":");
    push_json_string(s, &p.encoder);
    s.push_str(&format!(",\"isGpu\":{}", p.is_gpu));
    s.push_str(&format!(",\"success\":{}", p.success));
    s.push_str(&format!(",\"ms\":{}", p.ms));
    s.push_str(&format!(",\"outBytes\":{}", p.out_bytes));
    s.push_str(",\"exitCode\":");
    match p.exit_code {
        Some(c) => s.push_str(&c.to_string()),
        None => s.push_str("null"),
    }
    s.push_str(",\"stderr\":");
    push_json_string(s, &p.stderr_tail);
}

/// Handle `POST /api/compress-tools/test-gpu`: a definitive hardware-encode check
/// that actually runs the resolved GPU encoder on a tiny generated clip — beyond
/// `-h`/adapter inference. `{ok:false,error}` when HandBrake is missing or no GPU
/// encoder resolves; otherwise `{ok:true, <probe fields>}` with `success` telling
/// whether the GPU encode genuinely worked.
pub(crate) fn test_gpu_json(encoder: &str, codec: &str) -> String {
    let hb = detect_handbrake();
    let Some(hb_path) = hb.path.as_ref() else {
        return "{\"ok\":false,\"error\":\"HandBrakeCLI not found\"}".to_string();
    };
    let (caps, _ok, _raw) = detect_handbrake_caps_and_raw(hb_path);
    let hw = probe_gpu_hardware();
    // Resolve what the real pipeline would use for a GPU run of this codec.
    let enc = crate::compress_job::select_video_encoder(encoder, codec, true, &caps, hw);
    if !enc.is_gpu {
        let mut s = String::from("{\"ok\":false,\"error\":");
        push_json_string(
            &mut s,
            "No GPU encoder is available for this codec/selection (would run on the CPU).",
        );
        s.push_str(",\"resolvedEncoder\":");
        push_json_string(&mut s, &enc.hb);
        s.push('}');
        return s;
    }
    let Some(clip) = write_test_clip() else {
        return "{\"ok\":false,\"error\":\"Could not create a test clip\"}".to_string();
    };
    let probe = run_encode_probe(hb_path, &clip, &enc.hb, true);
    let _ = std::fs::remove_file(&clip);
    let mut s = String::from("{\"ok\":true,");
    push_probe_fields(&mut s, &probe);
    s.push('}');
    s
}

/// Backward-compatible `POST /api/compress-tools/autotune` response. The old
/// endpoint compared CPU and GPU encoders; hardware-only mode now probes only
/// the best GPU encoder and always recommends hardware. `cpu:null` keeps older
/// clients able to parse the additive response without ever launching x264.
pub(crate) fn autotune_json(codec: &str) -> String {
    let hb = detect_handbrake();
    let Some(hb_path) = hb.path.as_ref() else {
        return "{\"ok\":false,\"error\":\"HandBrakeCLI not found\"}".to_string();
    };
    let (caps, _ok, _raw) = detect_handbrake_caps_and_raw(hb_path);
    let hw = probe_gpu_hardware();
    let Some(clip) = write_test_clip() else {
        return "{\"ok\":false,\"error\":\"Could not create a test clip\"}".to_string();
    };

    // Best GPU encoder for the codec (NVENC > QSV > VCE). Selection itself has
    // no software return path, even when capability probing is inconclusive.
    let gpu_enc = crate::compress_job::select_video_encoder("auto", codec, true, &caps, hw);
    let gpu = run_encode_probe(hb_path, &clip, &gpu_enc.hb, true);
    let rec_encoder = if gpu.encoder.starts_with("nvenc") {
        "nvenc"
    } else if gpu.encoder.starts_with("qsv") {
        "qsv"
    } else if gpu.encoder.starts_with("vce") {
        "vce"
    } else {
        "auto"
    };
    let _ = std::fs::remove_file(&clip);

    let mut s = String::from("{\"ok\":true,\"cpu\":null,\"gpu\":{");
    push_probe_fields(&mut s, &gpu);
    s.push('}');
    s.push_str(",\"recommendedEncoder\":");
    push_json_string(&mut s, rec_encoder);
    s.push_str(",\"recommendedUseGpu\":true");
    s.push('}');
    s
}
