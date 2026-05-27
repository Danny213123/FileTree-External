use std::env;
use std::io::Write;
use std::path::PathBuf;

use crate::analytics::{
    age_stats, duplicate_candidates, extension_stats, largest_dir_ids, top_file_ids,
};
use crate::cli::{APP_NAME, APP_VERSION};
use crate::io::{default_thread_count, epoch_ms_to_utc, path_to_string};
use crate::model::{AppState, ScanResult};

/// Write scan result JSON directly to any `Write` impl (e.g. a TCP stream).
/// Avoids materialising a 300-400 MB intermediate String for large scans.
pub(crate) fn write_scan_result_json<W: Write>(w: &mut W, result: &ScanResult) -> std::io::Result<()> {
    let top_files = top_file_ids(&result.nodes, 100);
    let largest_dirs = largest_dir_ids(&result.nodes, 100);
    let extension_stats = extension_stats(&result.nodes, 80);
    let age_stats = age_stats(&result.nodes, result.scanned_at_ms);
    let duplicate_candidates = duplicate_candidates(&result.nodes, 100);

    // Use a 64 KB write buffer so we're not calling the underlying writer for every field.
    let mut buf = Vec::with_capacity(65536);

    macro_rules! e {
        ($($arg:tt)*) => {{ write!(buf, $($arg)*)?; }}
    }

    e!("{{");
    e!("\"app\":"); emit_json_str(&mut buf, APP_NAME);
    e!(",\"version\":"); emit_json_str(&mut buf, APP_VERSION);
    e!(",\"rootPath\":"); emit_json_str(&mut buf, &result.root_path);
    e!(",\"scannedAt\":{}", result.scanned_at_ms);
    e!(",\"elapsedMs\":{}", result.elapsed_ms);
    e!(",\"threadCount\":{}", result.thread_count);
    e!(",\"nodeCount\":{}", result.nodes.len());
    e!(",\"errorCount\":{}", result.errors.len());

    e!(",\"nodes\":[");
    for (index, node) in result.nodes.iter().enumerate() {
        if index > 0 { e!(","); }
        e!("{{\"id\":{}", node.id);
        match node.parent {
            Some(p) => { e!(",\"parent\":{p}"); }
            None    => { e!(",\"parent\":null"); }
        }
        e!(",\"name\":"); emit_json_str(&mut buf, &node.name);
        e!(",\"dir\":{}", if node.is_dir { "true" } else { "false" });
        e!(",\"link\":{}", if node.is_link { "true" } else { "false" });
        e!(",\"hidden\":{}", if node.hidden { "true" } else { "false" });
        e!(",\"readonly\":{}", if node.readonly { "true" } else { "false" });
        e!(",\"size\":{}", node.size);
        e!(",\"allocated\":{}", node.allocated);
        e!(",\"files\":{}", node.files);
        e!(",\"folders\":{}", node.folders);
        e!(",\"modified\":{}", node.modified_ms);
        e!(",\"created\":{}", node.created_ms);
        e!(",\"accessed\":{}", node.accessed_ms);
        e!(",\"depth\":{}", node.depth);
        e!(",\"errors\":{}", node.errors);
        e!(",\"extension\":"); emit_json_str(&mut buf, &node.extension);
        e!(",\"path\":"); emit_json_str(&mut buf, &node.path);
        e!("}}");

        // Flush every 8192 nodes to keep the buffer bounded (~3 MB at a time).
        if index % 8192 == 8191 {
            w.write_all(&buf)?;
            buf.clear();
        }
    }
    e!("]");
    w.write_all(&buf)?;
    buf.clear();

    e!(",\"topFiles\":"); emit_id_array_w(&mut buf, &top_files);
    e!(",\"largestDirs\":"); emit_id_array_w(&mut buf, &largest_dirs);

    e!(",\"extensionStats\":[");
    for (i, stat) in extension_stats.iter().enumerate() {
        if i > 0 { e!(","); }
        e!("{{\"ext\":"); emit_json_str(&mut buf, &stat.ext);
        e!(",\"bytes\":{},\"allocated\":{},\"files\":{}}}", stat.bytes, stat.allocated, stat.files);
    }
    e!("]");

    e!(",\"ageStats\":[");
    for (i, stat) in age_stats.iter().enumerate() {
        if i > 0 { e!(","); }
        e!("{{\"label\":"); emit_json_str(&mut buf, stat.label);
        e!(",\"bytes\":{},\"files\":{}}}", stat.bytes, stat.files);
    }
    e!("]");

    e!(",\"duplicateCandidates\":[");
    for (i, group) in duplicate_candidates.iter().enumerate() {
        if i > 0 { e!(","); }
        e!("{{\"name\":"); emit_json_str(&mut buf, &group.name);
        e!(",\"size\":{},\"waste\":{},\"ids\":", group.size, group.waste);
        emit_id_array_w(&mut buf, &group.ids);
        e!("}}");
    }
    e!("]");

    e!(",\"scanErrors\":[");
    for (i, error) in result.errors.iter().take(500).enumerate() {
        if i > 0 { e!(","); }
        e!("{{\"path\":"); emit_json_str(&mut buf, &error.path);
        e!(",\"message\":"); emit_json_str(&mut buf, &error.message);
        e!("}}");
    }
    e!("]}}");

    w.write_all(&buf)?;
    Ok(())
}

/// Convenience wrapper that collects write_scan_result_json output into a String.
/// Only called for small/cached scans and exports; prefer write_scan_result_json for live scans.
pub(crate) fn scan_result_to_json(result: &ScanResult) -> String {
    let mut buf = Vec::with_capacity(result.nodes.len().saturating_mul(400));
    write_scan_result_json(&mut buf, result).expect("vec write cannot fail");
    String::from_utf8(buf).expect("json is valid utf8")
}

fn emit_json_str(buf: &mut Vec<u8>, value: &str) {
    buf.push(b'"');
    for ch in value.chars() {
        match ch {
            '"'  => buf.extend_from_slice(b"\\\""),
            '\\' => buf.extend_from_slice(b"\\\\"),
            '\n' => buf.extend_from_slice(b"\\n"),
            '\r' => buf.extend_from_slice(b"\\r"),
            '\t' => buf.extend_from_slice(b"\\t"),
            ch if (ch as u32) < 0x20 => {
                let _ = write!(buf, "\\u{:04x}", ch as u32);
            }
            ch => {
                let mut tmp = [0u8; 4];
                buf.extend_from_slice(ch.encode_utf8(&mut tmp).as_bytes());
            }
        }
    }
    buf.push(b'"');
}

fn emit_id_array_w(buf: &mut Vec<u8>, ids: &[usize]) {
    buf.push(b'[');
    for (i, id) in ids.iter().enumerate() {
        if i > 0 { buf.push(b','); }
        let _ = write!(buf, "{id}");
    }
    buf.push(b']');
}

pub(crate) fn scan_result_to_csv(result: &ScanResult) -> String {
    let mut output = String::from(
        "Path,Name,Type,Size,Allocated,Files,Folders,PercentOfParent,ModifiedUtc,Hidden,Readonly,Link,Errors\n",
    );
    for node in &result.nodes {
        let parent_size = node
            .parent
            .and_then(|parent| result.nodes.get(parent))
            .map(|parent| parent.size)
            .unwrap_or(node.size);
        let percent = if parent_size > 0 {
            (node.size as f64 / parent_size as f64) * 100.0
        } else {
            0.0
        };
        push_csv_field(&mut output, &node.path);
        output.push(',');
        push_csv_field(&mut output, &node.name);
        output.push(',');
        output.push_str(if node.is_dir { "Directory" } else { "File" });
        output.push(',');
        output.push_str(&node.size.to_string());
        output.push(',');
        output.push_str(&node.allocated.to_string());
        output.push(',');
        output.push_str(&node.files.to_string());
        output.push(',');
        output.push_str(&node.folders.to_string());
        output.push(',');
        output.push_str(&format!("{percent:.4}"));
        output.push(',');
        push_csv_field(&mut output, &epoch_ms_to_utc(node.modified_ms));
        output.push(',');
        output.push_str(if node.hidden { "true" } else { "false" });
        output.push(',');
        output.push_str(if node.readonly { "true" } else { "false" });
        output.push(',');
        output.push_str(if node.is_link { "true" } else { "false" });
        output.push(',');
        output.push_str(&node.errors.to_string());
        output.push('\n');
    }
    output
}

pub(crate) fn app_config_json(state: &AppState) -> String {
    let mut output = String::from("{\"initialPath\":");
    push_json_string(&mut output, &path_to_string(&state.initial_path));
    output.push_str(",\"defaultThreads\":");
    output.push_str(&default_thread_count().to_string());
    output.push('}');
    output
}

pub(crate) fn drives_json() -> String {
    // Build list of {root, label} objects.
    let drives = enumerate_drives();
    let mut output = String::from("{\"drives\":[");
    for (index, (root, label)) in drives.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push_str("{\"root\":");
        push_json_string(&mut output, root);
        output.push_str(",\"label\":");
        push_json_string(&mut output, label);
        output.push('}');
    }
    output.push_str("]}");
    output
}

pub(crate) fn special_folders_json() -> String {
    let mut folders: Vec<(String, String)> = Vec::new(); // (label, path)

    let add = |folders: &mut Vec<(String, String)>, var: &str, label: &str| {
        if let Some(val) = env::var_os(var) {
            let path = PathBuf::from(val);
            if path.is_dir() {
                folders.push((label.to_string(), path.display().to_string()));
            }
        }
    };

    // OneDrive
    if let Some(od) = env::var_os("OneDrive").or_else(|| env::var_os("OneDriveConsumer")) {
        let path = PathBuf::from(od);
        if path.is_dir() {
            // Use the folder name as label (e.g. "OneDrive - Contoso")
            let label = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("OneDrive")
                .to_string();
            folders.push((label, path.display().to_string()));
        }
    }

    // User profile sub-folders
    if let Some(profile) = env::var_os("USERPROFILE") {
        let base = PathBuf::from(profile);
        for (name, label) in &[
            ("Documents", "Documents"),
            ("Desktop", "Desktop"),
            ("Downloads", "Downloads"),
        ] {
            let path = base.join(name);
            if path.is_dir() {
                folders.push((label.to_string(), path.display().to_string()));
            }
        }
    }

    // Recycle Bin (Windows only — always at <SYSTEMDRIVE>\$Recycle.Bin)
    #[cfg(windows)]
    {
        let drive = env::var("SYSTEMDRIVE").unwrap_or_else(|_| "C:".to_string());
        let recycle = PathBuf::from(format!("{}\\$Recycle.Bin", drive));
        if recycle.is_dir() {
            folders.push(("Recycle Bin".to_string(), recycle.display().to_string()));
        }
    }

    // Fallback for HOME on non-Windows
    add(&mut folders, "HOME", "Home");

    let mut output = String::from("{\"folders\":[");
    for (index, (label, path)) in folders.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push_str("{\"label\":");
        push_json_string(&mut output, label);
        output.push_str(",\"path\":");
        push_json_string(&mut output, path);
        output.push('}');
    }
    output.push_str("]}");
    output
}

/// Returns (root_path, volume_label) for each available drive.
fn enumerate_drives() -> Vec<(String, String)> {
    let mut result = Vec::new();

    #[cfg(windows)]
    unsafe {
        // Load Kernel32 functions at runtime to keep this cross-compilable.
        unsafe extern "system" {
            fn GetLogicalDrives() -> u32;
            fn GetDriveTypeW(lpRootPathName: *const u16) -> u32;
            fn GetVolumeInformationW(
                lpRootPathName: *const u16,
                lpVolumeNameBuffer: *mut u16,
                nVolumeNameSize: u32,
                lpVolumeSerialNumber: *mut u32,
                lpMaximumComponentLength: *mut u32,
                lpFileSystemFlags: *mut u32,
                lpFileSystemNameBuffer: *mut u16,
                nFileSystemNameSize: u32,
            ) -> i32;
        }

        const DRIVE_REMOVABLE: u32 = 2;
        const DRIVE_CDROM: u32 = 5;

        let mask = GetLogicalDrives();
        for bit in 0u32..26 {
            if mask & (1 << bit) == 0 {
                continue;
            }
            let letter = (b'A' + bit as u8) as char;
            let root = format!("{letter}:\\");
            let wide_root: Vec<u16> = root.encode_utf16().chain(Some(0)).collect();

            let dtype = GetDriveTypeW(wide_root.as_ptr());
            if !(DRIVE_REMOVABLE..=DRIVE_CDROM).contains(&dtype) {
                continue; // skip DRIVE_UNKNOWN / DRIVE_NO_ROOT_DIR
            }

            // Get volume label.
            let mut vol_buf = vec![0u16; 256];
            let ok = GetVolumeInformationW(
                wide_root.as_ptr(),
                vol_buf.as_mut_ptr(),
                vol_buf.len() as u32,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
            );

            let label = if ok != 0 {
                let end = vol_buf
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(vol_buf.len());
                String::from_utf16_lossy(&vol_buf[..end])
            } else {
                match dtype {
                    DRIVE_REMOVABLE => "Removable Disk".to_string(),
                    4 => "Network Drive".to_string(),
                    DRIVE_CDROM => "CD Drive".to_string(),
                    _ => "Local Disk".to_string(),
                }
            };

            // Format: "Windows (C:)" or "Local Disk (C:)"
            let display = if label.is_empty() {
                "Local Disk".to_string()
            } else {
                label
            };
            result.push((root, format!("{display} ({letter}:)")));
        }
    }

    #[cfg(not(windows))]
    {
        result.push(("/".to_string(), "Root (/)".to_string()));
        if let Some(home) = env::var_os("HOME") {
            let path = PathBuf::from(home).display().to_string();
            result.push((path.clone(), format!("Home ({})", path)));
        }
    }

    result
}

pub(crate) fn push_id_array(output: &mut String, ids: &[usize]) {
    output.push('[');
    for (index, id) in ids.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push_str(&id.to_string());
    }
    output.push(']');
}

pub(crate) fn push_json_string(output: &mut String, value: &str) {
    output.push('"');
    for ch in value.chars() {
        match ch {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            ch if ch < ' ' => output.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => output.push(ch),
        }
    }
    output.push('"');
}

pub(crate) fn push_csv_field(output: &mut String, value: &str) {
    let needs_quotes =
        value.contains(',') || value.contains('"') || value.contains('\n') || value.contains('\r');
    if needs_quotes {
        output.push('"');
        for ch in value.chars() {
            if ch == '"' {
                output.push('"');
            }
            output.push(ch);
        }
        output.push('"');
    } else {
        output.push_str(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_fields_are_escaped() {
        let mut output = String::new();
        push_csv_field(&mut output, "a,b \"c\"");
        assert_eq!(output, "\"a,b \"\"c\"\"\"");
    }
}
