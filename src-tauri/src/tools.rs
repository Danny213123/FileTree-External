//! Shared plumbing for plugins that drive a command-line tool.
//!
//! Every one of them needs the same three things: find the executable without
//! making the user type a path, run it without flashing a console window, and
//! turn a failure into a sentence worth showing. None of them should reinvent
//! that, and none of them should leave a console window on screen.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Output of a tool run that exited non-zero, trimmed to something printable.
const MAX_ERROR: usize = 400;

pub(crate) fn command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
}

/// Run a tool and return its stdout.
///
/// A non-zero exit carries the tool's own complaint: these are other people's
/// programs, and their message about a bad remote or a wrong password is more
/// useful than anything this side could invent.
pub(crate) fn run(
    program: &Path,
    args: &[String],
    env: &[(String, String)],
) -> Result<String, String> {
    let mut command = command(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in env {
        command.env(key, value);
    }
    let output = command.output().map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => format!("{} was not found", program.display()),
        _ => error.to_string(),
    })?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    let complaint = String::from_utf8_lossy(&output.stderr);
    let complaint = complaint.trim();
    let complaint = if complaint.is_empty() {
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    } else {
        complaint.to_string()
    };
    let mut message = complaint
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(4)
        .collect::<Vec<_>>()
        .join("; ");
    message.truncate(MAX_ERROR);
    Err(if message.is_empty() {
        format!(
            "{} exited with {}",
            program.display(),
            output.status.code().unwrap_or(-1)
        )
    } else {
        message
    })
}

/// Find an executable: the path the user gave, then `PATH`, then the usual
/// install folders. Returns `None` rather than guessing a path that is not there.
pub(crate) fn locate(configured: &str, exe: &str, common: &[PathBuf]) -> Option<PathBuf> {
    let configured = configured.trim();
    if !configured.is_empty() {
        let path = PathBuf::from(configured);
        // A folder is as good as the exe inside it: people paste either.
        let candidate = if path.is_dir() { path.join(exe) } else { path };
        return candidate.is_file().then_some(candidate);
    }
    if let Some(found) = on_path(exe) {
        return Some(found);
    }
    common.iter().find(|path| path.is_file()).cloned()
}

fn on_path(exe: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(exe))
        .find(|candidate| candidate.is_file())
}

/// Program Files and Program Files (x86) joined with `tail`.
pub(crate) fn program_files(tail: &str) -> Vec<PathBuf> {
    ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
        .iter()
        .filter_map(std::env::var_os)
        .map(|root| PathBuf::from(root).join(tail))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_a_configured_path_and_accepts_its_folder() {
        let dir = std::env::temp_dir().join("filetree-tools-test");
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("pretend-tool.exe");
        std::fs::write(&exe, b"").unwrap();

        assert_eq!(
            locate(exe.to_str().unwrap(), "pretend-tool.exe", &[]),
            Some(exe.clone())
        );
        assert_eq!(
            locate(dir.to_str().unwrap(), "pretend-tool.exe", &[]),
            Some(exe.clone())
        );
        // A configured path that does not exist is a miss, never a fallback.
        assert_eq!(locate("Z:\\nope\\tool.exe", "pretend-tool.exe", &[]), None);
        std::fs::remove_file(&exe).ok();
    }

    #[test]
    fn falls_back_to_the_common_locations() {
        let dir = std::env::temp_dir().join("filetree-tools-test-2");
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("elsewhere.exe");
        std::fs::write(&exe, b"").unwrap();
        assert_eq!(
            locate(
                "",
                "definitely-not-on-path-12345.exe",
                std::slice::from_ref(&exe)
            ),
            Some(exe.clone())
        );
        std::fs::remove_file(&exe).ok();
    }
}
