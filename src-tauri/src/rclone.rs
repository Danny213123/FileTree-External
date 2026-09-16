//! rclone, read-only.
//!
//! The question this answers is "is this folder actually somewhere else?", so
//! it lists the remotes rclone already knows, what they cost, and which local
//! files have no copy on the remote. It never writes: no copy, sync or delete
//! is invoked from here, and rclone's own config is only read.

use crate::tools;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Cap on a remote listing, so a huge bucket cannot exhaust memory.
const MAX_ENTRIES: usize = 200_000;

#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Remote {
    pub name: String,
    pub kind: String,
}

#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Missing {
    /// Path relative to the local folder, as rclone would name it remotely.
    pub relative: String,
    pub path: String,
    pub size: u64,
    /// Present remotely but a different size, rather than absent altogether.
    pub differs: bool,
}

fn rclone(configured: &str) -> Result<PathBuf, String> {
    tools::locate(
        configured,
        "rclone.exe",
        &tools::program_files("rclone\\rclone.exe"),
    )
    .ok_or_else(|| {
        "rclone was not found. Install it, or set the path to rclone.exe in this panel.".to_string()
    })
}

/// `rclone listremotes --long` prints "name: type", one per line.
pub(crate) fn parse_remotes(output: &str) -> Vec<Remote> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let (name, kind) = line.split_once(':').unwrap_or((line, ""));
            Some(Remote {
                name: name.trim().to_string(),
                kind: kind.trim().to_string(),
            })
        })
        .collect()
}

/// Files in an `rclone lsjson -R` listing, as relative path → size.
pub(crate) fn parse_listing(output: &str) -> Result<HashMap<String, u64>, String> {
    let rows: Vec<Value> = serde_json::from_str(output)
        .map_err(|_| "rclone did not answer with a JSON listing".to_string())?;
    Ok(rows
        .iter()
        .take(MAX_ENTRIES)
        .filter(|row| row["IsDir"].as_bool() != Some(true))
        .filter_map(|row| {
            let path = row["Path"].as_str()?.replace('\\', "/");
            Some((path.to_lowercase(), row["Size"].as_u64().unwrap_or(0)))
        })
        .collect())
}

/// Local files with no counterpart on the remote, largest first.
///
/// Size is the only comparison: rclone's own hashes would be authoritative but
/// cost a full re-read of every local file, and this panel is meant to be the
/// quick answer, not the audit.
pub(crate) fn compare(local: &[(String, u64)], remote: &HashMap<String, u64>) -> Vec<Missing> {
    let mut missing: Vec<Missing> = local
        .iter()
        .filter_map(|(relative, size)| {
            let key = relative.to_lowercase();
            match remote.get(&key) {
                Some(remote_size) if remote_size == size => None,
                found => Some(Missing {
                    relative: relative.clone(),
                    path: relative.clone(),
                    size: *size,
                    differs: found.is_some(),
                }),
            }
        })
        .collect();
    missing.sort_by(|a, b| b.size.cmp(&a.size));
    missing
}

/// Every file under `root`, as (path relative to root, size).
fn walk_local(root: &Path) -> Result<Vec<(String, u64)>, String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).map_err(|error| error.to_string())?;
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file()
                && let Ok(relative) = path.strip_prefix(root)
            {
                out.push((relative.to_string_lossy().replace('\\', "/"), meta.len()));
            }
            if out.len() >= MAX_ENTRIES {
                return Ok(out);
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub(crate) async fn rclone_remotes(exe: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = rclone(&exe)?;
        let output = tools::run(&path, &["listremotes".into(), "--long".into()], &[])?;
        Ok(json!({ "remotes": parse_remotes(&output), "rclone": path.display().to_string() }))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Quota for one remote. Many backends do not implement it, which is reported
/// as-is rather than being turned into zeroes that look like an empty remote.
#[tauri::command]
pub(crate) async fn rclone_about(exe: String, remote: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = rclone(&exe)?;
        let target = format!("{}:", remote.trim_end_matches(':'));
        match tools::run(&path, &["about".into(), target, "--json".into()], &[]) {
            Ok(output) => serde_json::from_str::<Value>(&output)
                .map_err(|_| "rclone did not answer with JSON".to_string()),
            Err(error) => Ok(json!({ "unsupported": true, "reason": error })),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn rclone_list(
    exe: String,
    remote: String,
    path: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rclone = rclone(&exe)?;
        let target = format!(
            "{}:{}",
            remote.trim_end_matches(':'),
            path.trim_start_matches('/')
        );
        let output = tools::run(
            &rclone,
            &["lsjson".into(), target, "--max-depth".into(), "1".into()],
            &[],
        )?;
        let rows: Value = serde_json::from_str(&output)
            .map_err(|_| "rclone did not answer with a JSON listing".to_string())?;
        Ok(rows)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Which files under a local folder have no copy on the remote.
#[tauri::command]
pub(crate) async fn rclone_coverage(
    exe: String,
    remote: String,
    path: String,
    local: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rclone = rclone(&exe)?;
        let root = PathBuf::from(&local);
        if !root.is_dir() {
            return Err(format!("{local} is not a folder"));
        }
        let target = format!(
            "{}:{}",
            remote.trim_end_matches(':'),
            path.trim_start_matches('/')
        );
        let listing = tools::run(
            &rclone,
            &["lsjson".into(), target, "-R".into(), "--files-only".into()],
            &[],
        )?;
        let remote_files = parse_listing(&listing)?;
        let local_files = walk_local(&root)?;
        let missing = compare(&local_files, &remote_files);
        let missing_bytes: u64 = missing.iter().map(|item| item.size).sum();
        Ok(json!({
            "localFiles": local_files.len(),
            "remoteFiles": remote_files.len(),
            "missing": missing.iter().take(500).collect::<Vec<_>>(),
            "missingCount": missing.len(),
            "missingBytes": missing_bytes,
        }))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_remote_list() {
        let remotes = parse_remotes("gdrive: drive\r\nbackup: s3\r\n\r\nbare\r\n");
        assert_eq!(
            remotes,
            vec![
                Remote {
                    name: "gdrive".into(),
                    kind: "drive".into()
                },
                Remote {
                    name: "backup".into(),
                    kind: "s3".into()
                },
                Remote {
                    name: "bare".into(),
                    kind: String::new()
                },
            ]
        );
    }

    #[test]
    fn reads_a_recursive_listing_and_ignores_directories() {
        let listing = r#"[
          {"Path":"Photos/one.jpg","Name":"one.jpg","Size":120,"IsDir":false},
          {"Path":"Photos","Name":"Photos","Size":-1,"IsDir":true},
          {"Path":"two.mp4","Name":"two.mp4","Size":4096,"IsDir":false}]"#;
        let files = parse_listing(listing).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files.get("photos/one.jpg"), Some(&120));
    }

    #[test]
    fn finds_what_the_remote_does_not_have() {
        let local = vec![
            ("Photos/one.jpg".to_string(), 120),
            ("two.mp4".to_string(), 4096),
            ("big.iso".to_string(), 9_000),
        ];
        let remote = HashMap::from([
            ("photos/one.jpg".to_string(), 120),
            ("two.mp4".to_string(), 8),
        ]);
        let missing = compare(&local, &remote);
        // Largest first, and a size mismatch counts as not backed up.
        assert_eq!(missing.len(), 2);
        assert_eq!(missing[0].relative, "big.iso");
        assert!(!missing[0].differs);
        assert_eq!(missing[1].relative, "two.mp4");
        assert!(missing[1].differs);
    }

    #[test]
    fn refuses_output_that_is_not_a_listing() {
        assert!(parse_listing("rclone: command not found").is_err());
    }
}
