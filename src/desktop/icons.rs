#![allow(dead_code)]
#![allow(clippy::upper_case_acronyms)]
#![allow(non_upper_case_globals)]
#![allow(non_snake_case)]
#![allow(unsafe_op_in_unsafe_fn)]

// Plan 02.1-01: Bootstrap Icons font registration and glyph rendering.
//
// Codepoints verified against bootstrap-icons.css shipped with v1.11.3
// (npm tarball bootstrap-icons-1.11.3.tgz, same glyphs as the TTF).
// All codepoints are in the Unicode PUA range U+E000–U+F8FF (BMP),
// so each encodes as a single u16 in UTF-16 — no surrogate pairs needed.

use std::sync::OnceLock;

use super::ffi::{
    AddFontMemResourceEx, CLIP_DEFAULT_PRECIS, CreateFontIndirectW, DEFAULT_CHARSET, DEFAULT_PITCH,
    DEFAULT_QUALITY, DT_LEFT, DT_NOPREFIX, DT_TOP, DeleteObject, DrawTextW, Dword, FW_NORMAL,
    Handle, Hdc, Hfont, LOGFONTW, OUT_DEFAULT_PRECIS, Rect, SelectObject, SetBkMode, SetTextColor,
    TRANSPARENT,
};

// Bootstrap Icons v1.11.3 TTF asset — embedded at compile time.
// The &'static [u8] lives in the .exe read-only segment for the process
// lifetime (T-02.1-01-02: no heap copy; never call RemoveFontMemResourceEx).
static ICON_FONT_BYTES: &[u8] = include_bytes!("../../assets/bootstrap-icons-1.11.3.ttf");

// Stores the handle returned by AddFontMemResourceEx (opaque; only used to
// confirm registration succeeded). We store it as isize rather than *mut c_void
// because raw pointers are not Send/Sync and OnceLock requires T: Send.
static ICON_FONT_HANDLE: OnceLock<isize> = OnceLock::new();

// Single source of truth for Bootstrap Icons codepoints used in this codebase.
// Do NOT write these literals anywhere else — always reference ICON_* constants.
//
// Codepoints verified against bootstrap-icons.css v1.11.3:
//   bi-list-nested   → .bi-list-nested::before { content: "\f4a6"; }
//   bi-bar-chart     → .bi-bar-chart::before    { content: "\f1c6"; }
//   bi-files         → .bi-files::before        { content: "\f3cb"; }
//   bi-copy          → .bi-copy::before         { content: "\f759"; }
//   bi-exclamation-triangle → .bi-exclamation-triangle::before { content: "\f33a"; }
//   bi-check         → .bi-check::before        { content: "\f26e"; }
pub(super) const ICON_LIST_NESTED: char = '\u{F4A6}'; // Details tab
pub(super) const ICON_BAR_CHART: char = '\u{F1C6}'; // Top tab
pub(super) const ICON_FILES: char = '\u{F3CB}'; // Extensions tab
pub(super) const ICON_COPY: char = '\u{F759}'; // Duplicates tab
pub(super) const ICON_EXCLAMATION_TRIANGLE: char = '\u{F33A}'; // Errors tab
pub(super) const ICON_CHECK: char = '\u{F26E}'; // Popup-menu checkmark

// Font family name as registered with GDI by AddFontMemResourceEx.
pub(super) const ICON_FONT_FAMILY: &str = "bootstrap-icons";

/// Register the Bootstrap Icons font with GDI once, before any paint call.
///
/// Idempotent via OnceLock — safe to call multiple times but the GDI
/// registration happens exactly once per process lifetime.  On failure the
/// font is unavailable; callers fall back to the system symbol font gracefully.
pub(super) fn register_icon_font() {
    ICON_FONT_HANDLE.get_or_init(|| {
        let mut num_fonts: Dword = 0;
        let handle: Handle = unsafe {
            AddFontMemResourceEx(
                ICON_FONT_BYTES.as_ptr() as *const std::ffi::c_void,
                ICON_FONT_BYTES.len() as Dword,
                std::ptr::null_mut(),
                &mut num_fonts as *mut Dword,
            )
        };
        if handle == 0 {
            eprintln!("AddFontMemResourceEx failed; icon font unavailable");
        }
        handle
    });
}

/// Render a single Bootstrap Icons glyph onto `hdc` at pixel position (x, y).
///
/// Creates a one-shot HFONT for each call and deletes it immediately after
/// DrawTextW returns — no GDI handle leaks (mirrors the discipline in paint.rs).
/// The caller is responsible for saving/restoring any HDC state beyond text
/// color and bk-mode (which this fn sets but does NOT restore).
pub(super) unsafe fn draw_icon(
    hdc: Hdc,
    x: i32,
    y: i32,
    codepoint: char,
    size_px: i32,
    color: Dword,
) {
    // Build face-name array: wide string padded to 32 u16 slots.
    let mut face: [u16; 32] = [0u16; 32];
    for (dst, src) in face.iter_mut().zip(ICON_FONT_FAMILY.encode_utf16()) {
        *dst = src;
    }

    let lf = LOGFONTW {
        lfHeight: -size_px,
        lfWidth: 0,
        lfEscapement: 0,
        lfOrientation: 0,
        lfWeight: FW_NORMAL,
        lfItalic: 0,
        lfUnderline: 0,
        lfStrikeOut: 0,
        lfCharSet: DEFAULT_CHARSET as u8,
        lfOutPrecision: OUT_DEFAULT_PRECIS as u8,
        lfClipPrecision: CLIP_DEFAULT_PRECIS as u8,
        lfQuality: DEFAULT_QUALITY as u8,
        lfPitchAndFamily: DEFAULT_PITCH as u8,
        lfFaceName: face,
    };

    let hfont: Hfont = CreateFontIndirectW(&lf);
    if hfont == 0 {
        return;
    }

    let old_font = SelectObject(hdc, hfont);
    SetTextColor(hdc, color);
    SetBkMode(hdc, TRANSPARENT);

    // Encode the codepoint as UTF-16.  All Bootstrap Icons PUA codepoints fit
    // in one u16 (BMP range), so encode_utf16 yields exactly one element.
    let mut buf = [0u16; 2];
    let len = codepoint.encode_utf16(&mut buf).len() as i32;

    // Generous rect to avoid clipping descenders; DrawTextW does not paint
    // outside the rect so oversizing is safe.
    let mut rect = Rect {
        left: x,
        top: y,
        right: x + size_px + size_px / 2,
        bottom: y + size_px + size_px / 2,
    };

    DrawTextW(
        hdc,
        buf.as_ptr(),
        len,
        &mut rect,
        DT_LEFT | DT_TOP | DT_NOPREFIX,
    );

    SelectObject(hdc, old_font);
    DeleteObject(hfont);
}
