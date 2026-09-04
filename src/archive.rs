//! F5 Archive (zip create/extract) + file checksums.
//!
//! `compress` zips a selection of files/folders into a `.zip` using the pure-Rust
//! Deflate backend (entries stored with forward-slash relative names so the
//! archive is portable). `extract` unzips into a destination directory, guarding
//! against zip-slip via `ZipFile::enclosed_name`. `checksum` streams a file in
//! fixed-size chunks through a SHA-256 or MD5 hasher so a large file is never
//! loaded whole.
//!
//! Path containment (every read/written path staying inside a scanned root) is
//! enforced by the caller in `server.rs`; this module is pure I/O + hashing.

use std::fmt::Write as _;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::Path;

use md5::Md5;
use sha2::{Digest, Sha256};
use zip::CompressionMethod;
use zip::write::{SimpleFileOptions, ZipWriter};

/// I/O chunk for streaming file bodies (into the zip, out of the zip, through a
/// hasher). 64 KiB keeps syscalls amortized without holding a whole file.
const CHUNK: usize = 64 * 1024;
/// ZIP32 cannot represent an entry at or above 4 GiB. Enable ZIP64 before
/// writing those files so the writer does not fail after streaming gigabytes.
const ZIP32_ENTRY_LIMIT: u64 = u32::MAX as u64;

fn needs_zip64(size: u64) -> bool {
    size >= ZIP32_ENTRY_LIMIT
}

/// Create `dest` (a `.zip`) containing every path in `paths` at the default
/// Deflate level. Kept for the F5 zip endpoint; delegates to
/// [`compress_with_level`].
pub(crate) fn compress(paths: &[String], dest: &Path) -> Result<(), String> {
    compress_with_level(paths, dest, 6)
}

/// Extensions whose contents are already entropy-coded: storing (no Deflate)
/// avoids wasting CPU re-compressing data that won't shrink.
fn is_precompressed(path: &Path) -> bool {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    matches!(
        ext.as_str(),
        "zip"
            | "7z"
            | "rar"
            | "gz"
            | "bz2"
            | "xz"
            | "zst"
            | "lz4"
            | "cab"
            | "tgz"
            | "jpg"
            | "jpeg"
            | "png"
            | "gif"
            | "webp"
            | "avif"
            | "heic"
            | "mp4"
            | "mkv"
            | "mov"
            | "m4v"
            | "webm"
            | "m4a"
            | "aac"
            | "mp3"
            | "ogg"
            | "flac"
            | "docx"
            | "xlsx"
            | "pptx"
    )
}

/// Per-entry options: store (level 0) for already-compressed inputs, otherwise
/// Deflate at `level` (0..=9). Storing such files is both faster and avoids the
/// pathological slight *growth* Deflate can add to incompressible data.
fn entry_options(path: &Path, level: i64) -> SimpleFileOptions {
    let large_file = fs::metadata(path)
        .map(|metadata| needs_zip64(metadata.len()))
        .unwrap_or(false);
    let base = SimpleFileOptions::default()
        .unix_permissions(0o644)
        .large_file(large_file);
    if level <= 0 || is_precompressed(path) {
        base.compression_method(CompressionMethod::Stored)
    } else {
        base.compression_method(CompressionMethod::Deflated)
            .compression_level(Some(level.clamp(1, 9)))
    }
}

/// Create `dest` (a `.zip`) containing every path in `paths` at Deflate `level`
/// (0 = store everything). Files are added under their base name; directories
/// are added recursively with their name as the entry prefix. Already-compressed
/// inputs are stored (no-compress) regardless of `level`. Errors are returned as
/// display strings for the JSON body.
pub(crate) fn compress_with_level(paths: &[String], dest: &Path, level: i64) -> Result<(), String> {
    compress_with_level_impl(paths, dest, level, &|| false).map(|_| ())
}

/// Cancellable compression used by background compression jobs. Returns
/// `Ok(false)` when cancellation was observed; callers can then remove the
/// incomplete destination without treating a user stop as an encoder error.
pub(crate) fn compress_with_level_cancellable(
    paths: &[String],
    dest: &Path,
    level: i64,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<bool, String> {
    compress_with_level_impl(paths, dest, level, &|| {
        cancel.load(std::sync::atomic::Ordering::Relaxed)
    })
}

fn compress_with_level_impl<F>(
    paths: &[String],
    dest: &Path,
    level: i64,
    cancelled: &F,
) -> Result<bool, String>
where
    F: Fn() -> bool,
{
    if cancelled() {
        return Ok(false);
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = File::create(dest).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);
    let mut buf = vec![0u8; CHUNK];

    for raw in paths {
        if cancelled() {
            return Ok(false);
        }
        let src = Path::new(raw);
        let Ok(md) = fs::symlink_metadata(src) else {
            return Err(format!("{raw}: source does not exist"));
        };
        let base = src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "entry".to_string());
        if md.is_dir() {
            if !add_dir(&mut zip, src, &base, level, &mut buf, cancelled)? {
                return Ok(false);
            }
        } else if md.is_file() {
            zip.start_file(base, entry_options(src, level))
                .map_err(|e| e.to_string())?;
            if !stream_file(&mut zip, src, &mut buf, cancelled)? {
                return Ok(false);
            }
        }
    }
    if cancelled() {
        return Ok(false);
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(true)
}

/// Recursively add `dir` (and its subtree) to the archive under `prefix`. Empty
/// directories are preserved via an explicit directory entry.
fn add_dir<W, F>(
    zip: &mut ZipWriter<W>,
    dir: &Path,
    prefix: &str,
    level: i64,
    buf: &mut [u8],
    cancelled: &F,
) -> Result<bool, String>
where
    W: io::Write + io::Seek,
    F: Fn() -> bool,
{
    if cancelled() {
        return Ok(false);
    }
    let dir_options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .unix_permissions(0o644);
    zip.add_directory(format!("{prefix}/"), dir_options)
        .map_err(|e| e.to_string())?;
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let entry_name = format!("{prefix}/{name}");
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            if !add_dir(zip, &path, &entry_name, level, buf, cancelled)? {
                return Ok(false);
            }
        } else if ft.is_file() {
            zip.start_file(entry_name, entry_options(&path, level))
                .map_err(|e| e.to_string())?;
            if !stream_file(zip, &path, buf, cancelled)? {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

fn stream_file<W, F>(
    zip: &mut ZipWriter<W>,
    src: &Path,
    buf: &mut [u8],
    cancelled: &F,
) -> Result<bool, String>
where
    W: io::Write + io::Seek,
    F: Fn() -> bool,
{
    let mut f = File::open(src).map_err(|e| e.to_string())?;
    loop {
        if cancelled() {
            return Ok(false);
        }
        let n = f.read(buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        zip.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    }
    Ok(true)
}

/// Extract `archive` into `dest` (created if absent). Entry names are resolved
/// through `enclosed_name`, which rejects absolute paths and `..` traversal
/// (zip-slip), so nothing is ever written outside `dest`.
pub(crate) fn extract(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;

    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name() else {
            return Err(format!("unsafe entry name: {}", entry.name()));
        };
        let outpath = dest.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = outpath.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = File::create(&outpath).map_err(|e| e.to_string())?;
            io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Integrity-verify a produced `.zip` by opening it and reading EVERY entry to
/// the end, which forces the `zip` crate to validate each entry's stored CRC32
/// against the decompressed bytes. Any structural problem (truncated/corrupt
/// central directory, unreadable entry) or CRC mismatch is returned as an error.
/// An archive with no entries is also rejected. This is the post-compression
/// integrity gate for the zip pipeline — it never mutates the archive.
pub(crate) fn verify_archive(archive: &Path) -> Result<(), String> {
    verify_archive_impl(archive, &|| false).map(|_| ())
}

/// Cancellable variant of [`verify_archive`] for compression jobs. Like the
/// compression helper, `Ok(false)` means a user stop was observed.
pub(crate) fn verify_archive_cancellable(
    archive: &Path,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<bool, String> {
    verify_archive_impl(archive, &|| {
        cancel.load(std::sync::atomic::Ordering::Relaxed)
    })
}

fn verify_archive_impl<F>(archive: &Path, cancelled: &F) -> Result<bool, String>
where
    F: Fn() -> bool,
{
    if cancelled() {
        return Ok(false);
    }
    let file = File::open(archive).map_err(|e| format!("open archive: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("read archive: {e}"))?;
    if zip.is_empty() {
        return Err("archive contains no entries".to_string());
    }
    let mut buf = vec![0u8; CHUNK];
    for i in 0..zip.len() {
        if cancelled() {
            return Ok(false);
        }
        let mut entry = zip.by_index(i).map_err(|e| format!("entry {i}: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        // Reading to EOF makes the zip crate verify this entry's CRC32; a
        // mismatch surfaces as an io error here.
        loop {
            if cancelled() {
                return Ok(false);
            }
            let n = entry.read(&mut buf).map_err(|e| format!("{name}: {e}"))?;
            if n == 0 {
                break;
            }
        }
    }
    Ok(true)
}

/// Stream `path` through the requested hasher and return `(normalized_algo,
/// lowercase_hex)`. `algo` is matched case-insensitively; only `sha256` and
/// `md5` are supported.
pub(crate) fn checksum(path: &Path, algo: &str) -> Result<(String, String), String> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; CHUNK];
    let normalized = algo.to_ascii_lowercase();
    let hex = match normalized.as_str() {
        "sha256" => {
            let mut hasher = Sha256::new();
            loop {
                let n = f.read(&mut buf).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
            }
            to_hex(hasher.finalize())
        }
        "md5" => {
            let mut hasher = Md5::new();
            loop {
                let n = f.read(&mut buf).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
            }
            to_hex(hasher.finalize())
        }
        other => return Err(format!("unsupported algo: {other} (use sha256 or md5)")),
    };
    Ok((normalized, hex))
}

fn to_hex(bytes: impl AsRef<[u8]>) -> String {
    let bytes = bytes.as_ref();
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(out, "{b:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zip64_is_selected_before_the_zip32_entry_limit() {
        assert!(!needs_zip64((u32::MAX as u64) - 1));
        assert!(needs_zip64(u32::MAX as u64));
        assert!(needs_zip64(7_303_577_911));
    }

    #[test]
    fn cancellable_zip_stops_before_creating_an_output() {
        let cancel = std::sync::atomic::AtomicBool::new(true);
        let dest =
            std::env::temp_dir().join(format!("filetree-cancelled-zip-{}.zip", std::process::id()));
        let _ = fs::remove_file(&dest);

        let completed =
            compress_with_level_cancellable(&["unused-source.txt".to_string()], &dest, 6, &cancel)
                .expect("pre-cancel is not an archive error");

        assert!(!completed);
        assert!(!dest.exists());
    }

    #[test]
    fn zip_loop_observes_cancellation_between_chunks() {
        let root =
            std::env::temp_dir().join(format!("filetree-cancel-midstream-{}", std::process::id()));
        let source = root.join("source.bin");
        let dest = root.join("output.zip");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create test directory");
        fs::write(&source, vec![0x5a; CHUNK * 4]).expect("write test source");

        let checks = std::cell::Cell::new(0usize);
        let completed =
            compress_with_level_impl(&[source.to_string_lossy().into_owned()], &dest, 6, &|| {
                let next = checks.get() + 1;
                checks.set(next);
                next >= 5
            })
            .expect("cancellation is not an archive error");

        assert!(!completed);
        assert!(checks.get() >= 5);
        let _ = fs::remove_dir_all(root);
    }
}
