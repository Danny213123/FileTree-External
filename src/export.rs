use std::env;
use std::io::Write;
use std::path::PathBuf;

use crate::cli::{APP_NAME, APP_VERSION};
use crate::io::{default_thread_count, epoch_ms_to_utc, path_to_string};
use crate::model::{AppState, ScanResult};

/// Write scan result JSON directly to any `Write` impl (e.g. a TCP stream).
/// Avoids materialising a 300-400 MB intermediate String for large scans.
pub(crate) fn write_scan_result_json<W: Write>(w: &mut W, result: &ScanResult) -> std::io::Result<()> {
    // Reuse analytics computed once at scan time (no per-response recompute).
    // These are small, capped collections, so cloning them is negligible.
    let top_files = result.summary.top_files.clone();
    let largest_dirs = result.summary.largest_dirs.clone();
    let extension_stats = result.summary.extension_stats.clone();
    let age_stats = result.summary.age_stats.clone();
    let duplicate_candidates = result.summary.duplicate_candidates.clone();

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
        e!(",\"owner\":"); emit_json_str(&mut buf, &node.owner);
        e!(",\"attributes\":{}", node.attributes);
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

/// Stream scan result as newline-delimited JSON so the browser never has to parse
/// a single giant string.  Protocol:
///   {"type":"meta","rootPath":"...","scannedAt":N,...all analytics...}
///   {"type":"node","id":N,"parent":N|null,...}   ← one per node
///   {"type":"done"}
pub(crate) fn write_scan_result_ndjson<W: Write>(w: &mut W, result: &ScanResult) -> std::io::Result<()> {
    let top_files        = result.summary.top_files.clone();
    let largest_dirs     = result.summary.largest_dirs.clone();
    let ext_stats        = result.summary.extension_stats.clone();
    let age_st           = result.summary.age_stats.clone();
    let dup_cands        = result.summary.duplicate_candidates.clone();

    let mut buf = Vec::with_capacity(65536);

    macro_rules! e {
        ($($arg:tt)*) => {{ write!(buf, $($arg)*)?; }}
    }

    // ── meta line ──────────────────────────────────────────────────────────
    e!("{{\"type\":\"meta\"");
    e!(",\"app\":"); emit_json_str(&mut buf, APP_NAME);
    e!(",\"version\":"); emit_json_str(&mut buf, APP_VERSION);
    e!(",\"rootPath\":"); emit_json_str(&mut buf, &result.root_path);
    e!(",\"scannedAt\":{}", result.scanned_at_ms);
    e!(",\"elapsedMs\":{}", result.elapsed_ms);
    e!(",\"threadCount\":{}", result.thread_count);
    e!(",\"nodeCount\":{}", result.nodes.len());
    e!(",\"errorCount\":{}", result.errors.len());

    e!(",\"topFiles\":"); emit_id_array_w(&mut buf, &top_files);
    e!(",\"largestDirs\":"); emit_id_array_w(&mut buf, &largest_dirs);

    e!(",\"extensionStats\":[");
    for (i, stat) in ext_stats.iter().enumerate() {
        if i > 0 { e!(","); }
        e!("{{\"ext\":"); emit_json_str(&mut buf, &stat.ext);
        e!(",\"bytes\":{},\"allocated\":{},\"files\":{}}}", stat.bytes, stat.allocated, stat.files);
    }
    e!("]");

    e!(",\"ageStats\":[");
    for (i, stat) in age_st.iter().enumerate() {
        if i > 0 { e!(","); }
        e!("{{\"label\":"); emit_json_str(&mut buf, stat.label);
        e!(",\"bytes\":{},\"files\":{}}}", stat.bytes, stat.files);
    }
    e!("]");

    e!(",\"duplicateCandidates\":[");
    for (i, group) in dup_cands.iter().enumerate() {
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
    buf.push(b'\n');
    w.write_all(&buf)?;
    buf.clear();

    // ── node lines ─────────────────────────────────────────────────────────
    for (index, node) in result.nodes.iter().enumerate() {
        e!("{{\"type\":\"node\"");
        e!(",\"id\":{}", node.id);
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
        e!(",\"owner\":"); emit_json_str(&mut buf, &node.owner);
        e!(",\"attributes\":{}", node.attributes);
        e!("}}");
        buf.push(b'\n');

        // Flush every 4096 nodes (~1.2 MB) so the TCP window stays full.
        if index % 4096 == 4095 {
            w.write_all(&buf)?;
            buf.clear();
        }
    }

    // ── done line ──────────────────────────────────────────────────────────
    buf.extend_from_slice(b"{\"type\":\"done\"}\n");
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
        "Path,Name,Type,Size,Allocated,Files,Folders,PercentOfParent,ModifiedUtc,Hidden,Readonly,Link,Errors,Owner\n",
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
        output.push(',');
        push_csv_field(&mut output, &node.owner);
        output.push('\n');
    }
    output
}

// ── Richer report exports (roadmap item #8): HTML, XML, XLSX ──────────────────
// All three are dependency-free (this crate has no external deps): HTML/XML are
// hand-written text; XLSX is a hand-built Office-Open-XML package (see
// `crate::xlsx`). Each reuses the analytics precomputed on `ScanResult::summary`,
// so a report reflects the same "top files / by type / by age" the UI shows.

/// Human-readable byte size (e.g. `1.50 GB`) for report tables.
pub(crate) fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 6] = ["B", "KB", "MB", "GB", "TB", "PB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64;
    let mut unit = 0usize;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.2} {}", UNITS[unit])
}

fn push_html_escaped(output: &mut String, value: &str) {
    for ch in value.chars() {
        match ch {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            '"' => output.push_str("&quot;"),
            '\'' => output.push_str("&#39;"),
            c => output.push(c),
        }
    }
}

fn push_xml_escaped(output: &mut String, value: &str) {
    for ch in value.chars() {
        match ch {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            '"' => output.push_str("&quot;"),
            '\'' => output.push_str("&apos;"),
            // XML 1.0 forbids C0 control chars except tab/newline/return.
            c if (c as u32) < 0x20 && c != '\t' && c != '\n' && c != '\r' => {}
            c => output.push(c),
        }
    }
}

/// Indices of the (up to) `limit` largest nodes by size, descending — used for
/// the "largest entries" table in the HTML report and the rows of the XLSX.
fn largest_by_size(result: &ScanResult, limit: usize) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..result.nodes.len()).collect();
    idx.sort_unstable_by(|&a, &b| result.nodes[b].size.cmp(&result.nodes[a].size));
    idx.truncate(limit);
    idx
}

/// Self-contained HTML report: scanned root, totals, analytics (largest folders,
/// top files, by type, by age, duplicate candidates) and a largest-entries
/// table. Inline CSS + a "Print / Save as PDF" button, so the same file doubles
/// as the print-to-PDF path (#8: PDF = print the HTML report).
pub(crate) fn scan_result_to_html(result: &ScanResult) -> String {
    const TABLE_CAP: usize = 1000;
    let root = result.nodes.first();
    let total_size = root.map(|n| n.size).unwrap_or(0);
    let total_files = root.map(|n| n.files).unwrap_or(0);
    let total_folders = root.map(|n| n.folders).unwrap_or(0);

    let mut h = String::with_capacity(64 * 1024);
    h.push_str("<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">");
    h.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>FileTree Report — ");
    push_html_escaped(&mut h, &result.root_path);
    h.push_str("</title><style>");
    h.push_str(REPORT_CSS);
    h.push_str("</style></head><body>");

    // Header + actions.
    h.push_str("<header class=\"rpt-head\"><div><h1>FileTree Report</h1><div class=\"rpt-root\">");
    push_html_escaped(&mut h, &result.root_path);
    h.push_str("</div></div><button class=\"rpt-print\" onclick=\"window.print()\">Print / Save as PDF</button></header>");

    // Totals cards.
    h.push_str("<section class=\"rpt-cards\">");
    push_card(&mut h, "Total size", &human_bytes(total_size));
    push_card(&mut h, "Files", &total_files.to_string());
    push_card(&mut h, "Folders", &total_folders.to_string());
    push_card(&mut h, "Items scanned", &result.nodes.len().to_string());
    h.push_str("</section>");

    // Scan metadata.
    h.push_str("<section class=\"rpt-meta\"><span>Scanned ");
    push_html_escaped(&mut h, &epoch_ms_to_utc(result.scanned_at_ms));
    h.push_str(&format!(
        "</span><span>{} ms</span><span>{} threads</span><span>{} errors</span><span>{} v{}</span></section>",
        result.elapsed_ms, result.thread_count, result.errors.len(), APP_NAME, APP_VERSION
    ));

    // Largest folders.
    if !result.summary.largest_dirs.is_empty() {
        h.push_str("<h2>Largest folders</h2><table><thead><tr><th>Folder</th><th class=\"num\">Size</th><th class=\"num\">Files</th></tr></thead><tbody>");
        for &id in &result.summary.largest_dirs {
            if let Some(node) = result.nodes.get(id) {
                h.push_str("<tr><td>");
                push_html_escaped(&mut h, &node.path);
                h.push_str("</td><td class=\"num\">");
                h.push_str(&human_bytes(node.size));
                h.push_str("</td><td class=\"num\">");
                h.push_str(&node.files.to_string());
                h.push_str("</td></tr>");
            }
        }
        h.push_str("</tbody></table>");
    }

    // Top files.
    if !result.summary.top_files.is_empty() {
        h.push_str("<h2>Top files</h2><table><thead><tr><th>File</th><th>Folder</th><th class=\"num\">Size</th></tr></thead><tbody>");
        for &id in &result.summary.top_files {
            if let Some(node) = result.nodes.get(id) {
                let parent_path = node
                    .parent
                    .and_then(|p| result.nodes.get(p))
                    .map(|p| p.path.as_str())
                    .unwrap_or("");
                h.push_str("<tr><td>");
                push_html_escaped(&mut h, &node.name);
                h.push_str("</td><td>");
                push_html_escaped(&mut h, parent_path);
                h.push_str("</td><td class=\"num\">");
                h.push_str(&human_bytes(node.size));
                h.push_str("</td></tr>");
            }
        }
        h.push_str("</tbody></table>");
    }

    // By type.
    if !result.summary.extension_stats.is_empty() {
        h.push_str("<h2>By type</h2><table><thead><tr><th>Extension</th><th class=\"num\">Size</th><th class=\"num\">Files</th></tr></thead><tbody>");
        for stat in &result.summary.extension_stats {
            h.push_str("<tr><td>");
            push_html_escaped(&mut h, if stat.ext.is_empty() { "(none)" } else { &stat.ext });
            h.push_str("</td><td class=\"num\">");
            h.push_str(&human_bytes(stat.bytes));
            h.push_str("</td><td class=\"num\">");
            h.push_str(&stat.files.to_string());
            h.push_str("</td></tr>");
        }
        h.push_str("</tbody></table>");
    }

    // By age.
    if !result.summary.age_stats.is_empty() {
        h.push_str("<h2>By age</h2><table><thead><tr><th>Age</th><th class=\"num\">Size</th><th class=\"num\">Files</th></tr></thead><tbody>");
        for stat in &result.summary.age_stats {
            h.push_str("<tr><td>");
            push_html_escaped(&mut h, stat.label);
            h.push_str("</td><td class=\"num\">");
            h.push_str(&human_bytes(stat.bytes));
            h.push_str("</td><td class=\"num\">");
            h.push_str(&stat.files.to_string());
            h.push_str("</td></tr>");
        }
        h.push_str("</tbody></table>");
    }

    // Duplicate candidates (only if the scan computed any).
    if !result.summary.duplicate_candidates.is_empty() {
        h.push_str("<h2>Duplicate candidates</h2><table><thead><tr><th>Name</th><th class=\"num\">Size each</th><th class=\"num\">Copies</th><th class=\"num\">Wasted</th></tr></thead><tbody>");
        for group in &result.summary.duplicate_candidates {
            h.push_str("<tr><td>");
            push_html_escaped(&mut h, &group.name);
            h.push_str("</td><td class=\"num\">");
            h.push_str(&human_bytes(group.size));
            h.push_str("</td><td class=\"num\">");
            h.push_str(&group.ids.len().to_string());
            h.push_str("</td><td class=\"num\">");
            h.push_str(&human_bytes(group.waste));
            h.push_str("</td></tr>");
        }
        h.push_str("</tbody></table>");
    }

    // Largest entries table (capped — the analytics above are the headline).
    let largest = largest_by_size(result, TABLE_CAP);
    h.push_str("<h2>Largest entries");
    if result.nodes.len() > largest.len() {
        h.push_str(&format!(
            " <span class=\"rpt-note\">(top {} of {})</span>",
            largest.len(),
            result.nodes.len()
        ));
    }
    h.push_str("</h2><table><thead><tr><th>Name</th><th>Path</th><th>Type</th><th class=\"num\">Size</th><th>Modified</th><th>Owner</th></tr></thead><tbody>");
    for &id in &largest {
        if let Some(node) = result.nodes.get(id) {
            h.push_str("<tr><td>");
            push_html_escaped(&mut h, &node.name);
            h.push_str("</td><td class=\"path\">");
            push_html_escaped(&mut h, &node.path);
            h.push_str("</td><td>");
            h.push_str(if node.is_dir { "Folder" } else { "File" });
            h.push_str("</td><td class=\"num\">");
            h.push_str(&human_bytes(node.size));
            h.push_str("</td><td>");
            push_html_escaped(&mut h, &epoch_ms_to_utc(node.modified_ms));
            h.push_str("</td><td>");
            push_html_escaped(&mut h, &node.owner);
            h.push_str("</td></tr>");
        }
    }
    h.push_str("</tbody></table>");

    h.push_str("<footer class=\"rpt-foot\">Generated by ");
    h.push_str(APP_NAME);
    h.push_str(" v");
    h.push_str(APP_VERSION);
    h.push_str("</footer></body></html>");
    h
}

const REPORT_CSS: &str = "\
:root{color-scheme:light}\
*{box-sizing:border-box}\
body{margin:0;padding:24px;font:14px/1.5 'Segoe UI',system-ui,sans-serif;color:#1b1f24;background:#f6f8fa}\
.rpt-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px}\
h1{font-size:22px;margin:0}\
.rpt-root{color:#57606a;word-break:break-all;font-family:Consolas,monospace}\
.rpt-print{cursor:pointer;border:1px solid #d0d7de;background:#fff;border-radius:6px;padding:8px 14px;font-size:13px}\
.rpt-print:hover{background:#f3f4f6}\
.rpt-cards{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:12px}\
.rpt-card{background:#fff;border:1px solid #d8dee4;border-radius:8px;padding:12px 16px;min-width:140px}\
.rpt-card .lbl{font-size:12px;color:#57606a}\
.rpt-card .val{font-size:20px;font-weight:600}\
.rpt-meta{display:flex;flex-wrap:wrap;gap:14px;color:#57606a;font-size:12px;margin-bottom:20px}\
h2{font-size:16px;margin:24px 0 8px;border-bottom:2px solid #d8dee4;padding-bottom:4px}\
.rpt-note{font-size:12px;font-weight:400;color:#57606a}\
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #d8dee4;border-radius:8px;overflow:hidden;margin-bottom:8px}\
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #eaeef2;font-size:13px}\
th{background:#f3f4f6;font-weight:600}\
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}\
td.path{color:#57606a;font-family:Consolas,monospace;font-size:12px;word-break:break-all}\
tr:last-child td{border-bottom:none}\
.rpt-foot{margin-top:24px;color:#8b949e;font-size:12px}\
@media print{body{padding:0;background:#fff}.rpt-print{display:none}table,.rpt-card{border-color:#ccc}h2{page-break-after:avoid}tr{page-break-inside:avoid}}";

fn push_card(output: &mut String, label: &str, value: &str) {
    output.push_str("<div class=\"rpt-card\"><div class=\"lbl\">");
    push_html_escaped(output, label);
    output.push_str("</div><div class=\"val\">");
    push_html_escaped(output, value);
    output.push_str("</div></div>");
}

/// Structured XML serialization of the scan: metadata, the precomputed analytics
/// summary, and a flat `<node>` list carrying `id`/`parent` references (mirrors
/// the JSON export's shape, which is robust for arbitrarily deep trees).
pub(crate) fn scan_result_to_xml(result: &ScanResult) -> String {
    let mut x = String::with_capacity(result.nodes.len().saturating_mul(160) + 4096);
    x.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<filetreeScan app=\"");
    push_xml_escaped(&mut x, APP_NAME);
    x.push_str("\" version=\"");
    push_xml_escaped(&mut x, APP_VERSION);
    x.push_str("\" rootPath=\"");
    push_xml_escaped(&mut x, &result.root_path);
    x.push_str(&format!(
        "\" scannedAtMs=\"{}\" elapsedMs=\"{}\" threadCount=\"{}\" nodeCount=\"{}\" errorCount=\"{}\">",
        result.scanned_at_ms, result.elapsed_ms, result.thread_count, result.nodes.len(), result.errors.len()
    ));

    // Analytics summary.
    x.push_str("<summary>");
    x.push_str("<byType>");
    for stat in &result.summary.extension_stats {
        x.push_str("<ext name=\"");
        push_xml_escaped(&mut x, &stat.ext);
        x.push_str(&format!("\" bytes=\"{}\" allocated=\"{}\" files=\"{}\"/>", stat.bytes, stat.allocated, stat.files));
    }
    x.push_str("</byType><byAge>");
    for stat in &result.summary.age_stats {
        x.push_str("<bucket label=\"");
        push_xml_escaped(&mut x, stat.label);
        x.push_str(&format!("\" bytes=\"{}\" files=\"{}\"/>", stat.bytes, stat.files));
    }
    x.push_str("</byAge></summary>");

    // Flat node list.
    x.push_str("<nodes>");
    for node in &result.nodes {
        x.push_str("<node id=\"");
        x.push_str(&node.id.to_string());
        x.push('"');
        if let Some(parent) = node.parent {
            x.push_str(&format!(" parent=\"{parent}\""));
        }
        x.push_str(" name=\"");
        push_xml_escaped(&mut x, &node.name);
        x.push_str("\" path=\"");
        push_xml_escaped(&mut x, &node.path);
        x.push_str(&format!(
            "\" type=\"{}\" size=\"{}\" allocated=\"{}\" files=\"{}\" folders=\"{}\" depth=\"{}\"",
            if node.is_dir { "dir" } else { "file" },
            node.size, node.allocated, node.files, node.folders, node.depth
        ));
        x.push_str(&format!(
            " hidden=\"{}\" readonly=\"{}\" link=\"{}\" modifiedMs=\"{}\"",
            node.hidden, node.readonly, node.is_link, node.modified_ms
        ));
        x.push_str(" extension=\"");
        push_xml_escaped(&mut x, &node.extension);
        x.push_str("\" owner=\"");
        push_xml_escaped(&mut x, &node.owner);
        x.push_str("\"/>");
    }
    x.push_str("</nodes></filetreeScan>");
    x
}

/// Build a real `.xlsx` workbook of the scan via the dependency-free writer in
/// `crate::xlsx`. Capped at the largest `XLSX_ROW_CAP` entries by size to stay
/// well within Excel's row limit and bound memory (the bytes live in RAM while
/// the store-ZIP is assembled); the cap is noted to the caller in #8's report.
pub(crate) fn scan_result_to_xlsx(result: &ScanResult) -> Vec<u8> {
    use crate::xlsx::Cell;
    const XLSX_ROW_CAP: usize = 100_000;

    let headers = [
        "Path", "Name", "Type", "Size", "Allocated", "Files", "Folders",
        "PercentOfParent", "ModifiedUtc", "Hidden", "Readonly", "Link", "Owner", "Extension",
    ];
    let ids = largest_by_size(result, XLSX_ROW_CAP);
    let mut rows: Vec<Vec<Cell>> = Vec::with_capacity(ids.len());
    for id in ids {
        let Some(node) = result.nodes.get(id) else { continue };
        let parent_size = node
            .parent
            .and_then(|p| result.nodes.get(p))
            .map(|p| p.size)
            .unwrap_or(node.size);
        let percent = if parent_size > 0 {
            (node.size as f64 / parent_size as f64) * 100.0
        } else {
            0.0
        };
        rows.push(vec![
            Cell::Text(node.path.clone()),
            Cell::Text(node.name.clone()),
            Cell::Text(if node.is_dir { "Directory".into() } else { "File".into() }),
            Cell::Int(node.size),
            Cell::Int(node.allocated),
            Cell::Int(node.files),
            Cell::Int(node.folders),
            Cell::Float((percent * 10000.0).round() / 10000.0),
            Cell::Text(epoch_ms_to_utc(node.modified_ms)),
            Cell::Text(node.hidden.to_string()),
            Cell::Text(node.readonly.to_string()),
            Cell::Text(node.is_link.to_string()),
            Cell::Text(node.owner.clone()),
            Cell::Text(node.extension.clone()),
        ]);
    }
    crate::xlsx::workbook("Scan", &headers, &rows)
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
    // Build list of {root, label, total, free} objects. total/free are bytes;
    // 0 means "couldn't be queried" (the UI then hides the capacity bar).
    let drives = enumerate_drives();
    let mut output = String::from("{\"drives\":[");
    for (index, (root, label, total, free)) in drives.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push_str("{\"root\":");
        push_json_string(&mut output, root);
        output.push_str(",\"label\":");
        push_json_string(&mut output, label);
        output.push_str(",\"total\":");
        output.push_str(&total.to_string());
        output.push_str(",\"free\":");
        output.push_str(&free.to_string());
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

/// Returns (root_path, volume_label, total_bytes, free_bytes) for each available
/// drive. total/free are 0 when the volume's capacity couldn't be queried
/// (e.g. an empty CD/removable drive), so callers can treat 0 as "unknown".
fn enumerate_drives() -> Vec<(String, String, u64, u64)> {
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
            // Capacity/free for the used-vs-total bar. Unqueryable volumes (e.g.
            // an empty CD/removable drive) report 0/0 → UI hides the bar.
            let (free, total) =
                crate::preflight::disk_space(std::path::Path::new(&root)).unwrap_or((0, 0));
            result.push((root, format!("{display} ({letter}:)"), total, free));
        }
    }

    #[cfg(not(windows))]
    {
        let (free, total) =
            crate::preflight::disk_space(std::path::Path::new("/")).unwrap_or((0, 0));
        result.push(("/".to_string(), "Root (/)".to_string(), total, free));
        if let Some(home) = env::var_os("HOME") {
            let path = PathBuf::from(home).display().to_string();
            result.push((path.clone(), format!("Home ({})", path), 0, 0));
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
