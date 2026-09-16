//! restic, read-only.
//!
//! A scan says what is taking up space; it does not say what you would lose.
//! This lists the snapshots in a repository, what the repository costs, and
//! whether a given folder is covered by any snapshot. Nothing is backed up,
//! forgotten or pruned from here.
//!
//! The repository password is passed to restic through the environment of the
//! child process and is never written to disk by FileTree.

use crate::tools;
use serde::Serialize;
use serde_json::{Value, json};
use std::path::PathBuf;

#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub id: String,
    pub time: String,
    pub hostname: String,
    pub paths: Vec<String>,
    pub tags: Vec<String>,
}

fn restic(configured: &str) -> Result<PathBuf, String> {
    let mut common = tools::program_files("restic\\restic.exe");
    common.extend(tools::program_files("Programs\\restic\\restic.exe"));
    tools::locate(configured, "restic.exe", &common).ok_or_else(|| {
        "restic was not found. Install it, or set the path to restic.exe in this panel.".to_string()
    })
}

/// Environment for a restic run: the repository and its password, nothing else.
fn env(repo: &str, password: &str) -> Vec<(String, String)> {
    vec![
        ("RESTIC_REPOSITORY".to_string(), repo.trim().to_string()),
        ("RESTIC_PASSWORD".to_string(), password.to_string()),
    ]
}

pub(crate) fn parse_snapshots(output: &str) -> Result<Vec<Snapshot>, String> {
    let rows: Vec<Value> = serde_json::from_str(output)
        .map_err(|_| "restic did not answer with a snapshot list".to_string())?;
    Ok(rows
        .iter()
        .map(|row| Snapshot {
            id: row["short_id"]
                .as_str()
                .or_else(|| row["id"].as_str())
                .unwrap_or_default()
                .to_string(),
            time: row["time"].as_str().unwrap_or_default().to_string(),
            hostname: row["hostname"].as_str().unwrap_or_default().to_string(),
            paths: strings(&row["paths"]),
            tags: strings(&row["tags"]),
        })
        .collect())
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Compare paths the way Windows does: case-insensitively, and with either
/// separator, because a repository written on one machine is read on another.
fn normalize(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// Snapshots whose backed-up paths contain `folder`.
pub(crate) fn covering<'a>(snapshots: &'a [Snapshot], folder: &str) -> Vec<&'a Snapshot> {
    let wanted = normalize(folder);
    snapshots
        .iter()
        .filter(|snapshot| {
            snapshot.paths.iter().any(|path| {
                let covered = normalize(path);
                wanted == covered || wanted.starts_with(&format!("{covered}/"))
            })
        })
        .collect()
}

#[tauri::command]
pub(crate) async fn restic_snapshots(
    exe: String,
    repo: String,
    password: String,
) -> Result<Value, String> {
    if repo.trim().is_empty() {
        return Err("Enter the repository location".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let path = restic(&exe)?;
        let output = tools::run(
            &path,
            &["snapshots".into(), "--json".into()],
            &env(&repo, &password),
        )?;
        let snapshots = parse_snapshots(&output)?;
        Ok(json!({ "snapshots": snapshots, "restic": path.display().to_string() }))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Repository size. `--mode raw-data` is what the repository actually occupies,
/// as opposed to the size of the files it could restore.
#[tauri::command]
pub(crate) async fn restic_stats(
    exe: String,
    repo: String,
    password: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = restic(&exe)?;
        let output = tools::run(
            &path,
            &[
                "stats".into(),
                "--json".into(),
                "--mode".into(),
                "raw-data".into(),
            ],
            &env(&repo, &password),
        )?;
        serde_json::from_str::<Value>(&output)
            .map_err(|_| "restic did not answer with JSON".to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Is this folder inside anything that has been backed up?
#[tauri::command]
pub(crate) async fn restic_coverage(
    exe: String,
    repo: String,
    password: String,
    folder: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = restic(&exe)?;
        let output = tools::run(
            &path,
            &["snapshots".into(), "--json".into()],
            &env(&repo, &password),
        )?;
        let snapshots = parse_snapshots(&output)?;
        let covering = covering(&snapshots, &folder);
        Ok(json!({
            "covered": !covering.is_empty(),
            "snapshots": covering,
            "latest": covering.iter().map(|item| item.time.as_str()).max(),
            "total": snapshots.len(),
        }))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const SNAPSHOTS: &str = r#"[
      {"time":"2026-09-01T02:00:00Z","hostname":"desk","short_id":"a1b2c3d4",
       "id":"a1b2c3d4e5f6","paths":["D:\\Media"],"tags":["nightly"]},
      {"time":"2026-09-14T02:00:00Z","hostname":"desk","short_id":"99887766",
       "id":"998877665544","paths":["D:\\Projects","E:\\Backups"]}]"#;

    #[test]
    fn reads_the_snapshot_list() {
        let snapshots = parse_snapshots(SNAPSHOTS).unwrap();
        assert_eq!(snapshots.len(), 2);
        assert_eq!(snapshots[0].id, "a1b2c3d4");
        assert_eq!(snapshots[0].paths, vec!["D:\\Media"]);
        assert_eq!(snapshots[0].tags, vec!["nightly"]);
        // A snapshot without tags is not a parse failure.
        assert!(snapshots[1].tags.is_empty());
    }

    #[test]
    fn finds_the_snapshots_covering_a_folder() {
        let snapshots = parse_snapshots(SNAPSHOTS).unwrap();
        // The folder itself, and anything under it, count as covered.
        assert_eq!(covering(&snapshots, "D:\\Media").len(), 1);
        assert_eq!(covering(&snapshots, "d:/media/videos").len(), 1);
        assert_eq!(covering(&snapshots, "D:\\Media2").len(), 0);
        assert_eq!(covering(&snapshots, "C:\\Windows").len(), 0);
    }

    #[test]
    fn refuses_output_that_is_not_a_snapshot_list() {
        assert!(parse_snapshots("Fatal: wrong password").is_err());
    }
}
