use std::env;
use std::path::{Path, PathBuf};

use crate::analytics::{
    age_stats, duplicate_candidates, extension_stats, largest_dir_ids, top_file_ids,
};
use crate::cli::{APP_NAME, APP_VERSION};
use crate::io::{default_thread_count, epoch_ms_to_utc, path_to_string};
use crate::model::{AppState, ScanResult};

pub(crate) fn scan_result_to_json(result: &ScanResult) -> String {
    let top_files = top_file_ids(&result.nodes, 100);
    let largest_dirs = largest_dir_ids(&result.nodes, 100);
    let extension_stats = extension_stats(&result.nodes, 80);
    let age_stats = age_stats(&result.nodes, result.scanned_at_ms);
    let duplicate_candidates = duplicate_candidates(&result.nodes, 100);

    let mut output = String::with_capacity(result.nodes.len().saturating_mul(260));
    output.push('{');
    output.push_str("\"app\":");
    push_json_string(&mut output, APP_NAME);
    output.push_str(",\"version\":");
    push_json_string(&mut output, APP_VERSION);
    output.push_str(",\"rootPath\":");
    push_json_string(&mut output, &result.root_path);
    output.push_str(",\"scannedAt\":");
    output.push_str(&result.scanned_at_ms.to_string());
    output.push_str(",\"elapsedMs\":");
    output.push_str(&result.elapsed_ms.to_string());
    output.push_str(",\"threadCount\":");
    output.push_str(&result.thread_count.to_string());
    output.push_str(",\"nodeCount\":");
    output.push_str(&result.nodes.len().to_string());
    output.push_str(",\"errorCount\":");
    output.push_str(&result.errors.len().to_string());

    output.push_str(",\"nodes\":[");
    for (index, node) in result.nodes.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push('{');
        output.push_str("\"id\":");
        output.push_str(&node.id.to_string());
        output.push_str(",\"parent\":");
        match node.parent {
            Some(parent) => output.push_str(&parent.to_string()),
            None => output.push_str("null"),
        }
        output.push_str(",\"name\":");
        push_json_string(&mut output, &node.name);
        output.push_str(",\"path\":");
        push_json_string(&mut output, &node.path);
        output.push_str(",\"dir\":");
        output.push_str(if node.is_dir { "true" } else { "false" });
        output.push_str(",\"link\":");
        output.push_str(if node.is_link { "true" } else { "false" });
        output.push_str(",\"hidden\":");
        output.push_str(if node.hidden { "true" } else { "false" });
        output.push_str(",\"readonly\":");
        output.push_str(if node.readonly { "true" } else { "false" });
        output.push_str(",\"size\":");
        output.push_str(&node.size.to_string());
        output.push_str(",\"allocated\":");
        output.push_str(&node.allocated.to_string());
        output.push_str(",\"files\":");
        output.push_str(&node.files.to_string());
        output.push_str(",\"folders\":");
        output.push_str(&node.folders.to_string());
        output.push_str(",\"modified\":");
        output.push_str(&node.modified_ms.to_string());
        output.push_str(",\"depth\":");
        output.push_str(&node.depth.to_string());
        output.push_str(",\"errors\":");
        output.push_str(&node.errors.to_string());
        output.push_str(",\"extension\":");
        push_json_string(&mut output, &node.extension);
        output.push_str(",\"children\":[");
        for (child_index, child) in node.children.iter().enumerate() {
            if child_index > 0 {
                output.push(',');
            }
            output.push_str(&child.to_string());
        }
        output.push_str("]}");
    }
    output.push(']');

    output.push_str(",\"topFiles\":");
    push_id_array(&mut output, &top_files);
    output.push_str(",\"largestDirs\":");
    push_id_array(&mut output, &largest_dirs);

    output.push_str(",\"extensionStats\":[");
    for (index, stat) in extension_stats.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push('{');
        output.push_str("\"ext\":");
        push_json_string(&mut output, &stat.ext);
        output.push_str(",\"bytes\":");
        output.push_str(&stat.bytes.to_string());
        output.push_str(",\"allocated\":");
        output.push_str(&stat.allocated.to_string());
        output.push_str(",\"files\":");
        output.push_str(&stat.files.to_string());
        output.push('}');
    }
    output.push(']');

    output.push_str(",\"ageStats\":[");
    for (index, stat) in age_stats.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push('{');
        output.push_str("\"label\":");
        push_json_string(&mut output, stat.label);
        output.push_str(",\"bytes\":");
        output.push_str(&stat.bytes.to_string());
        output.push_str(",\"files\":");
        output.push_str(&stat.files.to_string());
        output.push('}');
    }
    output.push(']');

    output.push_str(",\"duplicateCandidates\":[");
    for (index, group) in duplicate_candidates.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push('{');
        output.push_str("\"name\":");
        push_json_string(&mut output, &group.name);
        output.push_str(",\"size\":");
        output.push_str(&group.size.to_string());
        output.push_str(",\"waste\":");
        output.push_str(&group.waste.to_string());
        output.push_str(",\"ids\":");
        push_id_array(&mut output, &group.ids);
        output.push('}');
    }
    output.push(']');

    output.push_str(",\"scanErrors\":[");
    for (index, error) in result.errors.iter().take(500).enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push('{');
        output.push_str("\"path\":");
        push_json_string(&mut output, &error.path);
        output.push_str(",\"message\":");
        push_json_string(&mut output, &error.message);
        output.push('}');
    }
    output.push(']');

    output.push('}');
    output
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
    let mut roots = Vec::new();

    #[cfg(windows)]
    {
        for letter in b'A'..=b'Z' {
            let root = format!("{}:\\", letter as char);
            if Path::new(&root).exists() {
                roots.push(root);
            }
        }
    }

    #[cfg(not(windows))]
    {
        roots.push("/".to_string());
        if let Some(home) = env::var_os("HOME") {
            roots.push(PathBuf::from(home).display().to_string());
        }
    }

    if let Some(profile) = env::var_os("USERPROFILE") {
        let profile = PathBuf::from(profile).display().to_string();
        if !roots.iter().any(|root| root == &profile) {
            roots.push(profile);
        }
    }

    let mut output = String::from("{\"roots\":[");
    for (index, root) in roots.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        push_json_string(&mut output, root);
    }
    output.push_str("]}");
    output
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
