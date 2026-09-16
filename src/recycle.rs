//! Shared recycle / delete helpers used by both the HTTP server (`server.rs`)
//! and the duplicates engine (`dupes.rs`).
//!
//! Recycle-by-default recovery: a delete or an overwrite is sent to the Windows
//! Recycle Bin (recoverable) unless the caller explicitly opts into a permanent
//! removal — which then carries its own distinct warning in the UI. Both
//! helpers accept a file OR a directory: on Windows `SHFileOperationW` recurses
//! a directory on its own when given a correct double-null-terminated wide path.
//!
//! Later phases (audit log, in-app undo) call `recycle_path` so every recoverable
//! delete funnels through one place; if precise restore-location info is needed
//! for undo, this is the seam to extend (e.g. an `IFileOperationProgressSink`),
//! but today the Recycle Bin + audit log is the restore backing, so it stays
//! simple and returns `io::Result<()>`.

use std::io;
use std::path::Path;

/// Send `path` (file or directory) to the Recycle Bin so it stays recoverable.
///
/// On Windows this uses `SHFileOperationW` with `FOF_ALLOWUNDO` (plus silent /
/// no-confirmation flags so it never blocks a background request). On platforms
/// without a Recycle Bin it degrades to a permanent remove.
#[cfg(windows)]
pub(crate) fn recycle_path(path: &Path) -> io::Result<()> {
    use std::ffi::OsStr;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;

    // Legacy shell operations do not accept the verbatim prefixes returned by canonicalize.
    let absolute = std::path::absolute(path)?;
    let shell_path = crate::io::explorer_shell_path(&absolute.to_string_lossy())?;
    // SHFileOperation requires a double-null-terminated wide string.
    let mut wide: Vec<u16> = OsStr::new(&shell_path)
        .encode_wide()
        .chain(once(0))
        .chain(once(0))
        .collect();

    #[repr(C)]
    #[allow(non_snake_case)]
    // Named after the Win32 struct it mirrors.
    #[allow(clippy::upper_case_acronyms)]
    struct SHFILEOPSTRUCTW {
        hwnd: *mut std::ffi::c_void,
        wFunc: u32,
        pFrom: *const u16,
        pTo: *const u16,
        fFlags: u16,
        fAnyOperationsAborted: i32,
        hNameMappings: *mut std::ffi::c_void,
        lpszProgressTitle: *const u16,
    }

    #[link(name = "shell32")]
    unsafe extern "system" {
        fn SHFileOperationW(lpFileOp: *mut SHFILEOPSTRUCTW) -> i32;
    }

    const FO_DELETE: u32 = 0x0003;
    const FOF_ALLOWUNDO: u16 = 0x0040;
    const FOF_NOCONFIRMATION: u16 = 0x0010;
    const FOF_SILENT: u16 = 0x0004;
    // Warn (rather than silently destroy) if an item cannot be recycled and would
    // otherwise be permanently deleted — recoverability is the whole point here.
    const FOF_WANTNUKEWARNING: u16 = 0x4000;

    let mut op = SHFILEOPSTRUCTW {
        hwnd: std::ptr::null_mut(),
        wFunc: FO_DELETE,
        pFrom: wide.as_mut_ptr(),
        pTo: std::ptr::null(),
        fFlags: FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_WANTNUKEWARNING,
        fAnyOperationsAborted: 0,
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: std::ptr::null(),
    };

    let ret = unsafe { SHFileOperationW(&mut op) };
    recycle_operation_result(ret, op.fAnyOperationsAborted != 0)
}

#[cfg(windows)]
fn recycle_operation_result(ret: i32, aborted: bool) -> io::Result<()> {
    if ret == 0 && aborted {
        Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "Recycle operation was canceled; file was not deleted",
        ))
    } else if ret == 0 {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "Windows Recycle Bin operation failed (Shell code 0x{ret:X})"
        )))
    }
}

#[cfg(not(windows))]
pub(crate) fn recycle_path(path: &Path) -> io::Result<()> {
    // No Recycle Bin off Windows — fall back to a permanent remove.
    delete_path_permanent(path)
}

/// Permanently delete `path` (file or directory) with no Recycle Bin step.
///
/// Only call this when the caller has *explicitly* requested a permanent delete
/// (e.g. `permanent=true`); the default path everywhere is `recycle_path`.
pub(crate) fn delete_path_permanent(path: &Path) -> io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
}

/// Permanently delete `path` with no Recycle Bin step, using only `std::fs`
/// (never the Shell API). This is the explicit "Delete permanently" disposition
/// for the compression workflow: the caller has already verified the compressed
/// replacement is intact before invoking this, and the UI surfaces the
/// irreversible nature of the choice. A thin, intention-revealing alias over
/// [`delete_path_permanent`].
pub(crate) fn delete_permanent(path: &Path) -> io::Result<()> {
    delete_path_permanent(path)
}

#[cfg(all(test, windows))]
mod tests {
    use super::recycle_operation_result;
    #[test]
    fn recycle_cancellation_is_not_reported_as_deletion() {
        assert!(recycle_operation_result(0, false).is_ok());
        assert_eq!(
            recycle_operation_result(0, true).unwrap_err().kind(),
            std::io::ErrorKind::Interrupted
        );
        assert!(recycle_operation_result(5, false).is_err());
    }
}
