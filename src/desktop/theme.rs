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
    CreateSolidBrush, DwmGetColorizationColor, DwmSetWindowAttribute, Dword, GetProcAddress,
    Hbrush, Hwnd, InvalidateRect, LoadLibraryW, SetWindowTheme,
};
use super::state::DesktopState;

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

/// Re-queries the system accent via DwmGetColorizationColor and updates the
/// cached colors on DesktopState. Called once at startup and on every
/// `WM_DWMCOLORIZATIONCOLORCHANGED` message (RESEARCH Pattern 7).
///
/// Error handling (T-02.1-03-03): on non-zero HRESULT, leaves `accent_color`
/// and `selected_text_color` untouched — accent change failures are no-ops
/// rather than zeroing the cache. If the first-ever call fails, the fields
/// stay at their `0` initializer — selection text paints black on black,
/// visually degraded but not a crash.
pub(super) fn refresh_accent(state: &mut DesktopState) {
    let mut color: u32 = 0;
    let mut opaque_blend: i32 = 0;
    let hr =
        unsafe { DwmGetColorizationColor(&mut color as *mut u32, &mut opaque_blend as *mut i32) };
    if hr != 0 {
        return;
    }
    // DwmGetColorizationColor returns ARGB. Strip alpha; convert to COLORREF (BGR).
    let stripped = color & 0x00FF_FFFF;
    let r = ((stripped >> 16) & 0xFF) as u8;
    let g = ((stripped >> 8) & 0xFF) as u8;
    let b = (stripped & 0xFF) as u8;
    state.accent_color = rgb(r, g, b);
    state.selected_text_color = selected_text_for_accent(r, g, b);
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

pub(super) unsafe fn update_column_widths(state: &DesktopState) {
    InvalidateRect(state.hwnd, null(), 0);
}

pub(super) unsafe fn apply_theme(state: &mut DesktopState) {
    set_window_dark_mode(state.hwnd, state.dark_mode);
    let theme = if state.dark_mode {
        crate::io::wide("DarkMode_Explorer")
    } else {
        crate::io::wide("Explorer")
    };

    // Setting Explorer themes on buttons and checkboxes strips their ComCtl32 v6
    // modern visuals and falls back to flat ugly legacy classic styles.
    // We only set it on edit and combo controls (Plan 02-03 adds drive_picker).
    // Phase 02.1-06 (D-07): msctls_statusbar32 removed; custom footer is self-painting.
    SetWindowTheme(state.path_edit, theme.as_ptr(), null());
    // drive_picker (ComboBoxEx32) requires DarkMode_Explorer / Explorer theme for dark-mode
    // coherence — without this, the ComboBoxEx32 dropdown ignores dark mode entirely.
    if state.drive_picker != 0 {
        SetWindowTheme(state.drive_picker, theme.as_ptr(), null());
    }

    let buttons = [
        state.browse_button,
        state.scan_button,
        state.stop_button,
        state.refresh_button,
        state.expand_button,
        state.collapse_button,
        state.columns_button,
        state.hidden_check,
        state.files_check,
        state.follow_check,
        state.dark_check,
    ];
    for btn in buttons {
        SetWindowTheme(btn, null(), null());
    }

    update_column_widths(state);
    InvalidateRect(state.hwnd, null(), 1);
}

pub(super) fn palette_bg(state: &DesktopState) -> Dword {
    if state.dark_mode {
        // UI-SPEC D-05 — neutral #1e1e1e (was brown-tinted rgb(12,13,15), Pitfall 9).
        rgb(30, 30, 30)
    } else {
        rgb(242, 244, 247)
    }
}

pub(super) fn palette_panel(state: &DesktopState) -> Dword {
    if state.dark_mode {
        // UI-SPEC D-05 — controls/panel surface #2d2d2d.
        rgb(45, 45, 45)
    } else {
        rgb(236, 238, 241)
    }
}

pub(super) fn palette_table(state: &DesktopState) -> Dword {
    if state.dark_mode {
        rgb(24, 26, 29)
    } else {
        rgb(255, 255, 255)
    }
}

pub(super) fn palette_table_alt(state: &DesktopState) -> Dword {
    if state.dark_mode {
        rgb(21, 23, 26)
    } else {
        rgb(249, 250, 252)
    }
}

pub(super) fn palette_header(state: &DesktopState) -> Dword {
    if state.dark_mode {
        rgb(50, 53, 58)
    } else {
        rgb(226, 229, 234)
    }
}

pub(super) fn palette_line(state: &DesktopState) -> Dword {
    if state.dark_mode {
        // UI-SPEC D-05 — hairline #3a3a3a.
        rgb(58, 58, 58)
    } else {
        // UI-SPEC D-05 — light hairline #e5e5e5 (explicit override, not GetSysColor).
        rgb(229, 229, 229)
    }
}

/// Disabled-text / disabled-icon color (UI-SPEC D-05). Light branch keeps the
/// existing GetSysColor delegation by virtue of not being a UI-SPEC override.
pub(super) fn palette_disabled(state: &DesktopState) -> Dword {
    if state.dark_mode {
        // UI-SPEC D-05 — disabled foreground #7a7a7a.
        rgb(122, 122, 122)
    } else {
        rgb(140, 140, 140)
    }
}

pub(super) fn palette_grid(state: &DesktopState) -> Dword {
    if state.dark_mode {
        rgb(36, 39, 43)
    } else {
        rgb(231, 234, 238)
    }
}

pub(super) fn palette_text(state: &DesktopState) -> Dword {
    if state.dark_mode {
        // UI-SPEC D-05 — primary text #cccccc.
        rgb(204, 204, 204)
    } else {
        rgb(18, 22, 27)
    }
}

pub(super) fn palette_muted(state: &DesktopState) -> Dword {
    if state.dark_mode {
        rgb(156, 165, 174)
    } else {
        rgb(91, 100, 112)
    }
}

pub(super) fn palette_selected(state: &DesktopState) -> Dword {
    if state.dark_mode {
        rgb(70, 74, 79)
    } else {
        rgb(211, 226, 246)
    }
}

pub(super) fn palette_hovered(state: &DesktopState) -> Dword {
    if state.dark_mode {
        rgb(38, 41, 46)
    } else {
        rgb(228, 236, 247)
    }
}

pub(super) fn palette_size_bar(state: &DesktopState) -> Dword {
    if state.dark_mode {
        rgb(72, 78, 84)
    } else {
        rgb(217, 225, 235)
    }
}

pub(super) fn palette_percent_track(state: &DesktopState) -> Dword {
    if state.dark_mode {
        rgb(54, 56, 59)
    } else {
        rgb(232, 235, 240)
    }
}

pub(super) fn palette_percent_fill(state: &DesktopState) -> Dword {
    if state.dark_mode {
        rgb(92, 93, 242)
    } else {
        rgb(65, 122, 232)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Linear-luminance contract per UI-SPEC: selection-fill text flips to
    /// black when accent luminance > 0.6, else white.
    ///
    /// Test inputs straddle the 0.6 threshold under the implementation's simple
    /// (non-gamma-corrected) `0.2126*r + 0.7152*g + 0.0722*b` formula on
    /// normalized [0..1] components. The plan's <behavior> section claimed
    /// WCAG-gamma-corrected luminance values for inputs like (180,200,220),
    /// but the locked implementation is the simple formula — so the threshold
    /// test inputs are chosen here to genuinely straddle 0.6 under the simple
    /// formula. Plan deviation: Rule 1 (bug) — VALIDATION boundary cases
    /// recomputed to match the locked implementation formula.
    #[test]
    fn accent_luminance() {
        // pure white (lum = 1.0)
        assert_eq!(selected_text_for_accent(255, 255, 255), rgb(0, 0, 0));
        // pure black (lum = 0.0)
        assert_eq!(selected_text_for_accent(0, 0, 0), rgb(255, 255, 255));
        // pure yellow (lum ≈ 0.9278) — light: black text
        assert_eq!(selected_text_for_accent(255, 255, 0), rgb(0, 0, 0));
        // Win11 default blue accent (lum ≈ 0.396) — dark: white text
        assert_eq!(selected_text_for_accent(0, 120, 215), rgb(255, 255, 255));
        // Mid-grey 150 (lum ≈ 0.588) — just below 0.6, white text
        assert_eq!(selected_text_for_accent(150, 150, 150), rgb(255, 255, 255));
        // Mid-grey 155 (lum ≈ 0.608) — just above 0.6, black text
        assert_eq!(selected_text_for_accent(155, 155, 155), rgb(0, 0, 0));
    }

    /// Threshold edge: the 0.6 boundary is the flip point. Two close greys
    /// straddle it under the simple formula (Rule 1 deviation note in
    /// `accent_luminance` applies here too).
    #[test]
    fn selected_text_threshold() {
        // Below threshold: grey 150, lum ≈ 0.5882 — white text.
        let below = selected_text_for_accent(150, 150, 150);
        // Above threshold: grey 155, lum ≈ 0.6078 — black text.
        let above = selected_text_for_accent(155, 155, 155);
        assert_eq!(below, rgb(255, 255, 255));
        assert_eq!(above, rgb(0, 0, 0));
        assert_ne!(below, above);
    }

    /// Palette regression guard (Pitfall 9 closure). Every dark-mode palette
    /// value must match UI-SPEC exact RGB. Light-mode palette_line override is
    /// explicit per UI-SPEC ("Light mode — system-color delegation EXCEPT line").
    #[test]
    fn palette_matches_spec() {
        let mut state = DesktopState::new(PathBuf::from("."));
        state.dark_mode = true;
        assert_eq!(palette_bg(&state), rgb(30, 30, 30), "dark bg #1e1e1e");
        assert_eq!(palette_panel(&state), rgb(45, 45, 45), "dark panel #2d2d2d");
        assert_eq!(
            palette_text(&state),
            rgb(204, 204, 204),
            "dark text #cccccc"
        );
        assert_eq!(palette_line(&state), rgb(58, 58, 58), "dark line #3a3a3a");
        assert_eq!(
            palette_disabled(&state),
            rgb(122, 122, 122),
            "dark disabled #7a7a7a"
        );

        state.dark_mode = false;
        assert_eq!(
            palette_line(&state),
            rgb(229, 229, 229),
            "light line #e5e5e5 (explicit override per UI-SPEC)"
        );
    }
}
