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
    DT_CENTER, DT_END_ELLIPSIS, DT_LEFT, DT_NOPREFIX, DT_RIGHT, DT_SINGLELINE, DT_VCENTER,
    DeleteDC, DeleteObject, DrawIconEx, DrawTextW, EndPaint, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_NORMAL, FillRect, GetClientRect, Hdc, Hgdobj, Hicon, Hwnd, PaintStruct, Rect,
    SHGFI_ICON, SHGFI_SMALLICON, SHGFI_USEFILEATTRIBUTES, SHGetFileInfoW, SRCCOPY, SelectObject,
    SendMessageW, SetBkMode, SetTextColor, ShFileInfoW, TRANSPARENT, Uint,
};
use super::state::{DesktopState, with_state_mut};
use super::theme::{
    palette_bg, palette_grid, palette_header, palette_hovered, palette_line, palette_muted,
    palette_panel, palette_percent_fill, palette_percent_track, palette_selected, palette_size_bar,
    palette_table, palette_table_alt, palette_text, rgb,
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
    let sample_path = super::wide(&sample_path);
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

                with_state_mut(|state| {
                    fill_rect(mem_dc, rect, palette_bg(state));
                    draw_toolbar_background(mem_dc, rect, state);
                    draw_table(mem_dc, rect, state);
                });

                BitBlt(hdc, 0, 0, width, height, mem_dc, 0, 0, SRCCOPY);

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
        let is_active = state.active_tab == i;
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

pub(super) unsafe fn fill_rect(hdc: Hdc, rect: Rect, color: super::ffi::Dword) {
    let brush = CreateSolidBrush(color);
    FillRect(hdc, &rect, brush);
    DeleteObject(brush as Hgdobj);
}

pub(super) unsafe fn draw_text(hdc: Hdc, text: &str, rect: &mut Rect, flags: Uint) {
    let wide = super::wide(text);
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
