#![allow(dead_code)]
#![allow(clippy::manual_is_multiple_of)]
#![allow(clippy::manual_range_contains)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::upper_case_acronyms)]
#![allow(non_upper_case_globals)]
#![allow(non_snake_case)]
#![allow(unsafe_op_in_unsafe_fn)]

use std::ptr::null;
use std::sync::OnceLock;
use std::sync::atomic::AtomicBool;

use std::mem::size_of;

use super::ffi::{
    CreateSolidBrush, DwmSetWindowAttribute, Dword, GetProcAddress, Hbrush, Hwnd, LoadLibraryW,
    SetWindowTheme,
};

/// PreferredAppMode enum values (uxtheme.dll ordinal 135 — undocumented).
/// Used by Plan 02.1-07 (cli.rs bootstrap) to set per-process dark-mode preference
/// BEFORE the first window is created (D-04 — no first-paint flash).
pub(super) const PREFERRED_APP_MODE_DEFAULT: i32 = 0;
pub(super) const PREFERRED_APP_MODE_ALLOW_DARK: i32 = 1;
pub(super) const PREFERRED_APP_MODE_FORCE_DARK: i32 = 2;
pub(super) const PREFERRED_APP_MODE_FORCE_LIGHT: i32 = 3;

/// Cached uxtheme.dll ordinal-export function pointers (RESEARCH Pattern 1).
///
/// uxtheme.dll exposes its dark-mode APIs as ordinal-only exports — they are not
/// declared in any public Win32 header. We resolve them once at startup via
/// `LoadLibraryW + GetProcAddress(MAKEINTRESOURCE(ordinal))`, null-check each,
/// and cache them in a `OnceLock`. Per Pitfall 2, ordinal 135 had a different
/// signature on Windows 10 build 1809 (`AllowDarkModeForApp(BOOL)`) vs build
/// 1903+ (`SetPreferredAppMode(PreferredAppMode)`). The null-check fallback means
/// pre-1903 systems lose the dark-themed scrollbar/combobox but everything else
/// (DWMWA, palette, custom paint) still works — visible degradation, not a crash.
pub(super) struct UxthemeOrdinals {
    /// Ordinal 135 — `SetPreferredAppMode(PreferredAppMode) -> i32` (1903+).
    pub(super) set_preferred_app_mode: Option<unsafe extern "system" fn(i32) -> i32>,
    /// Ordinal 133 — `AllowDarkModeForWindow(HWND, BOOL) -> BOOL`.
    pub(super) allow_dark_mode_for_window: Option<unsafe extern "system" fn(Hwnd, i32) -> i32>,
    /// Ordinal 136 — `FlushMenuThemes() -> void`.
    pub(super) flush_menu_themes: Option<unsafe extern "system" fn()>,
}

static UXTHEME: OnceLock<UxthemeOrdinals> = OnceLock::new();

pub(super) fn uxtheme_ordinals() -> &'static UxthemeOrdinals {
    UXTHEME.get_or_init(|| unsafe {
        let dll_name = crate::io::wide("uxtheme.dll");
        let module = LoadLibraryW(dll_name.as_ptr());
        if module == 0 {
            #[cfg(debug_assertions)]
            eprintln!("uxtheme.dll failed to load — dark-mode ordinals unavailable");
            return UxthemeOrdinals {
                set_preferred_app_mode: None,
                allow_dark_mode_for_window: None,
                flush_menu_themes: None,
            };
        }
        // MAKEINTRESOURCEA: ordinal in the low 16 bits, zero in the high bits.
        // Cast usize to *const i8 — GetProcAddress treats this as an ordinal,
        // not a pointer, when the high bits are zero (Win32 contract).
        let resolve =
            |ord: usize| -> *mut std::ffi::c_void { GetProcAddress(module, ord as *const i8) };
        let p135 = resolve(135);
        let p133 = resolve(133);
        let p136 = resolve(136);
        #[cfg(debug_assertions)]
        {
            if p135.is_null() {
                eprintln!("uxtheme ordinal 135 (SetPreferredAppMode) missing");
            }
            if p133.is_null() {
                eprintln!("uxtheme ordinal 133 (AllowDarkModeForWindow) missing");
            }
            if p136.is_null() {
                eprintln!("uxtheme ordinal 136 (FlushMenuThemes) missing");
            }
        }
        UxthemeOrdinals {
            set_preferred_app_mode: if p135.is_null() {
                None
            } else {
                Some(std::mem::transmute::<
                    *mut std::ffi::c_void,
                    unsafe extern "system" fn(i32) -> i32,
                >(p135))
            },
            allow_dark_mode_for_window: if p133.is_null() {
                None
            } else {
                Some(std::mem::transmute::<
                    *mut std::ffi::c_void,
                    unsafe extern "system" fn(Hwnd, i32) -> i32,
                >(p133))
            },
            flush_menu_themes: if p136.is_null() {
                None
            } else {
                Some(std::mem::transmute::<
                    *mut std::ffi::c_void,
                    unsafe extern "system" fn(),
                >(p136))
            },
        }
    })
}

/// WCAG relative-luminance contrast helper (UI-SPEC §Color, threshold 0.6).
///
/// Computes `lum = 0.2126*R + 0.7152*G + 0.0722*B` (R/G/B normalized to [0..1])
/// and returns the appropriate text color for selection fills painted with the
/// given accent: black when luminance > 0.6 (light accent), white otherwise.
/// 0.6 is the explicit UI-SPEC threshold; do NOT alter without an UI-SPEC update.
pub(super) fn selected_text_for_accent(r: u8, g: u8, b: u8) -> Dword {
    let rf = r as f32 / 255.0;
    let gf = g as f32 / 255.0;
    let bf = b as f32 / 255.0;
    let lum = 0.2126 * rf + 0.7152 * gf + 0.0722 * bf;
    if lum > 0.6 {
        rgb(0, 0, 0)
    } else {
        rgb(255, 255, 255)
    }
}

/// Single canonical per-HWND dark-mode application. Plans 02.1-04 / 02.1-05 /
/// 02.1-07 call this on every CreateWindowExW return (and on theme toggle), so
/// the dual-DWMWA + uxtheme + SetWindowTheme triad never gets out of sync.
///
/// 1. `set_window_dark_mode` — preserves the Pitfall 3 dual-call
///    (`DwmSetWindowAttribute(hwnd, 20)` + `(hwnd, 19)`).
/// 2. `AllowDarkModeForWindow` (uxtheme ordinal 133, null-checked).
/// 3. `SetWindowTheme(hwnd, "DarkMode_Explorer" | "Explorer", NULL)`.
pub(super) unsafe fn apply_dark_mode_to_window(hwnd: Hwnd, enabled: bool) {
    set_window_dark_mode(hwnd, enabled);
    if let Some(allow_fn) = uxtheme_ordinals().allow_dark_mode_for_window {
        let flag = if enabled { 1 } else { 0 };
        allow_fn(hwnd, flag);
    }
    let theme_name = if enabled {
        crate::io::wide("DarkMode_Explorer")
    } else {
        crate::io::wide("Explorer")
    };
    SetWindowTheme(hwnd, theme_name.as_ptr(), null());
}

pub(super) static DARK_BRUSH: OnceLock<Hbrush> = OnceLock::new();
pub(super) static LIGHT_BRUSH: OnceLock<Hbrush> = OnceLock::new();
pub(super) static DARK_MODE_ATOMIC: AtomicBool = AtomicBool::new(true);

pub(super) const fn rgb(red: u8, green: u8, blue: u8) -> Dword {
    red as Dword | ((green as Dword) << 8) | ((blue as Dword) << 16)
}

pub(super) unsafe fn dark_brush() -> Hbrush {
    *DARK_BRUSH.get_or_init(|| CreateSolidBrush(rgb(24, 26, 30)))
}

pub(super) unsafe fn light_brush() -> Hbrush {
    *LIGHT_BRUSH.get_or_init(|| CreateSolidBrush(rgb(242, 244, 247)))
}

pub(super) unsafe fn set_window_dark_mode(hwnd: Hwnd, enabled: bool) {
    let value: i32 = if enabled { 1 } else { 0 };
    let value_ptr = &value as *const i32 as *const std::ffi::c_void;
    DwmSetWindowAttribute(hwnd, 20, value_ptr, size_of::<i32>() as Dword);
    DwmSetWindowAttribute(hwnd, 19, value_ptr, size_of::<i32>() as Dword);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accent_luminance() {
        assert_eq!(selected_text_for_accent(255, 255, 255), rgb(0, 0, 0));
        assert_eq!(selected_text_for_accent(0, 0, 0), rgb(255, 255, 255));
        assert_eq!(selected_text_for_accent(150, 150, 150), rgb(255, 255, 255));
        assert_eq!(selected_text_for_accent(155, 155, 155), rgb(0, 0, 0));
    }
}
