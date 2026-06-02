//! File/folder owner resolution (Windows).
//!
//! `owner_of(path)` returns the owner account as `DOMAIN\\user` (or the string
//! SID when the account can't be translated). This is **only** called when a
//! scan opts in via `ScanOptions::collect_owners`, or on demand for a single
//! path (the Details pane / `/api/owner`), because `GetNamedSecurityInfo` opens
//! each file's security descriptor — one extra syscall per file that would
//! noticeably slow a large scan if done unconditionally.
//!
//! A process-wide SID→name cache amortises the (relatively expensive)
//! `LookupAccountSid` translation: most files on a volume share a handful of
//! owners, so after the first lookup per distinct SID every subsequent file
//! with that owner is a cheap map hit.

#[cfg(windows)]
use std::collections::HashMap;
#[cfg(windows)]
use std::sync::{Mutex, OnceLock};

/// Resolve the owner account name for `path`. Returns an empty string on any
/// failure or on non-Windows platforms (callers treat "" as "unknown").
#[cfg(windows)]
pub(crate) fn owner_of(path: &str) -> String {
    if path.is_empty() {
        return String::new();
    }
    owner_of_win(path).unwrap_or_default()
}

#[cfg(not(windows))]
pub(crate) fn owner_of(_path: &str) -> String {
    String::new()
}

#[cfg(windows)]
fn sid_cache() -> &'static Mutex<HashMap<Vec<u8>, String>> {
    static CACHE: OnceLock<Mutex<HashMap<Vec<u8>, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(windows)]
type LookupAccountSidFn = unsafe extern "system" fn(
    *const u16,
    *mut std::ffi::c_void,
    *mut u16,
    *mut u32,
    *mut u16,
    *mut u32,
    *mut i32,
) -> i32;
#[cfg(windows)]
type ConvertSidFn = unsafe extern "system" fn(*mut std::ffi::c_void, *mut *mut u16) -> i32;
#[cfg(windows)]
type LocalFreeFn = unsafe extern "system" fn(*mut std::ffi::c_void) -> *mut std::ffi::c_void;

#[cfg(windows)]
fn owner_of_win(path: &str) -> Option<String> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;

    const SE_FILE_OBJECT: i32 = 1;
    const OWNER_SECURITY_INFORMATION: u32 = 0x0000_0001;
    const ERROR_SUCCESS: u32 = 0;

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn GetNamedSecurityInfoW(
            pObjectName: *const u16,
            ObjectType: i32,
            SecurityInfo: u32,
            ppsidOwner: *mut *mut c_void,
            ppsidGroup: *mut *mut c_void,
            ppDacl: *mut *mut c_void,
            ppSacl: *mut *mut c_void,
            ppSecurityDescriptor: *mut *mut c_void,
        ) -> u32;
        fn GetLengthSid(pSid: *mut c_void) -> u32;
        fn LookupAccountSidW(
            lpSystemName: *const u16,
            Sid: *mut c_void,
            Name: *mut u16,
            cchName: *mut u32,
            ReferencedDomainName: *mut u16,
            cchReferencedDomainName: *mut u32,
            peUse: *mut i32,
        ) -> i32;
        fn ConvertSidToStringSidW(Sid: *mut c_void, StringSid: *mut *mut u16) -> i32;
    }
    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn LocalFree(hMem: *mut c_void) -> *mut c_void;
    }

    let wide: Vec<u16> = std::ffi::OsStr::new(path)
        .encode_wide()
        .chain(Some(0))
        .collect();

    let mut psid_owner: *mut c_void = std::ptr::null_mut();
    let mut psd: *mut c_void = std::ptr::null_mut();
    let status = unsafe {
        GetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut psid_owner,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut psd,
        )
    };
    if status != ERROR_SUCCESS || psid_owner.is_null() {
        if !psd.is_null() {
            unsafe { LocalFree(psd) };
        }
        return None;
    }

    // Copy the SID bytes out (the descriptor — and the SID it points into — is
    // freed below, so the cache key must own its bytes).
    let sid_len = unsafe { GetLengthSid(psid_owner) } as usize;
    let sid_bytes: Vec<u8> = if sid_len > 0 {
        unsafe { std::slice::from_raw_parts(psid_owner as *const u8, sid_len) }.to_vec()
    } else {
        Vec::new()
    };

    if let Some(name) = sid_cache().lock().ok().and_then(|c| c.get(&sid_bytes).cloned()) {
        unsafe { LocalFree(psd) };
        return if name.is_empty() { None } else { Some(name) };
    }

    // Translate SID → "DOMAIN\\name". Retry once if the initial buffers are too
    // small (ERROR_INSUFFICIENT_BUFFER fills the cch* out-params with the needs).
    let resolved = lookup_sid_name(psid_owner, LookupAccountSidW)
        .or_else(|| string_sid(psid_owner, ConvertSidToStringSidW, LocalFree));

    unsafe { LocalFree(psd) };

    // Cache the outcome (including a negative "" result so we don't repeatedly
    // hammer LookupAccountSid for an untranslatable SID).
    let to_cache = resolved.clone().unwrap_or_default();
    if let Ok(mut cache) = sid_cache().lock() {
        cache.insert(sid_bytes, to_cache);
    }
    resolved
}

#[cfg(windows)]
fn lookup_sid_name(psid: *mut std::ffi::c_void, lookup: LookupAccountSidFn) -> Option<String> {
    let mut name_len: u32 = 256;
    let mut domain_len: u32 = 256;
    let mut name = vec![0u16; name_len as usize];
    let mut domain = vec![0u16; domain_len as usize];
    let mut sid_use: i32 = 0;

    let mut ok = unsafe {
        lookup(
            std::ptr::null(),
            psid,
            name.as_mut_ptr(),
            &mut name_len,
            domain.as_mut_ptr(),
            &mut domain_len,
            &mut sid_use,
        )
    };
    if ok == 0 {
        // Grow to the sizes the API reported and try once more.
        name = vec![0u16; (name_len.max(1)) as usize];
        domain = vec![0u16; (domain_len.max(1)) as usize];
        ok = unsafe {
            lookup(
                std::ptr::null(),
                psid,
                name.as_mut_ptr(),
                &mut name_len,
                domain.as_mut_ptr(),
                &mut domain_len,
                &mut sid_use,
            )
        };
        if ok == 0 {
            return None;
        }
    }

    let name_str = wide_to_string(&name);
    let domain_str = wide_to_string(&domain);
    if name_str.is_empty() && domain_str.is_empty() {
        None
    } else if domain_str.is_empty() {
        Some(name_str)
    } else if name_str.is_empty() {
        Some(domain_str)
    } else {
        Some(format!("{domain_str}\\{name_str}"))
    }
}

#[cfg(windows)]
fn string_sid(
    psid: *mut std::ffi::c_void,
    convert: ConvertSidFn,
    local_free: LocalFreeFn,
) -> Option<String> {
    let mut out: *mut u16 = std::ptr::null_mut();
    if unsafe { convert(psid, &mut out) } == 0 || out.is_null() {
        return None;
    }
    // Read the null-terminated wide string the API LocalAlloc'd, then free it.
    let mut len = 0usize;
    while unsafe { *out.add(len) } != 0 {
        len += 1;
    }
    let slice = unsafe { std::slice::from_raw_parts(out, len) };
    let s = String::from_utf16_lossy(slice);
    unsafe { local_free(out as *mut std::ffi::c_void) };
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[cfg(windows)]
fn wide_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}
