//! Explorer file operations for the desktop shell: rename, recycle or delete,
//! new folder, and Recycle Bin restore (used by undo). The React client used to
//! reach these through the removed HTTP server. Every path is checked against
//! the scanned roots before anything touches the disk.
use super::{V2Store, require_authorized_path, require_authorized_paths};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;

/// A single path segment Windows accepts: no separators, reserved characters,
/// reserved device names, or trailing dot/space.
fn valid_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0');
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.len() > 255
        || name.ends_with(' ')
        || name.ends_with('.')
        || reserved
        || name.chars().any(|c| c < ' ' || "<>:\"/\\|?*".contains(c))
    {
        return Err("Choose a valid name without folders or special characters".to_string());
    }
    Ok(name.to_string())
}

fn parent_of(path: &str) -> Result<String, String> {
    Path::new(path)
        .parent()
        .map(|parent| parent.to_string_lossy().into_owned())
        .filter(|parent| !parent.is_empty())
        .ok_or_else(|| "This location has no parent folder".to_string())
}

/// Rename a file or folder in place. Returns the new full path.
#[tauri::command]
pub(crate) async fn rename_path(
    state: State<'_, Arc<V2Store>>,
    path: String,
    new_name: String,
) -> Result<String, String> {
    require_authorized_path(&state, &path)?;
    let name = valid_name(&new_name)?;
    tauri::async_runtime::spawn_blocking(move || {
        let source = PathBuf::from(&path);
        let target = source
            .parent()
            .ok_or_else(|| "A drive root cannot be renamed".to_string())?
            .join(&name);
        // A case-only rename targets the same item, so it is not a collision.
        let same_item = target
            .to_string_lossy()
            .eq_ignore_ascii_case(&source.to_string_lossy());
        if !same_item && std::fs::symlink_metadata(&target).is_ok() {
            return Err(format!(
                "\u{201C}{name}\u{201D} already exists in this folder"
            ));
        }
        std::fs::rename(&source, &target).map_err(|error| error.to_string())?;
        Ok(target.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| format!("Rename worker failed: {error}"))?
}

#[derive(Serialize)]
pub(crate) struct DeleteFailure {
    path: String,
    error: String,
}

#[derive(Serialize)]
pub(crate) struct DeleteOutcome {
    deleted: Vec<String>,
    failed: Vec<DeleteFailure>,
}

/// Send items to the Recycle Bin, or delete them permanently when asked.
#[tauri::command]
pub(crate) async fn delete_paths(
    state: State<'_, Arc<V2Store>>,
    paths: Vec<String>,
    permanent: bool,
) -> Result<DeleteOutcome, String> {
    if paths.is_empty() || paths.len() > 10_000 {
        return Err("Select between 1 and 10,000 items to delete".to_string());
    }
    require_authorized_paths(&state, &paths)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut outcome = DeleteOutcome {
            deleted: Vec::new(),
            failed: Vec::new(),
        };
        for path in paths {
            match filetree_core::delete_path(&path, permanent) {
                Ok(()) => outcome.deleted.push(path),
                Err(error) => outcome.failed.push(DeleteFailure { path, error }),
            }
        }
        outcome
    })
    .await
    .map_err(|error| format!("Delete worker failed: {error}"))
}

/// Create one new folder inside a scanned folder.
#[tauri::command]
pub(crate) async fn create_folder(
    state: State<'_, Arc<V2Store>>,
    path: String,
) -> Result<(), String> {
    let parent = parent_of(&path)?;
    require_authorized_path(&state, &parent)?;
    let name = valid_name(
        &Path::new(&path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir(Path::new(&parent).join(name)).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("New folder worker failed: {error}"))?
}

/// Restore recycled items to their original paths (undo of a recycle).
/// Returns the paths that are back in place.
#[tauri::command]
pub(crate) async fn restore_recycled(
    state: State<'_, Arc<V2Store>>,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    if paths.is_empty() || paths.len() > 1_000 {
        return Err("Select between 1 and 1,000 items to restore".to_string());
    }
    for path in &paths {
        require_authorized_path(&state, &parent_of(path)?)?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .filter(|path| restore_one(Path::new(path)).is_ok())
            .collect()
    })
    .await
    .map_err(|error| format!("Restore worker failed: {error}"))
}

/// Find the newest Recycle Bin entry deleted from `original` and restore it
/// with the shell's own "undelete" verb, then confirm it is back.
#[cfg(windows)]
fn restore_one(original: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    if std::fs::symlink_metadata(original).is_ok() {
        return Err("Something already exists at the original location".to_string());
    }
    let parent = original
        .parent()
        .ok_or("No parent folder")?
        .to_string_lossy()
        .into_owned();
    let name = original
        .file_name()
        .ok_or("No file name")?
        .to_string_lossy()
        .into_owned();
    // Shell display names may hide extensions, so an exact name wins and a
    // stem-only match is used only when it is unambiguous.
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$parent = $env:FT_PARENT.TrimEnd('\')
$name = $env:FT_NAME
$stem = [IO.Path]::GetFileNameWithoutExtension($name)
$bin = (New-Object -ComObject Shell.Application).NameSpace(10)
$here = @($bin.Items() | Where-Object { ([string]$_.ExtendedProperty('System.Recycle.DeletedFrom')).TrimEnd('\') -ieq $parent })
$hits = @($here | Where-Object { [string]$_.Name -ieq $name })
if ($hits.Count -eq 0) { $hits = @($here | Where-Object { [string]$_.Name -ieq $stem }); if ($hits.Count -ne 1) { exit 3 } }
$hit = $hits | Sort-Object { $_.ExtendedProperty('System.Recycle.DateDeleted') } -Descending | Select-Object -First 1
$hit.InvokeVerb('undelete')
"#;
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            SCRIPT,
        ])
        .env("FT_PARENT", &parent)
        .env("FT_NAME", &name)
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("Not found in the Recycle Bin".to_string());
    }
    // The verb completes asynchronously; wait briefly for the item to reappear.
    for _ in 0..30 {
        if std::fs::symlink_metadata(original).is_ok() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err("The Recycle Bin did not restore the item".to_string())
}

#[cfg(not(windows))]
fn restore_one(_original: &Path) -> Result<(), String> {
    Err("Recycle Bin restore is only available on Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::valid_name;

    #[test]
    fn rejects_unsafe_names_and_keeps_ordinary_ones() {
        assert_eq!(valid_name("  Holiday photos ").unwrap(), "Holiday photos");
        assert_eq!(valid_name("report.v2.pdf").unwrap(), "report.v2.pdf");
        for bad in [
            "",
            ".",
            "..",
            "a/b",
            "a\\b",
            "what?",
            "CON",
            "com1.txt",
            "trailing.",
            "x\u{1}y",
        ] {
            assert!(valid_name(bad).is_err(), "{bad:?} should be rejected");
        }
        assert!(valid_name("COM0").is_ok());
    }
}
