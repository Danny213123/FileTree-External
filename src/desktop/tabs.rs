// Plan 02.1-04: FileTreeTabStrip window class — owner-painted tab strip (D-08).
//
// This file implements the custom tab-strip window class, hit-testing, cell-width
// computation, and layout. The draw_tab_strip painter lives in paint.rs.
// Plan 02.1-05 creates the HWND and wires command routing.
//
// Design decisions:
//   - NOT SysTabControl32 (rejected per D-08 — hard to dark-theme, looks dated).
//   - No hover-highlight repaint; cursor change only (UI-SPEC §Components/States §Hover,
//     Open Question 4 recommendation — Apple-HIG restraint per D-07).
//   - WM_SETCURSOR returns 1 so DefWindowProcW does NOT reset the cursor.

#![allow(non_snake_case)]

use std::sync::OnceLock;

use super::ffi::{
    BeginPaint, BitBlt, Bool, CS_HREDRAW, CS_VREDRAW, CreateCompatibleBitmap, CreateCompatibleDC,
    DefWindowProcW, DeleteDC, DeleteObject, EndPaint, GetClientRect, GetDpiForWindow, GetParent,
    Hfont, Hinstance, Hwnd, ID_TAB_DETAILS, IDC_HAND, LoadCursorW, Lparam, Lresult, MAKEWPARAM,
    MulDiv, PaintStruct, PostMessageW, Rect, RegisterClassW, SRCCOPY, SelectObject, SetCursor,
    Uint, WM_COMMAND, WM_ERASEBKGND, WM_LBUTTONDOWN, WM_PAINT, WM_SETCURSOR, WM_SIZE, WndClassW,
    Wparam,
};
use super::paint::draw_tab_strip;
use super::state::{TAB_LABELS, with_state_mut};

/// Window class name for the tab strip.
pub(super) const TAB_CLASS_NAME: &str = "FileTreeTabStrip";

static CLASS_REGISTERED: OnceLock<bool> = OnceLock::new();

/// Register the `FileTreeTabStrip` window class.
///
/// Idempotent — safe to call multiple times; registration happens only once per process.
/// Returns the `RegisterClassW` atom cast to Bool (non-zero = success).
pub(super) fn register_class(h_instance: Hinstance) -> Bool {
    let registered = CLASS_REGISTERED.get_or_init(|| unsafe {
        let class_name = crate::io::wide(TAB_CLASS_NAME);
        let wc = WndClassW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(tab_window_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: h_instance,
            hIcon: 0,
            hCursor: 0,
            // We own all painting — tell the system not to erase the background.
            hbrBackground: 0,
            lpszMenuName: std::ptr::null(),
            lpszClassName: class_name.as_ptr(),
        };
        RegisterClassW(&wc) != 0
    });
    *registered as Bool
}

/// Window procedure for `FileTreeTabStrip`.
///
/// Paint: double-buffered via `draw_tab_strip` in paint.rs.
/// Click: hit-test + PostMessageW to parent with WM_COMMAND (ID_TAB_DETAILS + i).
/// Cursor: set to hand on WM_SETCURSOR; no visual repaint on hover (D-07 restraint).
pub(super) unsafe extern "system" fn tab_window_proc(
    hwnd: Hwnd,
    msg: Uint,
    wparam: Wparam,
    lparam: Lparam,
) -> Lresult {
    match msg {
        WM_PAINT => {
            let mut ps: PaintStruct = std::mem::zeroed();
            let hdc = BeginPaint(hwnd, &mut ps);
            if hdc != 0 {
                let mut client: Rect = std::mem::zeroed();
                GetClientRect(hwnd, &mut client);
                let w = client.right - client.left;
                let h = client.bottom - client.top;
                if w > 0 && h > 0 {
                    let mem_dc = CreateCompatibleDC(hdc);
                    if mem_dc != 0 {
                        let mem_bmp = CreateCompatibleBitmap(hdc, w, h);
                        if mem_bmp != 0 {
                            let old_bmp = SelectObject(mem_dc, mem_bmp);
                            // Acquire state inside closure; fall back silently on contention
                            // (T-02.1-04-01 — WM_PAINT reentrancy discipline via try_lock).
                            let painted = with_state_mut(|state| {
                                draw_tab_strip(
                                    mem_dc,
                                    client,
                                    state.active_tab as usize,
                                    state.accent_color,
                                    &state.tab_rects,
                                    state,
                                );
                            });
                            if painted.is_some() {
                                BitBlt(hdc, 0, 0, w, h, mem_dc, 0, 0, SRCCOPY);
                            }
                            SelectObject(mem_dc, old_bmp);
                            DeleteObject(mem_bmp);
                        }
                        DeleteDC(mem_dc);
                    }
                }
                EndPaint(hwnd, &ps);
            }
            0
        }

        WM_ERASEBKGND => {
            // We own all painting; returning 1 tells Windows the background is handled.
            1
        }

        WM_SIZE => {
            // Recompute tab cell rects and store them on DesktopState.
            let dpi = GetDpiForWindow(hwnd);
            let total_width = (lparam & 0xFFFF) as i32;
            let body_font = with_state_mut(|s| s.font).unwrap_or(0);
            let rects = recompute_rects(hwnd, total_width, dpi, body_font);
            with_state_mut(|state| {
                state.tab_rects = rects;
            });
            0
        }

        WM_LBUTTONDOWN => {
            let x = loword_signed(lparam);
            // Read tab_rects out of state first, then use without holding the lock.
            let rects = with_state_mut(|s| s.tab_rects);
            if let Some(rects) = rects
                && let Some(index) = hit_test_tab_index(x, &rects)
            {
                let parent = GetParent(hwnd);
                PostMessageW(
                    parent,
                    WM_COMMAND,
                    MAKEWPARAM((ID_TAB_DETAILS + index as isize) as u16, 0),
                    hwnd as Lparam,
                );
            }
            0
        }

        WM_SETCURSOR => {
            // Show hand cursor over the entire strip; do not repaint (D-07 restraint).
            SetCursor(LoadCursorW(0, IDC_HAND as *const u16));
            1
        }

        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// Compute the display width for one tab cell at the given DPI.
///
/// Chrome at 96 dpi:  8 (left pad) + 14 (icon) + 4 (gap) + 8 (right pad) = 34 px
/// Minimum cell width: 80 px (logical, scaled by dpi/96).
///
/// When `body_font == 0` the label width is estimated as `label.chars().count() * 7`
/// (platform-independent fallback used by unit tests).
pub(super) fn tab_cell_width(label: &str, dpi: u32, body_font: Hfont) -> i32 {
    let min_width = unsafe { MulDiv(80, dpi as i32, 96) };
    let chrome = unsafe { MulDiv(34, dpi as i32, 96) }; // icon + padding
    let label_width = if body_font == 0 {
        label.chars().count() as i32 * 7
    } else {
        // Real GDI measurement — only reachable in the live UI, not in unit tests.
        // SAFETY: body_font is a valid HFONT provided by the Win32 message loop.
        unsafe { measure_label_width(label, body_font) }
    };
    min_width.max(chrome + label_width)
}

/// Measure the pixel width of `text` rendered in `font` using GDI.
unsafe fn measure_label_width(text: &str, font: Hfont) -> i32 {
    use super::ffi::{CreateCompatibleDC, DeleteDC, GetTextExtentPoint32W, SelectObject};
    let dc = CreateCompatibleDC(0);
    if dc == 0 {
        return text.chars().count() as i32 * 7;
    }
    let old_font = SelectObject(dc, font);
    let wide = crate::io::wide(text);
    let mut size: super::ffi::SizeL = std::mem::zeroed();
    GetTextExtentPoint32W(dc, wide.as_ptr(), (wide.len() - 1) as i32, &mut size);
    SelectObject(dc, old_font);
    DeleteDC(dc);
    size.cx
}

/// Hit-test an x-coordinate against an ordered slice of tab cell rects.
///
/// Returns `Some(i)` for the first rect where `x >= rect.left && x < rect.right`.
/// Returns `None` if x falls outside all rects (includes negative x or x past the
/// right edge of the last cell).
///
/// Pure function — no Win32 dependency; safe to call from unit tests.
pub(super) fn hit_test_tab_index(x: i32, rects: &[Rect]) -> Option<usize> {
    for (i, r) in rects.iter().enumerate() {
        if x >= r.left && x < r.right {
            return Some(i);
        }
    }
    None
}

/// Compute a 5-element array of tab cell rects for the strip.
///
/// Cells are sized to their natural width (`tab_cell_width`) but each is at least
/// 80 logical px. They are laid out left-to-right starting at x = 0.
/// The strip height is `MulDiv(30, dpi, 96)`.
pub(super) fn recompute_rects(
    _hwnd: Hwnd,
    _total_width: i32,
    dpi: u32,
    body_font: Hfont,
) -> [Rect; 5] {
    let strip_h = unsafe { MulDiv(30, dpi as i32, 96) };
    let mut rects = [Rect {
        left: 0,
        top: 0,
        right: 0,
        bottom: strip_h,
    }; 5];
    let mut x = 0i32;
    for (i, label) in TAB_LABELS.iter().enumerate() {
        let w = tab_cell_width(label, dpi, body_font);
        rects[i] = Rect {
            left: x,
            top: 0,
            right: x + w,
            bottom: strip_h,
        };
        x += w;
    }
    rects
}

/// Extract the signed low-word from an LPARAM (x coordinate in mouse messages).
#[inline(always)]
fn loword_signed(lparam: Lparam) -> i32 {
    (lparam & 0xFFFF) as i16 as i32
}

#[cfg(test)]
mod tests {
    use super::super::ffi::Rect;

    /// tab_cell_width minimum-clamp branch:
    /// label "X" → chars().count() * 7 + 34 = 7 + 34 = 41, clamped to 80.
    #[test]
    fn tab_cell_width() {
        assert_eq!(super::tab_cell_width("X", 96, 0), 80);
        // "VeryLongTabLabel" (16 chars) → 16*7 + 34 = 112 + 34 = 146, > 80
        assert_eq!(super::tab_cell_width("VeryLongTabLabel", 96, 0), 146);
    }

    /// hit_test_tab_index returns the first rect whose [left, right) contains x.
    #[test]
    fn hit_test_tab_index() {
        let rects = [
            Rect {
                left: 0,
                top: 0,
                right: 100,
                bottom: 30,
            },
            Rect {
                left: 100,
                top: 0,
                right: 200,
                bottom: 30,
            },
            Rect {
                left: 200,
                top: 0,
                right: 300,
                bottom: 30,
            },
            Rect {
                left: 300,
                top: 0,
                right: 400,
                bottom: 30,
            },
            Rect {
                left: 400,
                top: 0,
                right: 500,
                bottom: 30,
            },
        ];

        assert_eq!(super::hit_test_tab_index(120, &rects), Some(1));
        assert_eq!(super::hit_test_tab_index(0, &rects), Some(0));
        assert_eq!(super::hit_test_tab_index(99, &rects), Some(0));
        // boundary: left is inclusive
        assert_eq!(super::hit_test_tab_index(100, &rects), Some(1));
        // right edge of last cell is exclusive
        assert_eq!(super::hit_test_tab_index(500, &rects), None);
        // out-of-range negative
        assert_eq!(super::hit_test_tab_index(-1, &rects), None);
        // far out-of-range positive
        assert_eq!(super::hit_test_tab_index(99999, &rects), None);
    }
}
