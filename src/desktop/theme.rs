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
    CreateSolidBrush, DwmSetWindowAttribute, Dword, Hbrush, Hwnd, InvalidateRect, SetWindowTheme,
};
use super::state::DesktopState;

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
    // We only set it on edit, combo, and status controls (Plan 02-03 adds drive_picker).
    SetWindowTheme(state.path_edit, theme.as_ptr(), null());
    SetWindowTheme(state.status, theme.as_ptr(), null());
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
        rgb(12, 13, 15)
    } else {
        rgb(242, 244, 247)
    }
}

pub(super) fn palette_panel(state: &DesktopState) -> Dword {
    if state.dark_mode {
        rgb(28, 30, 34)
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
        rgb(64, 68, 74)
    } else {
        rgb(196, 202, 210)
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
        rgb(240, 244, 248)
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

    /// WCAG relative luminance contract per UI-SPEC: selection-fill text flips to
    /// black when accent luminance > 0.6, else white. Cases pinned by VALIDATION.md.
    #[test]
    fn accent_luminance() {
        // pure white (lum = 1.0)
        assert_eq!(selected_text_for_accent(255, 255, 255), rgb(0, 0, 0));
        // pure black (lum = 0.0)
        assert_eq!(selected_text_for_accent(0, 0, 0), rgb(255, 255, 255));
        // pale yellow (lum ≈ 0.9278)
        assert_eq!(selected_text_for_accent(255, 255, 0), rgb(0, 0, 0));
        // Win11 default blue accent (lum ≈ 0.196)
        assert_eq!(selected_text_for_accent(0, 120, 215), rgb(255, 255, 255));
        // pale grey-blue just under 0.6 (lum ≈ 0.5919) — must stay white
        assert_eq!(selected_text_for_accent(180, 200, 220), rgb(255, 255, 255));
        // slightly lighter, just over 0.6 (lum ≈ 0.6437) — flips to black
        assert_eq!(selected_text_for_accent(190, 210, 220), rgb(0, 0, 0));
    }

    /// Threshold edge: verify the 0.6 luminance boundary is the flip point.
    /// Picks two close shades; the lower returns white, the higher returns black.
    #[test]
    fn selected_text_threshold() {
        // Below threshold (lum ≈ 0.591)
        let below = selected_text_for_accent(180, 200, 220);
        // Above threshold (lum ≈ 0.643)
        let above = selected_text_for_accent(190, 210, 220);
        assert_eq!(below, rgb(255, 255, 255));
        assert_eq!(above, rgb(0, 0, 0));
        // The two must differ — they straddle the boundary.
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
        assert_eq!(palette_text(&state), rgb(204, 204, 204), "dark text #cccccc");
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
