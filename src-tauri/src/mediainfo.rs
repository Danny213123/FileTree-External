//! Media insight: what a folder's video actually is, and what it wastes.
//!
//! A scan shows a 12 GB file; it does not show that the file is a 1080p clip at
//! 40 Mbit/s that would look the same at a third of the size. This runs ffprobe
//! over the biggest media in a folder, then ranks by the bytes a re-encode would
//! plausibly save, so the compression queue can be pointed at the files worth
//! its time rather than at whatever happens to be large.

use crate::tools;
use serde::Serialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const MEDIA_EXTENSIONS: [&str; 12] = [
    "mp4", "mkv", "mov", "avi", "wmv", "m4v", "ts", "webm", "flv", "mpg", "mpeg", "m2ts",
];
/// ffprobe is a process per file; this is how many run at once.
const WORKERS: usize = 4;
const MAX_FILES: usize = 2_000;

#[derive(Serialize, PartialEq, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Media {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// Seconds, when the container reports a duration.
    pub duration: Option<f64>,
    /// Bits per second over the whole file, derived from size and duration when
    /// the container does not state it.
    pub bitrate: Option<u64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// What this height is worth re-encoding down to, bits per second.
    pub target_bitrate: Option<u64>,
    /// Bytes a re-encode to `target_bitrate` would plausibly save.
    pub savings: u64,
    /// ffprobe's complaint, for a file it could not read.
    pub error: Option<String>,
}

/// A sane bitrate for a height, in bits per second.
///
/// These are deliberately generous — the point is to find the file at four
/// times a reasonable rate, not to argue about the last megabit — and modern
/// codecs get a lower target because they hold up better at one.
pub(crate) fn target_bitrate(height: u32, codec: &str) -> u64 {
    let base: u64 = match height {
        0..=480 => 1_500_000,
        481..=720 => 3_000_000,
        721..=1080 => 6_000_000,
        1081..=1440 => 10_000_000,
        _ => 18_000_000,
    };
    // Already in an efficient codec: less to gain, so demand more before
    // calling a file wasteful.
    if matches!(codec, "hevc" | "h265" | "av1" | "vp9") {
        base * 3 / 2
    } else {
        base
    }
}

/// Bytes a re-encode would save, or zero when the file is already lean.
pub(crate) fn savings(size: u64, bitrate: Option<u64>, target: Option<u64>) -> u64 {
    match (bitrate, target) {
        (Some(bitrate), Some(target)) if bitrate > target && bitrate > 0 => {
            let kept = (size as u128 * target as u128 / bitrate as u128) as u64;
            size.saturating_sub(kept)
        }
        _ => 0,
    }
}

/// What one ffprobe run says about a file, before it is scored.
#[derive(Default, PartialEq, Debug)]
pub(crate) struct Probed {
    pub duration: Option<f64>,
    pub bitrate: Option<u64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// Pull the fields worth showing out of `ffprobe -print_format json`.
pub(crate) fn parse_probe(output: &str, size: u64) -> Result<Probed, String> {
    let value: Value =
        serde_json::from_str(output).map_err(|_| "ffprobe did not answer with JSON".to_string())?;
    let format = &value["format"];
    let number = |field: &Value| -> Option<f64> {
        field
            .as_f64()
            .or_else(|| field.as_str().and_then(|text| text.parse().ok()))
    };
    let duration = number(&format["duration"]).filter(|seconds| *seconds > 0.0);
    let streams = value["streams"].as_array().cloned().unwrap_or_default();
    let stream_of = |kind: &str| {
        streams
            .iter()
            .find(|stream| stream["codec_type"].as_str() == Some(kind))
            .cloned()
    };
    let video = stream_of("video");
    let audio = stream_of("audio");
    // A container that states its bitrate is trusted; otherwise it is the file
    // size over its duration, which is what actually matters on disk anyway.
    let bitrate = number(&format["bit_rate"])
        .map(|value| value as u64)
        .or_else(|| duration.map(|seconds| ((size as f64 * 8.0) / seconds) as u64))
        .filter(|rate| *rate > 0);
    let dimension = |field: &str| {
        video
            .as_ref()
            .and_then(|stream| stream[field].as_u64().map(|value| value as u32))
    };
    let codec = |stream: &Option<Value>| {
        stream
            .as_ref()
            .and_then(|stream| stream["codec_name"].as_str().map(str::to_string))
    };
    Ok(Probed {
        duration,
        bitrate,
        video_codec: codec(&video),
        audio_codec: codec(&audio),
        width: dimension("width"),
        height: dimension("height"),
    })
}

fn ffprobe(configured: &str) -> Result<PathBuf, String> {
    let mut common = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        common.push(PathBuf::from(appdata).join("FileTree\\tools\\ffprobe.exe"));
    }
    common.extend(tools::program_files("ffmpeg\\bin\\ffprobe.exe"));
    common.extend(tools::program_files("ffmpeg\\ffprobe.exe"));
    tools::locate(configured, "ffprobe.exe", &common).ok_or_else(|| {
        "ffprobe was not found. Install ffmpeg, drop ffprobe.exe in FileTree's tools folder, \
         or set its path in this panel."
            .to_string()
    })
}

/// Media files under `root`, biggest first.
fn media_files(root: &Path) -> Result<Vec<(PathBuf, u64)>, String> {
    let mut found = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue; // An unreadable folder is skipped, not fatal.
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file()
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| MEDIA_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
                    .unwrap_or(false)
            {
                found.push((path, meta.len()));
            }
            if found.len() >= MAX_FILES {
                break;
            }
        }
    }
    found.sort_by(|a, b| b.1.cmp(&a.1));
    Ok(found)
}

fn probe_one(exe: &Path, path: &Path, size: u64) -> Media {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let args = [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        &path.to_string_lossy(),
    ]
    .map(str::to_string);
    let mut media = Media {
        path: path.to_string_lossy().into_owned(),
        name,
        size,
        duration: None,
        bitrate: None,
        video_codec: None,
        audio_codec: None,
        width: None,
        height: None,
        target_bitrate: None,
        savings: 0,
        error: None,
    };
    match tools::run(exe, &args, &[]).and_then(|output| parse_probe(&output, size)) {
        Ok(probed) => {
            let codec = probed
                .video_codec
                .clone()
                .unwrap_or_default()
                .to_lowercase();
            let target = probed.height.map(|height| target_bitrate(height, &codec));
            media.savings = savings(size, probed.bitrate, target);
            media.duration = probed.duration;
            media.bitrate = probed.bitrate;
            media.video_codec = probed.video_codec;
            media.audio_codec = probed.audio_codec;
            media.width = probed.width;
            media.height = probed.height;
            media.target_bitrate = target;
        }
        Err(error) => media.error = Some(error),
    }
    media
}

#[tauri::command]
pub(crate) async fn media_probe(folder: String, limit: u32, exe: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(folder.trim());
        if !root.is_dir() {
            return Err(format!("{} is not a folder", root.display()));
        }
        let probe = ffprobe(&exe)?;
        let files = media_files(&root)?;
        let total = files.len();
        let wanted: Vec<(PathBuf, u64)> = files
            .into_iter()
            .take(limit.clamp(1, 500) as usize)
            .collect();

        // ffprobe is a process per file; a handful at a time keeps a big folder
        // from taking minutes without drowning the machine in processes.
        let queue = Arc::new(Mutex::new(wanted.clone().into_iter().enumerate()));
        let results: Arc<Mutex<Vec<(usize, Media)>>> = Arc::new(Mutex::new(Vec::new()));
        std::thread::scope(|scope| {
            for _ in 0..WORKERS.min(wanted.len().max(1)) {
                let queue = Arc::clone(&queue);
                let results = Arc::clone(&results);
                let probe = probe.clone();
                scope.spawn(move || {
                    loop {
                        let next = queue.lock().ok().and_then(|mut items| items.next());
                        let Some((index, (path, size))) = next else {
                            break;
                        };
                        let media = probe_one(&probe, &path, size);
                        if let Ok(mut out) = results.lock() {
                            out.push((index, media));
                        }
                    }
                });
            }
        });

        let mut media: Vec<Media> = Arc::try_unwrap(results)
            .map_err(|_| "probe workers outlived the run".to_string())?
            .into_inner()
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|(_, media)| media)
            .collect();
        // Biggest win first: that is the order someone acts on.
        media.sort_by(|a, b| b.savings.cmp(&a.savings).then(b.size.cmp(&a.size)));
        let reclaimable: u64 = media.iter().map(|item| item.savings).sum();
        Ok(json!({
            "files": media,
            "probed": media.len(),
            "found": total,
            "reclaimable": reclaimable,
            "ffprobe": probe.display().to_string(),
        }))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROBE: &str = r#"{
      "streams":[
        {"codec_type":"video","codec_name":"h264","width":1920,"height":1080},
        {"codec_type":"audio","codec_name":"aac"}],
      "format":{"duration":"600.0","bit_rate":"40000000"}}"#;

    #[test]
    fn reads_the_fields_worth_showing() {
        let probed = parse_probe(PROBE, 3_000_000_000).unwrap();
        assert_eq!(
            probed,
            Probed {
                duration: Some(600.0),
                bitrate: Some(40_000_000),
                video_codec: Some("h264".into()),
                audio_codec: Some("aac".into()),
                width: Some(1920),
                height: Some(1080),
            }
        );
    }

    #[test]
    fn derives_a_bitrate_the_container_does_not_state() {
        let output = r#"{"streams":[],"format":{"duration":"100.0"}}"#;
        // 12.5 MB over 100s
        assert_eq!(
            parse_probe(output, 12_500_000).unwrap().bitrate,
            Some(1_000_000)
        );
    }

    #[test]
    fn asks_more_of_an_efficient_codec_before_calling_it_wasteful() {
        assert_eq!(target_bitrate(1080, "h264"), 6_000_000);
        assert_eq!(target_bitrate(1080, "hevc"), 9_000_000);
        assert_eq!(target_bitrate(2160, "h264"), 18_000_000);
    }

    #[test]
    fn estimates_savings_only_above_the_target() {
        // 40 Mbit/s down to 6 leaves 15% of the bytes.
        assert_eq!(savings(1000, Some(40_000_000), Some(6_000_000)), 850);
        assert_eq!(savings(1000, Some(4_000_000), Some(6_000_000)), 0);
        assert_eq!(savings(1000, None, Some(6_000_000)), 0);
    }

    #[test]
    fn refuses_output_that_is_not_json() {
        assert!(parse_probe("ffprobe: not found", 10).is_err());
    }
}
