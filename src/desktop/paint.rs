#![allow(dead_code)]
#![allow(clippy::manual_is_multiple_of)]
#![allow(clippy::manual_range_contains)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::upper_case_acronyms)]
#![allow(non_upper_case_globals)]
#![allow(non_snake_case)]
#![allow(unsafe_op_in_unsafe_fn)]

use std::mem::{size_of, zeroed};

use super::ffi::{
    BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateSolidBrush, DI_NORMAL,
    DRAWITEMSTRUCT, DT_CENTER, DT_END_ELLIPSIS, DT_HIDEPREFIX, DT_LEFT, DT_NOPREFIX, DT_RIGHT,
    DT_SINGLELINE, DT_VCENTER, DeleteDC, DeleteObject, DrawIconEx, DrawTextW, EndPaint,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FillRect, GetClientRect, GetDpiForWindow, Hdc,
    InvalidateRect,
    Hgdobj, Hicon, Hwnd, MulDiv, PaintStruct, Rect, SHGFI_ICON, SHGFI_SMALLICON,
    SHGFI_USEFILEATTRIBUTES, SHGetFileInfoW, SRCCOPY, SelectObject, SendMessageW, SetBkMode,
    SetTextColor, ShFileInfoW, TRANSPARENT, Uint,
};
use super::state::{DesktopState, TAB_ICONS, TAB_LABELS, with_state_mut};
use super::theme::{
    palette_bg, palette_disabled, palette_grid, palette_header, palette_hovered, palette_line,
    palette_muted, palette_panel, palette_percent_fill, palette_percent_track, palette_selected,
    palette_size_bar, palette_table, palette_table_alt, palette_text, rgb,
};
use crate::io::epoch_ms_to_utc;
use crate::model::{NodeRecord, ScanResult};

pub(super) unsafe fn icon_for_node(state: &mut DesktopState, node: &NodeRecord) -> Hicon {
    let key = if node.is_dir {
        "[dir]".to_string()
    } else if node.extension.is_empty() {
        "[file]".to_string()
    } else {
        format!(".{}", node.extension)
    };

    if let Some(icon) = state.icon_cache.get(&key) {
        return *icon;
    }

    let sample_path = if node.is_dir {
        "folder".to_string()
    } else if node.extension.is_empty() {
        "file".to_string()
    } else {
        format!("file.{0}", node.extension)
    };
    let sample_path = crate::io::wide(&sample_path);
    let attributes = if node.is_dir {
        FILE_ATTRIBUTE_DIRECTORY
    } else {
        FILE_ATTRIBUTE_NORMAL
    };
    let mut info: ShFileInfoW = zeroed();
    SHGetFileInfoW(
        sample_path.as_ptr(),
        attributes,
        &mut info,
        size_of::<ShFileInfoW>() as Uint,
        SHGFI_ICON | SHGFI_SMALLICON | SHGFI_USEFILEATTRIBUTES,
    );
    state.icon_cache.insert(key, info.hIcon);
    info.hIcon
}

pub(super) unsafe fn paint_window(hwnd: Hwnd) {
    let mut paint: PaintStruct = zeroed();
    let hdc = BeginPaint(hwnd, &mut paint);
    if hdc == 0 {
        return;
    }

    let mut rect: Rect = zeroed();
    GetClientRect(hwnd, &mut rect);
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;

    if width > 0 && height > 0 {
        let mem_dc = CreateCompatibleDC(hdc);
        if mem_dc != 0 {
            let mem_bmp = CreateCompatibleBitmap(hdc, width, height);
            if mem_bmp != 0 {
                let old_bmp = SelectObject(mem_dc, mem_bmp);

                // Only BitBlt if we successfully acquired state. try_lock() inside
                // with_state_mut returns None when the scan thread holds the lock.
                // Blitting a blank backbuffer in that case causes a visible white/black
                // flash in the rows area — skip the blit entirely and let the next
                // WM_PAINT (re-queued via InvalidateRect below) render with real data.
                // Only draw what is actually dirty. When only the table rows are
                // invalidated (hover changes), skip draw_toolbar_background entirely —
                // touching the toolbar region via BitBlt (even when the screen DC is
                // clipped to rows-only) causes native child controls (BUTTON, EDIT,
                // COMBOBOX) in the toolbar to receive spurious repaint/WM_CTLCOLOR
                // messages that make them flash visibly.
                let toolbar_bottom = table_top();
                let need_toolbar = paint.rcPaint.top < toolbar_bottom;
                let need_table = paint.rcPaint.bottom > toolbar_bottom;
                let painted = with_state_mut(|state| {
                    fill_rect(mem_dc, rect, palette_bg(state));
                    if need_toolbar {
                        draw_toolbar_background(mem_dc, rect, state);
                    }
                    if need_table {
                        draw_table(mem_dc, rect, state);
                    }
                });

                if painted.is_some() {
                    BitBlt(hdc, 0, 0, width, height, mem_dc, 0, 0, SRCCOPY);
                } else {
                    // Re-queue exactly the dirty region so we retry once the lock is free.
                    // Using null() here would invalidate the full window and flash child windows.
                    InvalidateRect(hwnd, &paint.rcPaint, 0);
                }

                SelectObject(mem_dc, old_bmp);
                DeleteObject(mem_bmp);
            }
            DeleteDC(mem_dc);
        }
    }

    EndPaint(hwnd, &paint);
}

pub(super) unsafe fn draw_toolbar_background(hdc: Hdc, client: Rect, state: &DesktopState) {
    // 1. Draw top tab bar background
    let tab_bar_bg = if state.dark_mode {
        rgb(16, 17, 20)
    } else {
        rgb(215, 219, 226)
    };
    let tab_bar_rect = Rect {
        left: 0,
        top: 0,
        right: client.right,
        bottom: 30,
    };
    fill_rect(hdc, tab_bar_rect, tab_bar_bg);

    // 2. Draw active tab ("Home") and other tabs
    let tabs = [
        ("File", 10, 60),
        ("Home", 60, 120),
        ("Scan", 120, 180),
        ("View", 180, 240),
        ("Options", 240, 310),
        ("Help", 310, 370),
    ];

    let old_font = SelectObject(hdc, state.bold_font as Hgdobj);
    SetBkMode(hdc, TRANSPARENT);

    for (i, &(name, left, right)) in tabs.iter().enumerate() {
        let is_active = state.active_tab as usize == i;
        let tab_rect = Rect {
            left,
            top: 0,
            right,
            bottom: 30,
        };

        if is_active {
            // Active tab background (palette_panel)
            fill_rect(hdc, tab_rect, palette_panel(state));

            // Beautiful blue bottom accent line for active tab
            let accent_color = if state.dark_mode {
                rgb(92, 93, 242)
            } else {
                rgb(65, 122, 232)
            };
            let accent_rect = Rect {
                left,
                top: 27,
                right,
                bottom: 30,
            };
            fill_rect(hdc, accent_rect, accent_color);

            let text_color = if state.dark_mode {
                rgb(255, 255, 255)
            } else {
                rgb(10, 11, 13)
            };
            SetTextColor(hdc, text_color);
        } else {
            let text_color = if state.dark_mode {
                rgb(150, 155, 160)
            } else {
                rgb(80, 85, 90)
            };
            SetTextColor(hdc, text_color);
        }

        let mut text_rect = tab_rect;
        draw_text(
            hdc,
            name,
            &mut text_rect,
            DT_CENTER | DT_VCENTER | DT_SINGLELINE,
        );
    }

    SelectObject(hdc, old_font);

    // 3. Draw main ribbon panel body below the tabs
    let ribbon_body_rect = Rect {
        left: 0,
        top: 30,
        right: client.right,
        bottom: table_top() - 4,
    };
    fill_rect(hdc, ribbon_body_rect, palette_panel(state));

    // 4. Draw separator line below ribbon
    let separator_rect = Rect {
        left: 0,
        top: table_top() - 4,
        right: client.right,
        bottom: table_top() - 3,
    };
    fill_rect(hdc, separator_rect, palette_line(state));
}

pub(super) unsafe fn draw_table(hdc: Hdc, client: Rect, state: &mut DesktopState) {
    let table_left = 10;
    let table_right = client.right - 10;
    let header_top = table_top();
    let header_h = 30;
    let row_h = 27;
    let row_top = header_top + header_h;
    let bottom = client.bottom - 30;

    let table_bg = Rect {
        left: table_left,
        top: header_top,
        right: table_right,
        bottom,
    };
    fill_rect(hdc, table_bg, palette_table(state));

    SelectObject(hdc, state.bold_font as Hgdobj);
    SetBkMode(hdc, TRANSPARENT);
    draw_header(hdc, table_left, table_right, header_top, header_h, state);

    SelectObject(hdc, state.font as Hgdobj);
    if state.visible_rows.is_empty() {
        let message = if state.scanning {
            "Scanning... discovered rows will appear here"
        } else {
            "Select a directory, then scan"
        };
        let mut empty_rect = Rect {
            left: table_left + 12,
            top: row_top + 14,
            right: table_right - 12,
            bottom: row_top + 46,
        };
        SetTextColor(hdc, palette_muted(state));
        draw_text(
            hdc,
            message,
            &mut empty_rect,
            DT_LEFT | DT_SINGLELINE | DT_VCENTER,
        );
        return;
    }

    let visible_capacity = ((bottom - row_top).max(row_h) / row_h) as usize;
    if state.scroll_row + visible_capacity > state.visible_rows.len() {
        state.scroll_row = state.visible_rows.len().saturating_sub(visible_capacity);
    }

    let Some(scan) = state.current_scan.clone() else {
        return;
    };

    for screen_index in 0..visible_capacity {
        let row_index = state.scroll_row + screen_index;
        let Some(node_id) = state.visible_rows.get(row_index).copied() else {
            break;
        };
        let node = &scan.nodes[node_id];
        let top = row_top + (screen_index as i32 * row_h);
        draw_row(
            hdc,
            table_left,
            table_right,
            top,
            row_h,
            state,
            &scan,
            node,
            row_index,
        );
    }
}

pub(super) unsafe fn draw_header(
    hdc: Hdc,
    left: i32,
    right: i32,
    top: i32,
    height: i32,
    state: &DesktopState,
) {
    fill_rect(
        hdc,
        Rect {
            left,
            top,
            right,
            bottom: top + height,
        },
        palette_header(state),
    );
    let mut x = left;
    for (label, width, align) in columns(state) {
        let col_right = (x + width).min(right);
        let mut text_rect = Rect {
            left: x + 8,
            top,
            right: col_right - 8,
            bottom: top + height,
        };
        SetTextColor(hdc, palette_text(state));
        draw_text(
            hdc,
            label,
            &mut text_rect,
            if align {
                DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS
            } else {
                DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS
            },
        );
        fill_rect(
            hdc,
            Rect {
                left: col_right,
                top,
                right: col_right + 1,
                bottom: top + height,
            },
            palette_line(state),
        );
        x = col_right;
        if x >= right {
            break;
        }
    }
    fill_rect(
        hdc,
        Rect {
            left,
            top: top + height - 1,
            right,
            bottom: top + height,
        },
        palette_line(state),
    );
}

pub(super) unsafe fn draw_row(
    hdc: Hdc,
    left: i32,
    right: i32,
    top: i32,
    height: i32,
    state: &mut DesktopState,
    scan: &ScanResult,
    node: &NodeRecord,
    row_index: usize,
) {
    let selected = state.selected_id == node.id;
    let hovered = state.hovered_id == Some(node.id);
    let bg = if selected {
        palette_selected(state)
    } else if hovered {
        palette_hovered(state)
    } else if row_index % 2 == 0 {
        palette_table(state)
    } else {
        palette_table_alt(state)
    };
    fill_rect(
        hdc,
        Rect {
            left,
            top,
            right,
            bottom: top + height,
        },
        bg,
    );

    let parent_size = node
        .parent
        .and_then(|parent| scan.nodes.get(parent))
        .map(|parent| parent.size)
        .unwrap_or(node.size);
    let percent = if parent_size > 0 {
        (node.size as f64 / parent_size as f64) * 100.0
    } else {
        0.0
    };

    let mut x = left;
    let cols = columns(state);
    for (column_index, (_label, width, align)) in cols.iter().enumerate() {
        let col_right = (x + *width).min(right);
        if column_index == 0 {
            draw_name_cell(hdc, x, col_right, top, height, state, node, percent);
        } else if column_index == 5 {
            draw_percent_cell(hdc, x, col_right, top, height, state, percent);
        } else {
            let text = match column_index {
                1 => format_bytes_ui(node.size),
                2 => format_bytes_ui(node.allocated),
                3 => format_count_ui(node.files),
                4 => format_count_ui(node.folders),
                6 => epoch_ms_to_utc(node.modified_ms),
                7 => node.path.clone(),
                _ => String::new(),
            };
            let mut text_rect = Rect {
                left: x + 8,
                top,
                right: col_right - 8,
                bottom: top + height,
            };
            SetTextColor(hdc, palette_text(state));
            draw_text(
                hdc,
                &text,
                &mut text_rect,
                if *align {
                    DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX
                } else {
                    DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX
                },
            );
        }
        fill_rect(
            hdc,
            Rect {
                left: col_right,
                top,
                right: col_right + 1,
                bottom: top + height,
            },
            palette_grid(state),
        );
        x = col_right;
        if x >= right {
            break;
        }
    }

    fill_rect(
        hdc,
        Rect {
            left,
            top: top + height - 1,
            right,
            bottom: top + height,
        },
        palette_grid(state),
    );
}

pub(super) unsafe fn draw_name_cell(
    hdc: Hdc,
    left: i32,
    right: i32,
    top: i32,
    height: i32,
    state: &mut DesktopState,
    node: &NodeRecord,
    percent: f64,
) {
    let bar_w = (((right - left) as f64) * (percent / 100.0).clamp(0.0, 1.0)) as i32;
    if bar_w > 2 {
        fill_rect(
            hdc,
            Rect {
                left,
                top: top + 3,
                right: left + bar_w,
                bottom: top + height - 3,
            },
            palette_size_bar(state),
        );
    }

    let indent = 8 + (node.depth as i32 * 18);
    let twist = if node.is_dir {
        if state.expanded.contains(&node.id) {
            "v"
        } else {
            ">"
        }
    } else {
        ""
    };
    let mut twist_rect = Rect {
        left: left + indent,
        top,
        right: left + indent + 16,
        bottom: top + height,
    };
    SetTextColor(hdc, palette_muted(state));
    draw_text(
        hdc,
        twist,
        &mut twist_rect,
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );

    let icon = icon_for_node(state, node);
    if icon != 0 {
        DrawIconEx(
            hdc,
            left + indent + 19,
            top + ((height - 16) / 2),
            icon,
            16,
            16,
            0,
            0,
            DI_NORMAL,
        );
    }

    // Prefix formatted size directly onto the node's name for classic TreeSize style
    let display_name = format!("{} {}", format_bytes_ui(node.size), node.name);

    let mut text_rect = Rect {
        left: left + indent + 40,
        top,
        right: right - 8,
        bottom: top + height,
    };
    SetTextColor(hdc, palette_text(state));
    draw_text(
        hdc,
        &display_name,
        &mut text_rect,
        DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX,
    );
}

pub(super) unsafe fn draw_percent_cell(
    hdc: Hdc,
    left: i32,
    right: i32,
    top: i32,
    height: i32,
    state: &DesktopState,
    percent: f64,
) {
    let inner = Rect {
        left: left + 5,
        top: top + 5,
        right: right - 5,
        bottom: top + height - 5,
    };

    // 1. Draw outer 1px border around the progress track
    let border_color = palette_line(state);
    fill_rect(
        hdc,
        Rect {
            left: inner.left,
            top: inner.top,
            right: inner.left + 1,
            bottom: inner.bottom,
        },
        border_color,
    );
    fill_rect(
        hdc,
        Rect {
            left: inner.right - 1,
            top: inner.top,
            right: inner.right,
            bottom: inner.bottom,
        },
        border_color,
    );
    fill_rect(
        hdc,
        Rect {
            left: inner.left,
            top: inner.top,
            right: inner.right,
            bottom: inner.top + 1,
        },
        border_color,
    );
    fill_rect(
        hdc,
        Rect {
            left: inner.left,
            top: inner.bottom - 1,
            right: inner.right,
            bottom: inner.bottom,
        },
        border_color,
    );

    // 2. Fill background of the track
    let track_bg = Rect {
        left: inner.left + 1,
        top: inner.top + 1,
        right: inner.right - 1,
        bottom: inner.bottom - 1,
    };
    fill_rect(hdc, track_bg, palette_percent_track(state));

    // 3. Fill the progress bar indicator with top highlight
    let max_fill_w = track_bg.right - track_bg.left;
    let fill_w = (((max_fill_w) as f64) * (percent / 100.0).clamp(0.0, 1.0)) as i32;
    if fill_w > 0 {
        let fill_rect_area = Rect {
            left: track_bg.left,
            top: track_bg.top,
            right: track_bg.left + fill_w,
            bottom: track_bg.bottom,
        };
        fill_rect(hdc, fill_rect_area, palette_percent_fill(state));

        // Accent highlighting stripe for high-fidelity visual appeal
        let highlight_rect = Rect {
            left: track_bg.left,
            top: track_bg.top,
            right: track_bg.left + fill_w,
            bottom: track_bg.top + 2,
        };
        let highlight_color = if state.dark_mode {
            rgb(140, 142, 255)
        } else {
            rgb(130, 180, 255)
        };
        fill_rect(hdc, highlight_rect, highlight_color);
    }

    // 4. Draw percent text aligned to the right (slightly padded)
    let mut text_rect = Rect {
        left,
        top,
        right: right - 12,
        bottom: top + height,
    };
    SetBkMode(hdc, TRANSPARENT);
    SetTextColor(hdc, palette_text(state));
    draw_text(
        hdc,
        &format!("{percent:.1}%"),
        &mut text_rect,
        DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
    );
}

/// Render the 5-tab owner-drawn strip (Plan 02.1-04, D-08).
///
/// Each cell shows a Bootstrap Icons glyph (`draw_icon`) + label text, with a 2 px
/// accent-color underline under the active tab. The accent comes from
/// `state.accent_color` (single source of truth — set by `refresh_accent` in
/// Plan 02.1-03 and refreshed on `WM_DWMCOLORIZATIONCOLORCHANGED` in Plan 02.1-05).
/// No hover highlight and no borders — Apple-HIG restraint per D-07.
pub(super) unsafe fn draw_tab_strip(
    hdc: Hdc,
    rc: Rect,
    active: usize,
    accent: super::ffi::Dword,
    tab_rects: &[Rect; 5],
    state: &DesktopState,
) {
    // Derive DPI from the cached field if available; fall back to 96 if zero.
    // DesktopState.current_dpi is not yet present in Phase 02.1; we use 96 as a
    // safe default — the strip looks correct at 100% scaling and degrades gracefully.
    let dpi: u32 = 96;
    let icon_size = MulDiv(14, dpi as i32, 96);
    let pad_sm = MulDiv(8, dpi as i32, 96);
    let pad_xs = MulDiv(4, dpi as i32, 96);
    let underline_h = MulDiv(2, dpi as i32, 96).max(2);

    // 1. Fill strip background.
    fill_rect(hdc, rc, palette_panel(state));

    // 2. 1 px separator hairline along the bottom edge of the strip.
    fill_rect(
        hdc,
        Rect {
            left: rc.left,
            top: rc.bottom - 1,
            right: rc.right,
            bottom: rc.bottom,
        },
        palette_line(state),
    );

    let fg = palette_text(state);

    SetBkMode(hdc, TRANSPARENT);
    let old_font = SelectObject(hdc, state.font as Hgdobj);

    // 3. Draw each tab cell.
    for (i, cell) in tab_rects.iter().enumerate() {
        let cell_height = cell.bottom - cell.top;

        // Icon — vertically centred in the cell.
        let icon_x = cell.left + pad_sm;
        let icon_y = cell.top + (cell_height - icon_size) / 2;
        super::icons::draw_icon(hdc, icon_x, icon_y, TAB_ICONS[i], icon_size, fg);

        // Label — left of icon, right-padded.
        let mut label_rect = Rect {
            left: cell.left + pad_sm + icon_size + pad_xs,
            top: cell.top,
            right: cell.right - pad_sm,
            bottom: cell.bottom,
        };
        SetTextColor(hdc, fg);
        let wide = crate::io::wide(TAB_LABELS[i]);
        DrawTextW(
            hdc,
            wide.as_ptr(),
            -1,
            &mut label_rect,
            DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX,
        );

        // Accent underline on the active tab only.
        if i == active {
            fill_rect(
                hdc,
                Rect {
                    left: cell.left,
                    top: cell.bottom - underline_h,
                    right: cell.right,
                    bottom: cell.bottom,
                },
                accent,
            );
        }
    }

    SelectObject(hdc, old_font);
}

pub(super) unsafe fn fill_rect(hdc: Hdc, rect: Rect, color: super::ffi::Dword) {
    let brush = CreateSolidBrush(color);
    FillRect(hdc, &rect, brush);
    DeleteObject(brush as Hgdobj);
}

pub(super) unsafe fn draw_text(hdc: Hdc, text: &str, rect: &mut Rect, flags: Uint) {
    let wide = crate::io::wide(text);
    DrawTextW(hdc, wide.as_ptr(), -1, rect, flags);
}

pub(super) fn table_top() -> i32 {
    115
}

pub(super) fn columns(state: &DesktopState) -> Vec<(&'static str, i32, bool)> {
    let mut columns = vec![
        ("Name", 520, false),
        ("Size", 110, true),
        ("Allocated", 118, true),
        ("Files", 88, true),
        ("Folders", 88, true),
        ("% Parent", 110, true),
        ("Last Modified", 168, false),
    ];
    if state.path_column_visible {
        columns.push(("Path", 520, false));
    }
    columns
}

pub(super) fn format_bytes_ui(value: u64) -> String {
    const UNITS: &[(&str, f64)] = &[
        ("TB", 1024.0 * 1024.0 * 1024.0 * 1024.0),
        ("GB", 1024.0 * 1024.0 * 1024.0),
        ("MB", 1024.0 * 1024.0),
        ("KB", 1024.0),
    ];

    for (unit, factor) in UNITS {
        if value as f64 >= *factor {
            let amount = value as f64 / *factor;
            return format!("{amount:.1} {unit}");
        }
    }
    format!("{} B", format_count_ui(value))
}

pub(super) fn format_count_ui(value: u64) -> String {
    let text = value.to_string();
    let mut output = String::new();
    for (index, ch) in text.chars().rev().enumerate() {
        if index > 0 && index % 3 == 0 {
            output.push(',');
        }
        output.push(ch);
    }
    output.chars().rev().collect()
}

pub(super) fn format_duration_ui(ms: u128) -> String {
    if ms < 1_000 {
        format!("{ms} ms")
    } else if ms < 60_000 {
        format!("{:.1} s", ms as f64 / 1_000.0)
    } else {
        format!("{}m {}s", ms / 60_000, (ms % 60_000) / 1_000)
    }
}

pub(super) unsafe fn button_checked(hwnd: Hwnd) -> bool {
    use super::ffi::{BM_GETCHECK, BST_CHECKED, Wparam};
    SendMessageW(hwnd, BM_GETCHECK, 0, 0) as Wparam == BST_CHECKED
}

/// Format the files pane text.
/// idle=true → "-- files" regardless of count (no scan in flight or scan complete).
pub(super) fn format_status_files(count: u64, idle: bool) -> String {
    if idle {
        "-- files".to_string()
    } else if count == 1 {
        "1 file".to_string()
    } else {
        format!("{} files", format_count_ui(count))
    }
}

/// Format the folders pane text.
pub(super) fn format_status_folders(count: u64, idle: bool) -> String {
    if idle {
        "-- folders".to_string()
    } else if count == 1 {
        "1 folder".to_string()
    } else {
        format!("{} folders", format_count_ui(count))
    }
}

/// Format the errors pane text.
pub(super) fn format_status_errors(count: u64, idle: bool) -> String {
    if idle {
        "-- errors".to_string()
    } else if count == 1 {
        "1 error".to_string()
    } else {
        format!("{} errors", format_count_ui(count))
    }
}

/// Format the elapsed pane text.
/// idle=true → "--:--"; otherwise M:SS for < 1 hour, H:MM:SS for >= 1 hour.
pub(super) fn format_status_elapsed(elapsed_ms: u128, idle: bool) -> String {
    if idle {
        return "--:--".to_string();
    }
    let total_secs = elapsed_ms / 1_000;
    let hours = total_secs / 3600;
    let minutes = (total_secs % 3600) / 60;
    let secs = total_secs % 60;
    if hours > 0 {
        format!("{}:{:02}:{:02}", hours, minutes, secs)
    } else {
        format!("{}:{:02}", minutes, secs)
    }
}

/// Format the throughput pane text.
/// idle=true → "-- MB/s" (before scan or after completion/cancel).
/// bytes=0 → "0.0 MB/s".
/// Non-zero but < 0.1 MB/s → "<0.1 MB/s".
pub(super) fn format_status_throughput(bytes: u64, elapsed_ms: u128, idle: bool) -> String {
    if idle {
        return "-- MB/s".to_string();
    }
    if elapsed_ms == 0 {
        return "0.0 MB/s".to_string();
    }
    let mb_per_sec = (bytes as f64) / (elapsed_ms as f64 / 1_000.0) / (1024.0 * 1024.0);
    if bytes == 0 {
        "0.0 MB/s".to_string()
    } else if mb_per_sec < 0.1 {
        "<0.1 MB/s".to_string()
    } else {
        format!("{:.1} MB/s", mb_per_sec)
    }
}

/// Compute the right-edge x-coordinates for the 5 status-bar panes.
/// Pane widths at 96 dpi: [180, 360, 500, 640, -1 (last fills to end)].
/// All values are scaled by dpi/96.
pub(super) fn compute_status_parts(_client_width: i32, dpi: u32) -> [i32; 5] {
    let scale = |v: i32| -> i32 { (v as i64 * dpi as i64 / 96) as i32 };
    [scale(180), scale(360), scale(500), scale(640), -1]
}

/// Send a single status-bar pane text via SB_SETTEXTW.
/// The wide string must stay alive for the duration of the SendMessageW call.
pub(super) unsafe fn set_status_pane(status: Hwnd, pane: usize, text: &str) {
    use super::ffi::{SB_SETTEXTW, SendMessageW};
    let wide = crate::io::wide(text);
    SendMessageW(
        status,
        SB_SETTEXTW,
        pane,
        wide.as_ptr() as super::ffi::Lparam,
    );
}

// ---------------------------------------------------------------------------
// Phase 02.1-06 — Owner-draw menu helpers + custom status footer
// ---------------------------------------------------------------------------

/// Pure fn: returns `(fg, bg)` COLORREF pair for a menu item based on ODS_* flags and theme.
///
/// Rules (per UI-SPEC D-03 + D-05):
/// - ODS_DISABLED → `(palette_disabled, palette_panel)`
/// - ODS_SELECTED or ODS_HOTLIGHT → `(selected_text, accent)` — hover and selected look identical (D-07)
/// - Normal → `(palette_text, palette_panel)`
///
/// The ODS_CHECKED flag affects rendering (checkmark glyph) but NOT fg/bg colors.
pub(super) fn menu_item_colors(
    item_state: Uint,
    dark: bool,
    accent: super::ffi::Dword,
    selected_text: super::ffi::Dword,
) -> (super::ffi::Dword, super::ffi::Dword) {
    // Use a temporary DesktopState to call the palette functions without unsafe.
    // All palette_* fns only read the dark_mode field.
    let mut tmp = super::state::DesktopState::new(std::path::PathBuf::from("."));
    tmp.dark_mode = dark;

    if item_state & super::ffi::ODS_DISABLED != 0 {
        (palette_disabled(&tmp), palette_panel(&tmp))
    } else if item_state & (super::ffi::ODS_SELECTED | super::ffi::ODS_HOTLIGHT) != 0 {
        (selected_text, accent)
    } else {
        (palette_text(&tmp), palette_panel(&tmp))
    }
}

/// Paint one owner-drawn menu item per the DRAWITEMSTRUCT.
///
/// 1. Compute `(fg, bg)` via `menu_item_colors`.
/// 2. Fill background.
/// 3. If checked: draw a checkmark glyph.
/// 4. Draw label text with DT_HIDEPREFIX when mnemonics are hidden.
///
/// SAFETY: `dis` must be a valid DRAWITEMSTRUCT supplied by Win32.
pub(super) unsafe fn draw_menu_item(
    dis: &DRAWITEMSTRUCT,
    label: &str,
    checked: bool,
    mnemonics_visible: bool,
    state: &super::state::DesktopState,
) {
    let (fg, bg) = menu_item_colors(
        dis.itemState,
        state.dark_mode,
        state.accent_color,
        state.selected_text_color,
    );
    fill_rect(dis.hDC, dis.rcItem, bg);

    let dpi = GetDpiForWindow(state.hwnd);
    let dpi = if dpi == 0 { 96 } else { dpi };

    if checked {
        let icon_size = MulDiv(14, dpi as i32, 96);
        let pad = MulDiv(6, dpi as i32, 96);
        let height = dis.rcItem.bottom - dis.rcItem.top;
        let icon_y = dis.rcItem.top + (height - icon_size) / 2;
        super::icons::draw_icon(
            dis.hDC,
            dis.rcItem.left + pad,
            icon_y,
            super::icons::ICON_CHECK,
            icon_size,
            fg,
        );
    }

    let left_pad = MulDiv(26, dpi as i32, 96);
    let right_pad = MulDiv(8, dpi as i32, 96);
    let mut label_rect = Rect {
        left: dis.rcItem.left + left_pad,
        top: dis.rcItem.top,
        right: dis.rcItem.right - right_pad,
        bottom: dis.rcItem.bottom,
    };

    SetBkMode(dis.hDC, TRANSPARENT);
    SetTextColor(dis.hDC, fg);
    let old_font = SelectObject(dis.hDC, state.font as Hgdobj);

    let label_wide = crate::io::wide(label);
    let fmt =
        DT_LEFT | DT_VCENTER | DT_SINGLELINE | if mnemonics_visible { 0 } else { DT_HIDEPREFIX };
    DrawTextW(dis.hDC, label_wide.as_ptr(), -1, &mut label_rect, fmt);

    // Restore previous font to avoid leaking a GDI object selection.
    SelectObject(dis.hDC, old_font);
}

/// Paint the custom status footer child window (class FileTreeStatusFooter).
///
/// Uses double-buffering identical to `paint_window`. Paints:
/// 1. `palette_panel` background.
/// 2. 1 px `palette_line` top-edge hairline (structural-seam rule, UI-SPEC).
/// 3. 5 status panes with text from `format_status_*` helpers.
///
/// SAFETY: `hwnd` must be the status footer HWND; `state` must be valid.
pub(super) unsafe fn draw_status_footer(hwnd: Hwnd, state: &super::state::DesktopState) {
    use super::ffi::{PANE_ELAPSED, PANE_ERRORS, PANE_FILES, PANE_FOLDERS, PANE_THROUGHPUT};

    let mut paint: PaintStruct = std::mem::zeroed();
    let hdc = BeginPaint(hwnd, &mut paint);
    if hdc == 0 {
        return;
    }

    let mut client_rc: Rect = std::mem::zeroed();
    GetClientRect(hwnd, &mut client_rc);
    let width = client_rc.right - client_rc.left;
    let height = client_rc.bottom - client_rc.top;

    if width > 0 && height > 0 {
        let mem_dc = CreateCompatibleDC(hdc);
        if mem_dc != 0 {
            let mem_bmp = CreateCompatibleBitmap(hdc, width, height);
            if mem_bmp != 0 {
                let old_bmp = SelectObject(mem_dc, mem_bmp);

                // 1. Fill background.
                fill_rect(mem_dc, client_rc, palette_panel(state));

                // 2. 1 px top-edge hairline.
                fill_rect(
                    mem_dc,
                    Rect {
                        left: 0,
                        top: 0,
                        right: width,
                        bottom: 1,
                    },
                    palette_line(state),
                );

                // 3. Draw each pane.
                let dpi = GetDpiForWindow(hwnd);
                let dpi = if dpi == 0 { 96 } else { dpi };
                let parts = compute_status_parts(width, dpi);

                let texts = [
                    format_status_files(
                        state
                            .current_scan
                            .as_ref()
                            .map(|s| s.nodes.iter().filter(|n| !n.is_dir).count() as u64)
                            .unwrap_or(0),
                        state.status_idle,
                    ),
                    format_status_folders(
                        state
                            .current_scan
                            .as_ref()
                            .map(|s| s.nodes.iter().filter(|n| n.is_dir).count() as u64)
                            .unwrap_or(0),
                        state.status_idle,
                    ),
                    format_status_errors(
                        state
                            .current_scan
                            .as_ref()
                            .map(|s| s.errors.len() as u64)
                            .unwrap_or(0),
                        state.status_idle,
                    ),
                    format_status_elapsed(state.last_scan_elapsed_ms, state.status_idle),
                    format_status_throughput(
                        state.last_scan_bytes,
                        state.last_scan_elapsed_ms,
                        state.status_idle,
                    ),
                ];
                let pane_indices = [
                    PANE_FILES,
                    PANE_FOLDERS,
                    PANE_ERRORS,
                    PANE_ELAPSED,
                    PANE_THROUGHPUT,
                ];

                let old_font = SelectObject(mem_dc, state.font as Hgdobj);
                SetBkMode(mem_dc, TRANSPARENT);
                SetTextColor(mem_dc, palette_text(state));

                let pad = MulDiv(4, dpi as i32, 96);
                for (i, pane_idx) in pane_indices.iter().enumerate() {
                    let left_x = if *pane_idx == 0 {
                        0
                    } else {
                        parts[pane_idx - 1].max(0)
                    };
                    let right_x = if parts[i] == -1 { width } else { parts[i] };
                    let mut text_rect = Rect {
                        left: left_x + pad,
                        top: 0,
                        right: right_x - pad,
                        bottom: height,
                    };
                    let wide = crate::io::wide(&texts[i]);
                    DrawTextW(
                        mem_dc,
                        wide.as_ptr(),
                        -1,
                        &mut text_rect,
                        DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX,
                    );
                }
                SelectObject(mem_dc, old_font);

                use super::ffi::SRCCOPY;
                BitBlt(hdc, 0, 0, width, height, mem_dc, 0, 0, SRCCOPY);
                SelectObject(mem_dc, old_bmp);
                DeleteObject(mem_bmp);
            }
            DeleteDC(mem_dc);
        }
    }

    EndPaint(hwnd, &paint);
}

/// Window proc for the FileTreeStatusFooter custom-painted child window.
///
/// SAFETY: Win32 calls this with validated HWND/msg/wparam/lparam per the OS contract.
pub(super) unsafe extern "system" fn status_footer_window_proc(
    hwnd: Hwnd,
    msg: Uint,
    wparam: super::ffi::Wparam,
    lparam: super::ffi::Lparam,
) -> super::ffi::Lresult {
    use super::ffi::{DefWindowProcW, WM_ERASEBKGND, WM_PAINT};
    match msg {
        WM_PAINT => {
            // draw_status_footer calls BeginPaint/EndPaint internally.
            // If the lock is contended, we must still call BeginPaint/EndPaint to
            // clear the update region — otherwise WM_PAINT re-fires in an infinite loop.
            if super::state::with_state_mut(|state| draw_status_footer(hwnd, state)).is_none() {
                let mut ps: super::ffi::PaintStruct = std::mem::zeroed();
                BeginPaint(hwnd, &mut ps);
                EndPaint(hwnd, &ps);
            }
            0
        }
        WM_ERASEBKGND => 1,
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// Register the FileTreeStatusFooter window class (idempotent via OnceLock).
///
/// SAFETY: h_instance must be the module's HINSTANCE from GetModuleHandleW.
pub(super) fn register_status_footer_class(h_instance: super::ffi::Hinstance) -> super::ffi::Bool {
    use super::ffi::{
        CS_HREDRAW, CS_VREDRAW, IDC_ARROW, LoadCursorW, RegisterClassW, STATUS_FOOTER_CLASS_NAME,
        WndClassW,
    };
    use std::sync::OnceLock;
    static REGISTERED: OnceLock<bool> = OnceLock::new();
    *REGISTERED.get_or_init(|| unsafe {
        let class_name = crate::io::wide(STATUS_FOOTER_CLASS_NAME);
        let cursor = LoadCursorW(0, IDC_ARROW as *const u16);
        let wc = WndClassW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(status_footer_window_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: h_instance,
            hIcon: 0,
            hCursor: cursor,
            hbrBackground: 0,
            lpszMenuName: std::ptr::null(),
            lpszClassName: class_name.as_ptr(),
        };
        RegisterClassW(&wc) != 0
    }) as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_status_files_active() {
        assert_eq!(format_status_files(1234, false), "1,234 files");
        assert_eq!(format_status_files(1, false), "1 file");
        assert_eq!(format_status_files(0, false), "0 files");
    }

    #[test]
    fn format_status_files_idle() {
        assert_eq!(format_status_files(0, true), "-- files");
        assert_eq!(format_status_files(999, true), "-- files");
    }

    #[test]
    fn format_status_folders_pluralization() {
        assert_eq!(format_status_folders(1, false), "1 folder");
        assert_eq!(format_status_folders(567, false), "567 folders");
    }

    #[test]
    fn format_status_errors_pluralization() {
        assert_eq!(format_status_errors(1, false), "1 error");
        assert_eq!(format_status_errors(8, false), "8 errors");
    }

    #[test]
    fn format_status_elapsed_under_hour() {
        assert_eq!(format_status_elapsed(42_000, false), "0:42");
        assert_eq!(format_status_elapsed(63_000, false), "1:03");
        assert_eq!(format_status_elapsed(0, false), "0:00");
    }

    #[test]
    fn format_status_elapsed_over_hour() {
        assert_eq!(format_status_elapsed(3_723_456, false), "1:02:03");
        assert_eq!(format_status_elapsed(7_200_000, false), "2:00:00");
    }

    #[test]
    fn format_status_elapsed_idle() {
        assert_eq!(format_status_elapsed(0, true), "--:--");
    }

    #[test]
    fn format_status_throughput_active() {
        assert_eq!(
            format_status_throughput(10 * 1024 * 1024, 1000, false),
            "10.0 MB/s"
        );
    }

    #[test]
    fn format_status_throughput_below_threshold() {
        assert_eq!(format_status_throughput(1024, 1000, false), "<0.1 MB/s");
    }

    #[test]
    fn format_status_throughput_zero_bytes() {
        assert_eq!(format_status_throughput(0, 1500, false), "0.0 MB/s");
    }

    #[test]
    fn format_status_throughput_idle_or_completed() {
        assert_eq!(format_status_throughput(99_999_999, 1000, true), "-- MB/s");
    }

    #[test]
    fn compute_status_parts_96dpi() {
        assert_eq!(compute_status_parts(1280, 96), [180, 360, 500, 640, -1]);
    }

    #[test]
    fn compute_status_parts_144dpi() {
        let parts = compute_status_parts(1920, 144);
        assert_eq!(parts[0], 270);
        assert_eq!(parts[1], 540);
        assert_eq!(parts[2], 750);
        assert_eq!(parts[3], 960);
        assert_eq!(parts[4], -1);
    }

    // --- Phase 02.1-06 unit tests for menu_item_colors ---

    // Palette values from UI-SPEC D-05 (dark branch):
    // palette_text dark  = rgb(204, 204, 204)
    // palette_panel dark = rgb(45, 45, 45)
    // palette_disabled dark = rgb(122, 122, 122)

    /// Normal (unselected, enabled) in dark mode → palette_text + palette_panel.
    #[test]
    fn menu_item_colors_normal_dark() {
        let accent = rgb(0, 120, 215);
        let sel_text = rgb(255, 255, 255);
        let (fg, bg) = menu_item_colors(0, true, accent, sel_text);
        assert_eq!(
            fg,
            rgb(204, 204, 204),
            "dark normal fg should be palette_text_dark"
        );
        assert_eq!(
            bg,
            rgb(45, 45, 45),
            "dark normal bg should be palette_panel_dark"
        );
    }

    /// ODS_SELECTED in dark mode → selected_text + accent colors.
    #[test]
    fn menu_item_colors_selected_dark() {
        let accent = rgb(0, 120, 215);
        let sel_text = rgb(255, 255, 255);
        let (fg, bg) = menu_item_colors(super::super::ffi::ODS_SELECTED, true, accent, sel_text);
        assert_eq!(
            fg,
            rgb(255, 255, 255),
            "selected fg should be selected_text_color"
        );
        assert_eq!(bg, rgb(0, 120, 215), "selected bg should be accent");
    }

    /// ODS_DISABLED in dark mode → palette_disabled + palette_panel.
    #[test]
    fn menu_item_colors_disabled_dark() {
        let accent = rgb(0, 120, 215);
        let sel_text = rgb(255, 255, 255);
        let (fg, bg) = menu_item_colors(super::super::ffi::ODS_DISABLED, true, accent, sel_text);
        assert_eq!(
            fg,
            rgb(122, 122, 122),
            "disabled fg should be palette_disabled_dark"
        );
        assert_eq!(
            bg,
            rgb(45, 45, 45),
            "disabled bg should be palette_panel_dark"
        );
    }

    /// Normal in light mode → NOT the dark-palette values (light branch delegate from system).
    #[test]
    fn menu_item_colors_normal_light() {
        let accent = rgb(0, 120, 215);
        let sel_text = rgb(0, 0, 0);
        let (fg, bg) = menu_item_colors(0, false, accent, sel_text);
        // Light-mode palette delegates to different values; assert they are NOT the dark values.
        assert_ne!(
            bg,
            rgb(45, 45, 45),
            "light bg must not be dark palette_panel"
        );
        assert_ne!(
            fg,
            rgb(204, 204, 204),
            "light fg must not be dark palette_text"
        );
    }

    /// ODS_HOTLIGHT returns the same colors as ODS_SELECTED (D-07 rule).
    #[test]
    fn menu_item_colors_hotlight_same_as_selected() {
        let accent = rgb(0, 120, 215);
        let sel_text = rgb(255, 255, 255);
        let (fg_sel, bg_sel) =
            menu_item_colors(super::super::ffi::ODS_SELECTED, true, accent, sel_text);
        let (fg_hot, bg_hot) =
            menu_item_colors(super::super::ffi::ODS_HOTLIGHT, true, accent, sel_text);
        assert_eq!(
            (fg_sel, bg_sel),
            (fg_hot, bg_hot),
            "hover (HOTLIGHT) and selected must produce identical colors"
        );
    }
}
