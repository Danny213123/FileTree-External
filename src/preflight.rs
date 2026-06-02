//! Pre-flight validation shared by the HTTP server (`server.rs`) and the
//! duplicates engine (`dupes.rs`): free-disk-space checks before a copy /
//! cross-volume move, Windows path hygiene (MAX_PATH + reserved device names),
//! and human-friendly descriptions of common filesystem errors (a file that is
//! open in another program, access denied, …).
//!
//! Everything here is best-effort and side-effect-free: it inspects paths and
//! the volume, never mutating user data. When something can't be determined
//! (e.g. free space on an exotic volume) the check degrades to "allow" rather
//! than blocking a legitimate operation.

use std::fs;
use std::io;
use std::path::Path;

/// Classic Win32 path ceiling enforced by the default (non-verbatim) file APIs.
pub(crate) const MAX_PATH: usize = 260;

/// Free bytes available to the caller on the volume that contains `path`.
/// `None` when it can't be queried (callers then skip the space check).
#[cfg(windows)]
pub(crate) fn free_space(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;

    unsafe extern "system" {
        fn GetDiskFreeSpaceExW(
            lpDirectoryName: *const u16,
            lpFreeBytesAvailableToCaller: *mut u64,
            lpTotalNumberOfBytes: *mut u64,
            lpTotalNumberOfFreeBytes: *mut u64,
        ) -> i32;
    }

    // GetDiskFreeSpaceExW wants a directory; for a file use its parent (same
    // volume). Fall back to the path itself if it has no parent (a drive root).
    let dir = if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| path.to_path_buf())
    };
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut free_to_caller: u64 = 0;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free_to_caller,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok != 0 {
        Some(free_to_caller)
    } else {
        None
    }
}

#[cfg(not(windows))]
pub(crate) fn free_space(_path: &Path) -> Option<u64> {
    None
}

/// Recursive on-disk size of a file or directory, in bytes. Best-effort:
/// unreadable entries are skipped and symlinks are NOT followed (so a link
/// cycle can't spin forever and a junction isn't double-counted).
pub(crate) fn path_size(path: &Path) -> u64 {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(_) => return 0,
    };
    if meta.file_type().is_symlink() {
        return 0;
    }
    if meta.is_file() {
        return meta.len();
    }
    if meta.is_dir() {
        let mut total = 0u64;
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                total = total.saturating_add(path_size(&entry.path()));
            }
        }
        return total;
    }
    0
}

/// Ensure the volume holding `dest_dir` has room for a copy of `src`. Returns a
/// clear, specific error when it definitely won't fit; allows the operation when
/// free space can't be determined (so we never block on an unknown). Call this
/// only on the copy / cross-volume path — a same-volume rename consumes no space.
pub(crate) fn ensure_space_for_copy(src: &Path, dest_dir: &Path) -> Result<(), String> {
    let needed = path_size(src);
    if needed == 0 {
        return Ok(());
    }
    match free_space(dest_dir) {
        Some(avail) if needed > avail => Err(format!(
            "Not enough free space to copy \"{}\": needs {} but only {} is free on the destination drive.",
            src.display(),
            human_bytes(needed),
            human_bytes(avail),
        )),
        _ => Ok(()),
    }
}

/// Validate a user-supplied file/folder NAME (a single path component, not a
/// full path): rejects empty names, characters Windows forbids, a trailing
/// space/period (silently stripped by the OS, which surprises users), and the
/// reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9).
pub(crate) fn validate_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("Name cannot be empty.".to_string());
    }
    const INVALID: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    if let Some(c) = name.chars().find(|c| INVALID.contains(c) || (*c as u32) < 0x20) {
        return Err(format!("Name contains an invalid character: {c:?}"));
    }
    if name.ends_with(' ') || name.ends_with('.') {
        return Err("Name cannot end with a space or a period.".to_string());
    }
    if is_reserved_device_name(name) {
        return Err(format!("\"{name}\" is a reserved Windows device name."));
    }
    Ok(())
}

/// True for the Windows reserved device names, with or without an extension
/// (e.g. both "CON" and "CON.txt" are reserved).
fn is_reserved_device_name(name: &str) -> bool {
    let base = name.split('.').next().unwrap_or(name).trim_end();
    let upper = base.to_ascii_uppercase();
    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    let b = upper.as_bytes();
    b.len() == 4
        && (upper.starts_with("COM") || upper.starts_with("LPT"))
        && (b'1'..=b'9').contains(&b[3])
}

/// Reject a target whose full path is too long for the default Win32 file APIs
/// (which `std::fs` uses), with a clear message rather than a cryptic OS error.
/// Verbatim `\\?\` paths bypass the limit and are allowed.
pub(crate) fn validate_path_length(path: &Path) -> Result<(), String> {
    let len = path.as_os_str().len();
    let is_verbatim = path.to_string_lossy().starts_with(r"\\?\");
    if !is_verbatim && len >= MAX_PATH {
        return Err(format!(
            "Path is too long ({len} characters; the limit is {}). Shorten the name or move it closer to the drive root.",
            MAX_PATH - 1
        ));
    }
    Ok(())
}

/// Human-friendly description of a filesystem error, special-casing the common
/// Windows "the file is open in another program" sharing/lock violations and
/// access-denied, which otherwise surface as opaque "(os error N)" text.
pub(crate) fn describe_fs_error(err: &io::Error, path: &Path) -> String {
    #[cfg(windows)]
    {
        const ERROR_ACCESS_DENIED: i32 = 5;
        const ERROR_SHARING_VIOLATION: i32 = 32;
        const ERROR_LOCK_VIOLATION: i32 = 33;
        match err.raw_os_error() {
            Some(ERROR_SHARING_VIOLATION) | Some(ERROR_LOCK_VIOLATION) => {
                return format!(
                    "\"{}\" is open in another program — close it and try again.",
                    path.display()
                );
            }
            Some(ERROR_ACCESS_DENIED) => {
                return format!(
                    "Access to \"{}\" was denied (it may be read-only, in use, or need administrator rights).",
                    path.display()
                );
            }
            _ => {}
        }
    }
    format!("{}: {err}", path.display())
}

/// Format a byte count as a short human-readable string (e.g. "2.3 GB").
fn human_bytes(n: u64) -> String {
    const UNITS: [&str; 6] = ["B", "KB", "MB", "GB", "TB", "PB"];
    let mut value = n as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{n} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}
