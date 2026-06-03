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
use zip::write::{SimpleFileOptions, ZipWriter};
use zip::CompressionMethod;

/// I/O chunk for streaming file bodies (into the zip, out of the zip, through a
/// hasher). 64 KiB keeps syscalls amortized without holding a whole file.
const CHUNK: usize = 64 * 1024;

/// Create `dest` (a `.zip`) containing every path in `paths`. Files are added
/// under their base name; directories are added recursively with their name as
/// the entry prefix. Errors are returned as display strings for the JSON body.
pub(crate) fn compress(paths: &[String], dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = File::create(dest).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);
    let mut buf = vec![0u8; CHUNK];

    for raw in paths {
        let src = Path::new(raw);
        let Ok(md) = fs::symlink_metadata(src) else {
            return Err(format!("{raw}: source does not exist"));
        };
        let base = src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "entry".to_string());
        if md.is_dir() {
            add_dir(&mut zip, src, &base, options, &mut buf)?;
        } else if md.is_file() {
            zip.start_file(base, options).map_err(|e| e.to_string())?;
            stream_file(&mut zip, src, &mut buf)?;
        }
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// Recursively add `dir` (and its subtree) to the archive under `prefix`. Empty
/// directories are preserved via an explicit directory entry.
fn add_dir<W: io::Write + io::Seek>(
    zip: &mut ZipWriter<W>,
    dir: &Path,
    prefix: &str,
    options: SimpleFileOptions,
    buf: &mut [u8],
) -> Result<(), String> {
    zip.add_directory(format!("{prefix}/"), options)
        .map_err(|e| e.to_string())?;
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let entry_name = format!("{prefix}/{name}");
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            add_dir(zip, &path, &entry_name, options, buf)?;
        } else if ft.is_file() {
            zip.start_file(entry_name, options).map_err(|e| e.to_string())?;
            stream_file(zip, &path, buf)?;
        }
    }
    Ok(())
}

fn stream_file<W: io::Write + io::Seek>(
    zip: &mut ZipWriter<W>,
    src: &Path,
    buf: &mut [u8],
) -> Result<(), String> {
    let mut f = File::open(src).map_err(|e| e.to_string())?;
    loop {
        let n = f.read(buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        zip.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    }
    Ok(())
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
