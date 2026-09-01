#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
fn suppress_system_file_error_dialogs() {
    const SEM_FAILCRITICALERRORS: u32 = 0x0001;
    const SEM_NOOPENFILEERRORBOX: u32 = 0x8000;

    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn GetErrorMode() -> u32;
        fn SetErrorMode(mode: u32) -> u32;
    }

    // File access errors still return to the scanner and are counted normally;
    // Windows just does not surface a modal/toast hard-error UI for this process.
    unsafe {
        let current = GetErrorMode();
        SetErrorMode(current | SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX);
    }
}

fn main() {
    #[cfg(windows)]
    suppress_system_file_error_dialogs();

    filetree_desktop_lib::run();
}
