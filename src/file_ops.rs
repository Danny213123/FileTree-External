use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveConflict {
    pub src: String,
    pub dest: String,
    pub name: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveItemsResult {
    pub ok: bool,
    pub error: Option<String>,
    pub moved: Vec<String>,
    pub already_there: Vec<String>,
    pub conflicts: Vec<MoveConflict>,
    pub skipped: Vec<String>,
    pub errors: Vec<String>,
}

pub fn move_items(
    sources: Vec<String>,
    destination: String,
    conflict: Option<String>,
) -> MoveItemsResult {
    let mut result = MoveItemsResult::default();
    let destination_path = PathBuf::from(&destination);
    if !destination_path.is_dir() {
        return failed_result(format!("Destination is not a folder: {destination}"));
    }

    let conflict = conflict.as_deref();
    if !matches!(conflict, None | Some("skip" | "replace" | "keep-both")) {
        return failed_result("Unknown move conflict action".to_string());
    }

    for source_text in sources {
        let source = PathBuf::from(&source_text);
        let Some(name) = source.file_name() else {
            result
                .errors
                .push(format!("Source has no file name: {source_text}"));
            continue;
        };
        if fs::symlink_metadata(&source).is_err() {
            result
                .errors
                .push(format!("Source no longer exists: {source_text}"));
            continue;
        }

        let mut target = destination_path.join(name);
        if same_path(&source, &target) {
            result.already_there.push(source_text);
            continue;
        }
        if source.is_dir() && path_is_within(&destination_path, &source) {
            result.errors.push(format!(
                "Cannot move a folder into itself: {}",
                source.display()
            ));
            continue;
        }

        if fs::symlink_metadata(&target).is_ok() {
            match conflict {
                None => {
                    result.conflicts.push(MoveConflict {
                        src: source_text,
                        dest: target.to_string_lossy().into_owned(),
                        name: name.to_string_lossy().into_owned(),
                    });
                    continue;
                }
                Some("skip") => {
                    result.skipped.push(source_text);
                    continue;
                }
                Some("keep-both") => target = unique_target(&target),
                Some("replace") => {
                    if let Err(error) = crate::recycle::recycle_path(&target) {
                        result
                            .errors
                            .push(format!("Could not replace {}: {error}", target.display()));
                        continue;
                    }
                }
                _ => unreachable!(),
            }
        }

        match move_path(&source, &target) {
            Ok(())
                if fs::symlink_metadata(&source).is_err()
                    && fs::symlink_metadata(&target).is_ok() =>
            {
                result.moved.push(source_text);
            }
            Ok(()) => result.errors.push(format!(
                "Move could not be verified: {} -> {}",
                source.display(),
                target.display()
            )),
            Err(error) => result.errors.push(format!(
                "Could not move {} to {}: {error}",
                source.display(),
                target.display()
            )),
        }
    }

    result.ok = result.errors.is_empty();
    if !result.ok {
        result.error = Some(result.errors.join("; "));
    }
    result
}

fn failed_result(error: String) -> MoveItemsResult {
    MoveItemsResult {
        error: Some(error.clone()),
        errors: vec![error],
        ..MoveItemsResult::default()
    }
}

fn same_path(left: &Path, right: &Path) -> bool {
    normalized_path(left) == normalized_path(right)
}

fn path_is_within(candidate: &Path, parent: &Path) -> bool {
    let candidate = normalized_path(candidate);
    let parent = normalized_path(parent);
    candidate == parent
        || candidate
            .strip_prefix(&parent)
            .is_some_and(|suffix| suffix.starts_with('/') || suffix.starts_with('\\'))
}

fn normalized_path(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn unique_target(target: &Path) -> PathBuf {
    let parent = target.parent().unwrap_or_else(|| Path::new(""));
    let stem = target
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("item");
    let extension = target.extension().and_then(|value| value.to_str());
    for index in 2..100_000 {
        let name = match extension {
            Some(extension) => format!("{stem} ({index}).{extension}"),
            None => format!("{stem} ({index})"),
        };
        let candidate = parent.join(name);
        if fs::symlink_metadata(&candidate).is_err() {
            return candidate;
        }
    }
    target.with_file_name(format!("{stem} (moved)"))
}

fn move_path(source: &Path, target: &Path) -> io::Result<()> {
    match fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(error) if error.raw_os_error() == Some(17) => move_across_volumes(source, target),
        Err(error) => Err(error),
    }
}

fn move_across_volumes(source: &Path, target: &Path) -> io::Result<()> {
    static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Target has no parent"))?;
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("item");
    let temporary = parent.join(format!(
        ".{name}.filetree-move-{}-{}",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    ));

    if let Err(error) = copy_path(source, &temporary) {
        let _ = remove_path(&temporary);
        return Err(error);
    }
    if let Err(error) = fs::rename(&temporary, target) {
        let _ = remove_path(&temporary);
        return Err(error);
    }
    remove_path(source)
}

fn copy_path(source: &Path, target: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Cross-volume moves of symbolic links are not supported",
        ));
    }
    if metadata.is_dir() {
        fs::create_dir(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_path(&entry.path(), &target.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(source, target).map(|_| ())
    }
}

fn remove_path(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(name: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let root = std::env::temp_dir().join(format!(
            "filetree-file-ops-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn detects_conflicts_then_moves_with_keep_both() {
        let root = test_root("conflict");
        let source_dir = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(&source_dir).unwrap();
        fs::create_dir_all(&destination).unwrap();
        let source = source_dir.join("video.mp4");
        fs::write(&source, b"new").unwrap();
        fs::write(destination.join("video.mp4"), b"old").unwrap();

        let detected = move_items(
            vec![source.to_string_lossy().into_owned()],
            destination.to_string_lossy().into_owned(),
            None,
        );
        assert!(detected.ok);
        assert_eq!(detected.conflicts.len(), 1);
        assert!(source.exists());

        let moved = move_items(
            vec![source.to_string_lossy().into_owned()],
            destination.to_string_lossy().into_owned(),
            Some("keep-both".to_string()),
        );
        assert!(moved.ok, "{:?}", moved.errors);
        assert!(!source.exists());
        assert!(destination.join("video (2).mp4").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_moving_folder_into_its_descendant() {
        let root = test_root("descendant");
        let source = root.join("source");
        let child = source.join("child");
        fs::create_dir_all(&child).unwrap();
        let moved = move_items(
            vec![source.to_string_lossy().into_owned()],
            child.to_string_lossy().into_owned(),
            None,
        );
        assert!(!moved.ok);
        assert!(source.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
