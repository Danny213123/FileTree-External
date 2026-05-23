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
        super::wide("DarkMode_Explorer")
    } else {
        super::wide("Explorer")
    };

    // Setting Explorer themes on buttons and checkboxes strips their ComCtl32 v6
    // modern visuals and falls back to flat ugly legacy classic styles.
    // We only set it on edit and status static controls.
    SetWindowTheme(state.path_edit, theme.as_ptr(), null());
    SetWindowTheme(state.status, theme.as_ptr(), null());

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
