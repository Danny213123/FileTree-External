#[cfg(windows)]
use std::sync::OnceLock;

#[cfg(windows)]
#[repr(C)]
struct DataBlob {
    size: u32,
    data: *mut u8,
}

#[cfg(windows)]
pub(crate) fn protect_secret(value: &[u8]) -> Result<Vec<u8>, String> {
    crypt_secret(value, true)
}

#[cfg(windows)]
pub(crate) fn unprotect_secret(value: &[u8]) -> Result<Vec<u8>, String> {
    crypt_secret(value, false)
}

#[cfg(windows)]
fn crypt_secret(value: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;
    #[link(name = "Crypt32")]
    unsafe extern "system" {
        fn CryptProtectData(
            input: *const DataBlob,
            description: *const u16,
            entropy: *const DataBlob,
            reserved: *mut std::ffi::c_void,
            prompt: *mut std::ffi::c_void,
            flags: u32,
            output: *mut DataBlob,
        ) -> i32;
        fn CryptUnprotectData(
            input: *const DataBlob,
            description: *mut *mut u16,
            entropy: *const DataBlob,
            reserved: *mut std::ffi::c_void,
            prompt: *mut std::ffi::c_void,
            flags: u32,
            output: *mut DataBlob,
        ) -> i32;
    }
    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn LocalFree(memory: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    }

    let input = DataBlob {
        size: value.len() as u32,
        data: value.as_ptr() as *mut u8,
    };
    let mut output = DataBlob {
        size: 0,
        data: std::ptr::null_mut(),
    };
    let ok = unsafe {
        if protect {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let bytes = unsafe { std::slice::from_raw_parts(output.data, output.size as usize).to_vec() };
    unsafe {
        LocalFree(output.data.cast());
    }
    Ok(bytes)
}

#[cfg(windows)]
pub(crate) fn set_keep_awake(active: bool) {
    static SENDER: OnceLock<std::sync::mpsc::Sender<bool>> = OnceLock::new();
    let sender = SENDER.get_or_init(|| {
        let (sender, receiver) = std::sync::mpsc::channel::<bool>();
        let _ = std::thread::Builder::new()
            .name("filetree-keep-awake".to_string())
            .spawn(move || {
                const ES_CONTINUOUS: u32 = 0x8000_0000;
                const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
                const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;
                #[link(name = "Kernel32")]
                unsafe extern "system" {
                    fn SetThreadExecutionState(flags: u32) -> u32;
                }
                while let Ok(active) = receiver.recv() {
                    let flags = if active {
                        ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
                    } else {
                        ES_CONTINUOUS
                    };
                    unsafe {
                        SetThreadExecutionState(flags);
                    }
                }
                unsafe {
                    SetThreadExecutionState(ES_CONTINUOUS);
                }
            });
        sender
    });
    let _ = sender.send(active);
}

#[cfg(not(windows))]
pub(crate) fn protect_secret(value: &[u8]) -> Result<Vec<u8>, String> {
    Ok(value.to_vec())
}

#[cfg(not(windows))]
pub(crate) fn unprotect_secret(value: &[u8]) -> Result<Vec<u8>, String> {
    Ok(value.to_vec())
}

#[cfg(not(windows))]
pub(crate) fn set_keep_awake(_active: bool) {}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn dpapi_round_trip_uses_encrypted_bytes() {
        let plain = b"filetree-v2-dpapi-round-trip";
        let cipher = protect_secret(plain).expect("protect with the current Windows account");
        assert_ne!(cipher, plain);
        assert_eq!(
            unprotect_secret(&cipher).expect("unprotect with the current Windows account"),
            plain
        );
    }
}
