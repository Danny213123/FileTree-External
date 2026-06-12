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

/// Detect `HandBrakeCLI` for the video pipeline.
pub(crate) fn detect_handbrake() -> ToolInfo {
    let mut common = Vec::new();
    if let Some(pf) = program_files() {
        common.push(pf.join("HandBrake").join("HandBrakeCLI.exe"));
        common.push(pf.join("HandBrake").join("HandBrakeCLI"));
    }
    match locate("HandBrakeCLI.exe", &common).or_else(|| locate("HandBrakeCLI", &common)) {
        Some(path) => {
            let version = capture_version(&path, &["--version"]);
            ToolInfo { found: true, path: Some(path), version }
        }
        None => ToolInfo::default(),
    }
}

/// Detect the image encoder. Prefers `ffmpeg`, falls back to ImageMagick
/// (`magick`). Returns the kind so the pipeline can pick the right CLI shape.
pub(crate) fn detect_image() -> (ToolInfo, Option<ImageKind>) {
    let mut ffmpeg_common = Vec::new();
    if let Some(pf) = program_files() {
        ffmpeg_common.push(pf.join("ffmpeg").join("bin").join("ffmpeg.exe"));
        ffmpeg_common.push(pf.join("ffmpeg").join("ffmpeg.exe"));
    }
    if let Some(path) = locate("ffmpeg.exe", &ffmpeg_common).or_else(|| locate("ffmpeg", &ffmpeg_common)) {
        let version = capture_version(&path, &["-version"]);
        return (
            ToolInfo { found: true, path: Some(path), version },
            Some(ImageKind::Ffmpeg),
        );
    }

    let mut magick_common = Vec::new();
    if let Some(pf) = program_files() {
        // ImageMagick installs into a versioned dir; the PATH/where lookup is the
        // reliable hit, but try the parent too.
        magick_common.push(pf.join("ImageMagick").join("magick.exe"));
    }
    if let Some(path) = locate("magick.exe", &magick_common).or_else(|| locate("magick", &magick_common)) {
        let version = capture_version(&path, &["--version"]);
        return (
            ToolInfo { found: true, path: Some(path), version },
            Some(ImageKind::ImageMagick),
        );
    }

    (ToolInfo::default(), None)
}

/// Build the `GET /api/compress-tools` JSON body.
pub(crate) fn tools_json() -> String {
    let hb = detect_handbrake();
    let (img, kind) = detect_image();

    let mut s = String::with_capacity(512);
    s.push_str("{\"handbrake\":");
    push_tool(&mut s, &hb, None);
    s.push_str(",\"image\":");
    push_tool(&mut s, &img, Some(kind));
    // The built-in zip is always available (pure-Rust, compiled in).
    s.push_str(",\"zip\":{\"found\":true}}");
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
