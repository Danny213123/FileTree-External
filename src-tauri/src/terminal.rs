use filetree_core::v2::V2Store;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::State;
use tauri::ipc::Channel;

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

pub(crate) struct TerminalRegistry {
    next_id: AtomicU32,
    sessions: Mutex<HashMap<u32, TerminalSession>>,
}

impl Default for TerminalRegistry {
    fn default() -> Self {
        Self {
            next_id: AtomicU32::new(1),
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

impl TerminalRegistry {
    pub(crate) fn kill_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for session in sessions.values_mut() {
                let _ = session.killer.kill();
            }
            sessions.clear();
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalProfile {
    id: String,
    label: String,
}

struct LaunchProfile {
    id: &'static str,
    label: &'static str,
    program: PathBuf,
    args: Vec<&'static str>,
}

fn find_on_path(executable: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|directory| directory.join(executable))
            .find(|candidate| candidate.is_file())
    })
}

fn launch_profiles() -> Vec<LaunchProfile> {
    let system_root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let system32 = system_root.join("System32");
    let powershell = system32
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let mut profiles = vec![LaunchProfile {
        id: "powershell",
        label: "PowerShell",
        program: if powershell.is_file() {
            powershell
        } else {
            PathBuf::from("powershell.exe")
        },
        args: vec!["-NoLogo"],
    }];
    if let Some(program) = find_on_path("pwsh.exe") {
        profiles.push(LaunchProfile {
            id: "pwsh",
            label: "PowerShell 7",
            program,
            args: vec!["-NoLogo"],
        });
    }
    let command_prompt = system32.join("cmd.exe");
    profiles.push(LaunchProfile {
        id: "cmd",
        label: "Command Prompt",
        program: if command_prompt.is_file() {
            command_prompt
        } else {
            PathBuf::from("cmd.exe")
        },
        args: Vec::new(),
    });
    let program_files = std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    let program_files_x86 = std::env::var_os("ProgramFiles(x86)")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files (x86)"));
    if let Some(program) = [program_files, program_files_x86]
        .into_iter()
        .map(|root| root.join("Git").join("bin").join("bash.exe"))
        .find(|candidate| candidate.is_file())
    {
        profiles.push(LaunchProfile {
            id: "git-bash",
            label: "Git Bash",
            program,
            args: vec!["-i", "-l"],
        });
    }
    let wsl = system32.join("wsl.exe");
    if wsl.is_file() {
        profiles.push(LaunchProfile {
            id: "wsl",
            label: "WSL",
            program: wsl,
            args: Vec::new(),
        });
    }
    profiles
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalSpawnResult {
    id: u32,
    title: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum TerminalEvent {
    Data { id: u32, data: Vec<u8> },
    Exit { id: u32, code: i32 },
}

#[tauri::command]
pub(crate) fn terminal_profiles() -> Vec<TerminalProfile> {
    launch_profiles()
        .into_iter()
        .map(|profile| TerminalProfile {
            id: profile.id.to_string(),
            label: profile.label.to_string(),
        })
        .collect()
}

#[tauri::command]
pub(crate) fn terminal_spawn(
    store: State<'_, Arc<V2Store>>,
    registry: State<'_, Arc<TerminalRegistry>>,
    profile_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    on_event: Channel<TerminalEvent>,
) -> Result<TerminalSpawnResult, String> {
    if !cwd.trim().is_empty() {
        super::require_authorized_path(&store, &cwd)?;
        if !Path::new(&cwd).is_dir() {
            return Err(format!("Terminal working directory is not a folder: {cwd}"));
        }
    }
    let profiles = launch_profiles();
    let profile = profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .or_else(|| profiles.first())
        .ok_or_else(|| "No terminal profiles are available".to_string())?;
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.clamp(1, 500),
            cols: cols.clamp(1, 500),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Could not open ConPTY: {error}"))?;
    let mut command = CommandBuilder::new(&profile.program);
    for argument in &profile.args {
        command.arg(argument);
    }
    if !cwd.trim().is_empty() {
        command.cwd(&cwd);
    }
    for (key, value) in std::env::vars() {
        command.env(key, value);
    }
    command.env("TERM", "xterm-256color");
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Could not start {}: {error}", profile.label))?;
    drop(pair.slave);
    let killer = child.clone_killer();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Could not open terminal output: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Could not open terminal input: {error}"))?;
    let id = registry.next_id.fetch_add(1, Ordering::Relaxed);
    registry
        .sessions
        .lock()
        .map_err(|_| "Terminal registry is unavailable".to_string())?
        .insert(
            id,
            TerminalSession {
                master: pair.master,
                writer,
                killer,
            },
        );

    let data_channel = on_event.clone();
    std::thread::Builder::new()
        .name(format!("filetree-terminal-read-{id}"))
        .spawn(move || {
            let mut buffer = [0_u8; 16 * 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        if data_channel
                            .send(TerminalEvent::Data {
                                id,
                                data: buffer[..count].to_vec(),
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
        })
        .map_err(|error| format!("Could not start terminal output worker: {error}"))?;

    let registry_for_exit = Arc::clone(registry.inner());
    std::thread::Builder::new()
        .name(format!("filetree-terminal-wait-{id}"))
        .spawn(move || {
            let code = child
                .wait()
                .map(|status| status.exit_code() as i32)
                .unwrap_or(-1);
            std::thread::sleep(Duration::from_millis(80));
            let _ = on_event.send(TerminalEvent::Exit { id, code });
            if let Ok(mut sessions) = registry_for_exit.sessions.lock() {
                sessions.remove(&id);
            }
        })
        .map_err(|error| format!("Could not start terminal wait worker: {error}"))?;

    Ok(TerminalSpawnResult {
        id,
        title: profile.label.to_string(),
    })
}

#[tauri::command]
pub(crate) fn terminal_write(
    registry: State<'_, Arc<TerminalRegistry>>,
    id: u32,
    data: String,
) -> Result<(), String> {
    let mut sessions = registry
        .sessions
        .lock()
        .map_err(|_| "Terminal registry is unavailable".to_string())?;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| "Terminal session has ended".to_string())?;
    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| session.writer.flush())
        .map_err(|error| format!("Could not write to terminal: {error}"))
}

#[tauri::command]
pub(crate) fn terminal_resize(
    registry: State<'_, Arc<TerminalRegistry>>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = registry
        .sessions
        .lock()
        .map_err(|_| "Terminal registry is unavailable".to_string())?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| "Terminal session has ended".to_string())?;
    session
        .master
        .resize(PtySize {
            rows: rows.clamp(1, 500),
            cols: cols.clamp(1, 500),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Could not resize terminal: {error}"))
}

#[tauri::command]
pub(crate) fn terminal_kill(
    registry: State<'_, Arc<TerminalRegistry>>,
    id: u32,
) -> Result<(), String> {
    let mut sessions = registry
        .sessions
        .lock()
        .map_err(|_| "Terminal registry is unavailable".to_string())?;
    if let Some(session) = sessions.get_mut(&id) {
        session
            .killer
            .kill()
            .map_err(|error| format!("Could not stop terminal: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_required_windows_profiles() {
        let profiles = terminal_profiles();
        assert!(profiles.iter().any(|profile| profile.id == "powershell"));
        assert!(profiles.iter().any(|profile| profile.id == "cmd"));
    }

    #[test]
    fn profile_programs_are_not_user_controlled() {
        for profile in launch_profiles() {
            assert!(!profile.id.is_empty());
            assert!(!profile.program.as_os_str().is_empty());
        }
    }
}
