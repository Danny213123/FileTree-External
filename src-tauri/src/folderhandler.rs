//! Making FileTree Explorer the app Windows opens folders with.
//!
//! This lives in FileTree rather than in the explorer because FileTree is where
//! settings live; the explorer is a lean window that browses a folder.
//!
//! Everything is written under `HKCU\Software\Classes`: no administrator, no
//! change for other users, and the machine-wide defaults are never touched, so
//! turning it off deletes our keys and Windows falls straight back to them.
//!
//! What it changes, so the setting can say so honestly: folders opened from the
//! desktop, from a dialog, or by another app go to FileTree Explorer. Windows
//! still routes Win+E, the taskbar pin and File Explorer's own in-window
//! navigation to File Explorer, whatever is registered.

use serde_json::{Value, json};

/// Directory is a filesystem folder, Drive a volume root, and Folder the
/// shell's umbrella class that some callers use instead of Directory.
const CLASSES: [&str; 3] = ["Directory", "Drive", "Folder"];

fn command_for(exe: &str) -> String {
    format!("\"{exe}\" \"%1\"")
}

fn verb_key(class: &str) -> String {
    format!("Software\\Classes\\{class}\\shell\\open")
}

#[cfg(windows)]
fn current_command(class: &str) -> Option<String> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(format!("{}\\command", verb_key(class)))
        .ok()
        .and_then(|key| key.get_value::<String, _>("").ok())
}

#[cfg(not(windows))]
fn current_command(_class: &str) -> Option<String> {
    None
}

/// Whether folders currently open with `exe`, and what holds the association.
#[tauri::command]
pub(crate) async fn folder_handler_status(exe: String) -> Value {
    let wanted = command_for(&exe);
    let registered: Vec<Option<String>> =
        CLASSES.iter().map(|class| current_command(class)).collect();
    let enabled = !exe.is_empty()
        && registered
            .iter()
            .all(|value| value.as_deref() == Some(wanted.as_str()));
    let other = registered
        .iter()
        .flatten()
        .find(|value| value.as_str() != wanted)
        .cloned();
    json!({ "enabled": enabled, "conflicting": other, "supported": cfg!(windows) })
}

#[cfg(windows)]
#[tauri::command]
pub(crate) async fn set_folder_handler(exe: String, enabled: bool) -> Result<Value, String> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_ALL_ACCESS};

    if enabled && !std::path::Path::new(&exe).is_file() {
        return Err(format!("{exe} is not there"));
    }
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    for class in CLASSES {
        let verb = verb_key(class);
        if enabled {
            let (command, _) = hkcu
                .create_subkey(format!("{verb}\\command"))
                .map_err(|error| format!("{class}: {error}"))?;
            command
                .set_value("", &command_for(&exe))
                .map_err(|error| format!("{class}: {error}"))?;
            // Windows reaches Explorer through a COM delegate on this key. An
            // empty DelegateExecute neutralizes the inherited one; without it
            // the shell can hand the folder to Explorer and ignore the command.
            command
                .set_value("DelegateExecute", &"")
                .map_err(|error| format!("{class}: {error}"))?;
        } else if hkcu.open_subkey_with_flags(&verb, KEY_ALL_ACCESS).is_ok() {
            hkcu.delete_subkey_all(&verb)
                .map_err(|error| format!("{class}: {error}"))?;
        }
    }
    Ok(folder_handler_status(exe).await)
}

#[cfg(not(windows))]
#[tauri::command]
pub(crate) async fn set_folder_handler(_exe: String, _enabled: bool) -> Result<Value, String> {
    Err("Folder associations are a Windows feature".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_the_command_so_a_path_with_spaces_survives() {
        assert_eq!(
            command_for("C:\\Program Files\\FileTree Explorer\\FileTreeExplorer.exe"),
            "\"C:\\Program Files\\FileTree Explorer\\FileTreeExplorer.exe\" \"%1\""
        );
    }

    #[test]
    fn writes_only_under_the_per_user_classes_root() {
        for class in CLASSES {
            let key = verb_key(class);
            assert!(
                key.starts_with("Software\\Classes\\"),
                "{key} escapes HKCU classes"
            );
            assert!(key.ends_with("\\shell\\open"));
        }
    }

    #[test]
    fn an_empty_executable_is_never_reported_as_enabled() {
        let status = tauri::async_runtime::block_on(folder_handler_status(String::new()));
        assert_eq!(status["enabled"], false);
    }
}
