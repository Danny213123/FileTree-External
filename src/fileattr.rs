//! Batch attribute + timestamp editing (#43).
//!
//! Small, safe helpers behind `POST /api/set-attributes` and
//! `POST /api/set-times`. Both are gated by the server's allowed-root check and
//! audited like every other mutation. They only ever *modify metadata* of an
//! existing path (toggle the read-only / hidden attribute, set the
//! created/modified/accessed times) — they never create, move, or delete data,
//! which keeps the blast radius tiny.
//!
//! Read-only toggling uses the portable `std::fs` permission bit; the hidden
//! attribute and the timestamps use the Win32 API directly (Windows-only).

use std::io;
use std::path::Path;

/// Set or clear the read-only and/or hidden attributes of `path`. `None` leaves
/// that attribute unchanged. Returns the first error encountered.
pub(crate) fn set_attributes(
    path: &Path,
    readonly: Option<bool>,
    hidden: Option<bool>,
) -> io::Result<()> {
    // Read-only: portable via std (sets/clears FILE_ATTRIBUTE_READONLY on Windows).
    if let Some(ro) = readonly {
        let mut perms = std::fs::metadata(path)?.permissions();
        perms.set_readonly(ro);
        std::fs::set_permissions(path, perms)?;
    }
    if let Some(h) = hidden {
        set_hidden(path, h)?;
    }
    Ok(())
}

/// Set the created / modified / accessed times of `path`. Each is epoch
/// milliseconds; `None` leaves that timestamp unchanged.
pub(crate) fn set_times(
    path: &Path,
    created_ms: Option<i64>,
    modified_ms: Option<i64>,
    accessed_ms: Option<i64>,
) -> io::Result<()> {
    if created_ms.is_none() && modified_ms.is_none() && accessed_ms.is_none() {
        return Ok(());
    }
    set_times_impl(path, created_ms, modified_ms, accessed_ms)
}

#[cfg(windows)]
fn set_hidden(path: &Path, hidden: bool) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x0000_0002;
    const INVALID_FILE_ATTRIBUTES: u32 = u32::MAX;

    #[allow(non_snake_case)]
    unsafe extern "system" {
        fn GetFileAttributesW(name: *const u16) -> u32;
        fn SetFileAttributesW(name: *const u16, attrs: u32) -> i32;
    }

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let current = unsafe { GetFileAttributesW(wide.as_ptr()) };
    if current == INVALID_FILE_ATTRIBUTES {
        return Err(io::Error::last_os_error());
    }
    let next = if hidden {
        current | FILE_ATTRIBUTE_HIDDEN
    } else {
        current & !FILE_ATTRIBUTE_HIDDEN
    };
    if next == current {
        return Ok(());
    }
    let ok = unsafe { SetFileAttributesW(wide.as_ptr(), next) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn set_hidden(_path: &Path, _hidden: bool) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Setting the hidden attribute is only supported on Windows",
    ))
}

#[cfg(windows)]
fn set_times_impl(
    path: &Path,
    created_ms: Option<i64>,
    modified_ms: Option<i64>,
    accessed_ms: Option<i64>,
) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    type Handle = *mut std::ffi::c_void;
    const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const FILE_WRITE_ATTRIBUTES: u32 = 0x0100;
    const FILE_SHARE_READ: u32 = 1;
    const FILE_SHARE_WRITE: u32 = 2;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;

    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[allow(non_snake_case)]
    unsafe extern "system" {
        fn CreateFileW(
            name: *const u16, access: u32, share: u32,
            sa: *mut std::ffi::c_void, disposition: u32,
            flags: u32, tmpl: Handle,
        ) -> Handle;
        fn SetFileTime(
            handle: Handle,
            creation: *const FileTime,
            last_access: *const FileTime,
            last_write: *const FileTime,
        ) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    // Epoch-ms → Windows FILETIME (100-ns ticks since 1601-01-01). The constant
    // is the gap (in 100-ns units) between 1601 and the Unix epoch (1970).
    fn to_filetime(ms: i64) -> FileTime {
        let ticks = ms * 10_000 + 116_444_736_000_000_000;
        FileTime { low: (ticks as u64 & 0xFFFF_FFFF) as u32, high: ((ticks as u64) >> 32) as u32 }
    }

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    // FILE_FLAG_BACKUP_SEMANTICS is required to open a *directory* handle.
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_WRITE | FILE_WRITE_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE || handle.is_null() {
        return Err(io::Error::last_os_error());
    }

    let creation = created_ms.map(to_filetime);
    let access = accessed_ms.map(to_filetime);
    let write = modified_ms.map(to_filetime);
    let cptr = creation.as_ref().map_or(std::ptr::null(), |f| f as *const FileTime);
    let aptr = access.as_ref().map_or(std::ptr::null(), |f| f as *const FileTime);
    let wptr = write.as_ref().map_or(std::ptr::null(), |f| f as *const FileTime);

    let ok = unsafe { SetFileTime(handle, cptr, aptr, wptr) };
    let err = if ok == 0 { Some(io::Error::last_os_error()) } else { None };
    unsafe { CloseHandle(handle); }
    match err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

#[cfg(not(windows))]
fn set_times_impl(
    _path: &Path,
    _created_ms: Option<i64>,
    _modified_ms: Option<i64>,
    _accessed_ms: Option<i64>,
) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Setting file times is only supported on Windows",
    ))
}
