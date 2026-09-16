use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    time::UNIX_EPOCH,
};
use tauri::{Manager, State};

const MAX_TEXT: usize = 2 * 1024 * 1024;
static WORKSPACE_LOCK: Mutex<()> = Mutex::new(());
/// Workspaces this process has already prepared, and the last config parse per
/// installation. Both exist because every trip through Python costs seconds on
/// Windows, and opening the plugin's tab used to pay for two of them.
static WORKSPACE_READY: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static CONFIG_CACHE: OnceLock<Mutex<HashMap<String, (ConfigStamp, Value)>>> = OnceLock::new();

/// Length and modification time of config.yml — enough to notice an edit made
/// outside FileTree, without reading or parsing the file.
type ConfigStamp = (u64, u128);

fn config_stamp(path: &Path) -> ConfigStamp {
    let Ok(meta) = fs::metadata(path) else {
        return (0, 0);
    };
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|since| since.as_nanos())
        .unwrap_or(0);
    (meta.len(), modified)
}

/// `init` creates the workspace and is idempotent, so a process that has
/// already run it for this installation can skip straight to the files.
fn ensure_workspace(root: &Path, repo: &str) -> Result<(), String> {
    let key = format!("{}|{repo}", root.display());
    let ready = WORKSPACE_READY.get_or_init(Mutex::default);
    if ready
        .lock()
        .map(|done| done.contains(&key))
        .unwrap_or(false)
    {
        return Ok(());
    }
    workspace(root, repo, json!({"action":"init"}))?;
    if let Ok(mut done) = ready.lock() {
        done.insert(key);
    }
    Ok(())
}

/// The parsed config, reusing the last parse while config.yml is untouched.
fn parsed_config(repo: &str, path: &Path, text: &str) -> Result<Value, String> {
    let stamp = config_stamp(path);
    let cache = CONFIG_CACHE.get_or_init(Mutex::default);
    if let Ok(entries) = cache.lock()
        && let Some((cached, value)) = entries.get(repo)
        && *cached == stamp
    {
        return Ok(value.clone());
    }
    let value = config(repo, text, Value::Null)?;
    remember_config(repo, path, &value);
    Ok(value)
}

fn remember_config(repo: &str, path: &Path, value: &Value) {
    if let Ok(mut entries) = CONFIG_CACHE.get_or_init(Mutex::default).lock() {
        entries.insert(repo.to_string(), (config_stamp(path), value.clone()));
    }
}

fn workspace(root: &Path, repo: &str, mut request: Value) -> Result<Value, String> {
    request["root"] = json!(root);
    let mut child = command(python(repo)?)
        .args(["-c", include_str!("cyberdrop_workspace.py")])
        .current_dir(repo)
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .ok_or("Workspace input unavailable")?
        .write_all(request.to_string().as_bytes())
        .map_err(|e| e.to_string())?;
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Could not initialize Cyberdrop workspace".to_string())?;
    if !output.status.success() {
        return Err(value["error"]
            .as_str()
            .unwrap_or("Workspace operation failed")
            .to_string());
    }
    Ok(value)
}

#[tauri::command]
pub(crate) async fn cyberdrop_workspace(
    app: tauri::AppHandle,
    state: State<'_, Arc<CyberdropState>>,
    repo: String,
    request: Value,
) -> Result<Value, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = WORKSPACE_LOCK.lock().map_err(|e| e.to_string())?;
        let root = data_root(&app)?;
        if request["action"] == "stage" {
            let mut run = state.0.lock().map_err(|e| e.to_string())?;
            refresh(&mut run)?;
            if run.child.is_some() {
                return Err("Stop the current download before loading another workstation".into());
            }
        }
        workspace(&root, &repo, request)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Default)]
pub(crate) struct CyberdropState(Mutex<Run>);
#[derive(Default)]
struct Run {
    child: Option<Child>,
    #[cfg(windows)]
    job: Option<ProcessJob>,
    status: String,
    logs: Arc<Mutex<VecDeque<String>>>,
    started: u64,
    progress: Arc<Mutex<Value>>,
    download_root: Option<PathBuf>,
}
#[cfg(windows)]
struct ProcessJob(usize);
#[cfg(windows)]
impl ProcessJob {
    fn attach(child: &Child) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{Foundation::HANDLE, System::JobObjects::*};
        unsafe {
            let handle = CreateJobObjectW(None, None).map_err(|e| e.to_string())?;
            let job = Self(handle.0 as usize);
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            )
            .map_err(|e| e.to_string())?;
            AssignProcessToJobObject(handle, HANDLE(child.as_raw_handle()))
                .map_err(|e| e.to_string())?;
            Ok(job)
        }
    }
    fn stop(&self) -> Result<(), String> {
        unsafe {
            windows::Win32::System::JobObjects::TerminateJobObject(
                windows::Win32::Foundation::HANDLE(self.0 as *mut _),
                1,
            )
            .map_err(|e| e.to_string())
        }
    }
}
#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(windows::Win32::Foundation::HANDLE(
                self.0 as *mut _,
            ));
        }
    }
}
impl CyberdropState {
    pub(crate) fn shutdown(&self) {
        if let Ok(mut run) = self.0.lock() {
            let _ = stop_run(&mut run);
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    status: String,
    logs: Vec<String>,
    started: u64,
    progress: Value,
}

fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}
fn python(repo: &str) -> Result<PathBuf, String> {
    let root = Path::new(repo);
    if !root.join("cyberdrop_dl/cli.py").is_file() {
        return Err("Choose the CyberDropDownloader installation folder".into());
    }
    let python = root.join(".venv/Scripts/python.exe");
    if !python.is_file() {
        return Err("Cyberdrop's .venv/Scripts/python.exe was not found".into());
    }
    Ok(python)
}
fn read_text(path: &Path) -> Result<String, String> {
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > MAX_TEXT as u64 {
        return Err("Document exceeds 2 MB".into());
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}
fn save_text(path: &Path, text: &str) -> Result<(), String> {
    if text.len() > MAX_TEXT {
        return Err("Document exceeds 2 MB".into());
    }
    // Preserve the previous saved document if a write fails.
    let temp = path.with_extension("saving");
    fs::write(&temp, text).map_err(|e| e.to_string())?;
    fs::rename(&temp, path).map_err(|e| e.to_string())
}
fn config(repo: &str, text: &str, patch: Value) -> Result<Value, String> {
    let mut child = command(python(repo)?)
        .args(["-c", include_str!("cyberdrop_config.py")])
        .current_dir(repo)
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .ok_or("Config input unavailable")?
        .write_all(json!({"text":text,"patch":patch}).to_string().as_bytes())
        .map_err(|e| e.to_string())?;
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|_| {
        "Cyberdrop could not validate the config; check its Python installation".to_string()
    })?;
    if !output.status.success() {
        return Err(value["error"]
            .as_str()
            .unwrap_or("Invalid config")
            .to_string());
    }
    Ok(value)
}
fn data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cyberdrop");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root)
}

#[tauri::command]
pub(crate) async fn cyberdrop_document(
    app: tauri::AppHandle,
    repo: String,
    action: String,
    name: String,
    text: Option<String>,
    patch: Option<Value>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = data_root(&app)?;
        let _guard = WORKSPACE_LOCK.lock().map_err(|e| e.to_string())?;
        ensure_workspace(&root, &repo)?;
        if name != "config.yml" { return Err("Edit URL workstations instead of the active URLs.txt".into()); }
        let path = root.join(&name);
        let mut parsed = Value::Null;
        match action.as_str() {
            "save" => {
                let text = text.ok_or("Missing document text")?;
                if name == "config.yml" { parsed = config(&repo, &text, Value::Null)?; }
                save_text(&path, &text)?;
                remember_config(&repo, &path, &parsed);
            }
            "patch" if name == "config.yml" => {
                parsed = config(&repo, &read_text(&path)?, patch.unwrap_or(Value::Null))?;
                save_text(&path, parsed["text"].as_str().ok_or("Missing configuration")?)?;
                remember_config(&repo, &path, &parsed);
            }
            "load" => {},
            _ => return Err("Unknown document action".into()),
        }
        let content = read_text(&path)?;
        let mut validation_error = None;
        if name == "config.yml" && parsed.is_null() {
            match parsed_config(&repo, &path, &content) {
                Ok(value) => parsed = value,
                Err(error) => validation_error = Some(error),
            }
        }
        Ok(json!({"text":content,"settings":parsed["settings"],"lists":[],"folder":root,"name":name,"validationError":validation_error,"cachePath":root.join("cache.json"),"databasePath":root.join("cyberdrop.db")}))
    }).await.map_err(|e| e.to_string())?
}

fn capture(mut pipe: impl Read + Send + 'static, logs: Arc<Mutex<VecDeque<String>>>) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(count) = pipe.read(&mut buf) {
            if count == 0 {
                break;
            }
            if let Ok(mut lines) = logs.lock() {
                lines.push_back(String::from_utf8_lossy(&buf[..count]).replace('\r', "\n"));
                while lines.len() > 256 {
                    lines.pop_front();
                }
            }
        }
    });
}
fn capture_downloads(
    pipe: impl Read + Send + 'static,
    logs: Arc<Mutex<VecDeque<String>>>,
    progress: Arc<Mutex<Value>>,
    runtime: Arc<filetree_core::DesktopRuntime>,
    excluded: Vec<String>,
    allowed_root: Option<PathBuf>,
    settings: Value,
) {
    use std::io::BufRead;
    let (send, receive) = std::sync::mpsc::channel::<String>();
    let queue_logs = Arc::clone(&logs);
    std::thread::spawn(move || {
        let mut seen = std::collections::HashSet::new();
        while let Ok(first) = receive.recv() {
            let mut batch = vec![first];
            // Collect across short gaps instead of creating a run for nearly
            // every download. Flush on the deadline, capacity, or downloader exit.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
            while batch.len() < 256 {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match receive.recv_timeout(remaining) {
                    Ok(path) => batch.push(path),
                    Err(_) => break,
                }
            }
            batch.retain(|path| seen.insert(path.to_lowercase()));
            if batch.is_empty() {
                continue;
            }
            // Side-load settings (preset, originals) plus this batch's fields.
            let mut body = settings.clone();
            body["paths"] = json!(batch);
            body["excludePaths"] = json!(excluded);
            body["queued"] = json!(true);
            let request = serde_json::from_value::<filetree_core::CompressionStartRequest>(body);
            let message = match request
                .map_err(|e| e.to_string())
                .and_then(|request| runtime.start_compression(request))
            {
                Ok(result) => format!(
                    "FileTree compression queue: {} files queued (job {}).\n",
                    result.total, result.job_id
                ),
                Err(error) => format!("FileTree compression queue: {error}\n"),
            };
            if let Ok(mut lines) = queue_logs.lock() {
                lines.push_back(message);
                while lines.len() > 256 {
                    lines.pop_front();
                }
            }
        }
    });
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(pipe).lines().map_while(Result::ok) {
            if let Some(event) = line.strip_prefix("FILETREE_PROGRESS:") {
                if let Ok(value) = serde_json::from_str::<Value>(event)
                    && let Ok(mut current) = progress.lock()
                {
                    *current = value;
                }
                continue;
            }
            if let Some(event) = line
                .strip_prefix("FILETREE_COMPLETED:")
                .filter(|_| allowed_root.is_some())
            {
                if let Ok(path) = serde_json::from_str::<String>(event)
                    && let (Ok(candidate), Ok(root)) = (
                        fs::canonicalize(&path),
                        fs::canonicalize(allowed_root.as_ref().unwrap()),
                    )
                    && candidate.starts_with(root)
                    && candidate.is_file()
                {
                    let _ = send.send(path);
                }
            } else if let Ok(mut lines) = logs.lock() {
                // Bound individual CLI lines as well as the number retained.
                lines.push_back(line.chars().take(4096).collect::<String>() + "\n");
                while lines.len() > 256 {
                    lines.pop_front();
                }
            }
        }
    });
}
fn refresh(run: &mut Run) -> Result<(), String> {
    if let Some(child) = &mut run.child
        && let Some(status) = child.try_wait().map_err(|e| e.to_string())?
    {
        run.status = if status.success() {
            "Completed".into()
        } else {
            format!("Failed (exit {})", status.code().unwrap_or(-1))
        };
        run.child = None;
        #[cfg(windows)]
        {
            run.job = None;
        }
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn cyberdrop_start(
    app: tauri::AppHandle,
    state: State<'_, Arc<CyberdropState>>,
    repo: String,
    exclude_paths: Option<Vec<String>>,
) -> Result<(), String> {
    let state = Arc::clone(&state);
    let runtime = app
        .state::<Arc<filetree_core::DesktopRuntime>>()
        .inner()
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = WORKSPACE_LOCK.lock().map_err(|e| e.to_string())?;
        let root = data_root(&app)?;
        let view = workspace(&root, &repo, json!({"action":"init"}))?;
        if view["loaded"].is_null() { return Err("Load a workstation for download first".into()); }
        let mode = view["compressionMode"].as_str().unwrap_or("off");
        let configured = config(&repo, &read_text(&root.join("config.yml"))?, json!({"compression_options.enabled":mode == "cyberdrop", "logs.folder":root.join("logs")}))?;
        save_text(&root.join("config.yml"), configured["text"].as_str().ok_or("Invalid config")?)?;
        let urls = root.join("URLs.txt");
        if read_text(&urls)?.lines().all(|line| line.trim().is_empty() || line.trim().starts_with('#')) { return Err("Add URLs to this list before starting".into()); }
        config(&repo, &read_text(&root.join("config.yml"))?, Value::Null)?;
        fs::create_dir_all(root.join("runtime")).map_err(|e| e.to_string())?;
        let mut run = state.0.lock().map_err(|e| e.to_string())?;
        refresh(&mut run)?;
        if run.child.is_some() { return Err("Stop the current download before starting another".into()); }
        let mut child = command(python(&repo)?)
            .args(["-u", "-c", include_str!("cyberdrop_runner.py"), "download", "--config-file"])
            .arg(root.join("config.yml")).arg("--appdata-folder").arg(root.join("runtime"))
            .arg("--cache-file").arg(root.join("cache.json"))
            .arg("--database-file").arg(root.join("cyberdrop.db"))
            .arg("--input-file").arg(urls).args(["--ui", "simple"])
            .current_dir(&repo).env("PYTHONIOENCODING", "utf-8").env("NO_COLOR", "1").env("FILETREE_SIDELOAD", if mode == "filetree" { "1" } else { "0" })
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
        #[cfg(windows)] {
            run.job = Some(ProcessJob::attach(&child).inspect_err(|_error| { let _ = child.kill(); let _ = child.wait(); })?);
        }
        run.logs = Arc::new(Mutex::new(VecDeque::new()));
        run.progress = Arc::new(Mutex::new(Value::Null));
        let download_root = PathBuf::from(configured["settings"]["download_folder"].as_str().unwrap_or("downloads/cyberdrop-dl"));
        let download_root = if download_root.is_absolute() { download_root } else { Path::new(&repo).join(download_root) };
        run.download_root = Some(download_root.clone());
        let sideload = json!({
            "preset": view["sideload"]["preset"].as_str().unwrap_or("balanced"),
            "originalAction": view["sideload"]["originalAction"].as_str().unwrap_or("keep"),
        });
        if let Some(stdout) = child.stdout.take() { capture_downloads(stdout, Arc::clone(&run.logs), Arc::clone(&run.progress), runtime, exclude_paths.unwrap_or_default(), (mode == "filetree").then_some(download_root), sideload); }
        if let Some(stderr) = child.stderr.take() { capture(stderr, Arc::clone(&run.logs)); }
        run.started = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        run.status = "Running".into();
        run.child = Some(child);
        Ok(())
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn cyberdrop_status(
    state: State<'_, Arc<CyberdropState>>,
) -> Result<Snapshot, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let mut run = state.0.lock().map_err(|e| e.to_string())?;
        refresh(&mut run)?;
        let logs = run
            .logs
            .lock()
            .map_err(|e| e.to_string())?
            .iter()
            .cloned()
            .collect();
        let progress = run.progress.lock().map_err(|e| e.to_string())?.clone();
        Ok(Snapshot {
            status: if run.status.is_empty() {
                "Ready".into()
            } else {
                run.status.clone()
            },
            logs,
            started: run.started,
            progress,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
fn stop_run(run: &mut Run) -> Result<(), String> {
    refresh(run)?;
    if let Some(child) = &mut run.child {
        #[cfg(windows)]
        {
            if let Some(job) = &run.job {
                job.stop()?;
            } else {
                child.kill().map_err(|e| e.to_string())?;
            }
        }
        #[cfg(not(windows))]
        child.kill().map_err(|e| e.to_string())?;
        let _ = child.wait();
        run.child = None;
        #[cfg(windows)]
        {
            run.job = None;
        }
        run.status = "Stopped".into();
        if let Some(root) = &run.download_root {
            let (removed, failed) = remove_partial_files(root, run.started);
            let mut message = format!("Stopped: removed {removed} partial .part file(s).\n");
            if failed > 0 {
                message = format!(
                    "Stopped: removed {removed} partial .part file(s); {failed} could not be deleted.\n"
                );
            }
            if let Ok(mut lines) = run.logs.lock() {
                lines.push_back(message);
                while lines.len() > 256 {
                    lines.pop_front();
                }
            }
        }
    }
    Ok(())
}
/// Deletes `.part` files under `root` written since `since` (unix seconds), so
/// stopping a run does not touch unrelated or older partial files.
fn remove_partial_files(root: &Path, since: u64) -> (usize, usize) {
    let since = std::time::UNIX_EPOCH + std::time::Duration::from_secs(since);
    let mut pending = Vec::new();
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            // DirEntry::file_type does not follow symlinks.
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                dirs.push(path);
            } else if kind.is_file()
                && path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("part"))
                && entry
                    .metadata()
                    .and_then(|meta| meta.modified())
                    .is_ok_and(|modified| modified >= since)
            {
                pending.push(path);
            }
        }
    }
    let mut removed = 0;
    // Terminated downloader handles can take a moment to release on Windows.
    for attempt in 0..5 {
        pending.retain(|path| match fs::remove_file(path) {
            Ok(()) => {
                removed += 1;
                false
            }
            Err(error) => error.kind() != std::io::ErrorKind::NotFound,
        });
        if pending.is_empty() || attempt == 4 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    (removed, pending.len())
}
#[tauri::command]
pub(crate) async fn cyberdrop_stop(state: State<'_, Arc<CyberdropState>>) -> Result<(), String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let mut run = state.0.lock().map_err(|e| e.to_string())?;
        stop_run(&mut run)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replaces_saved_unicode_document() {
        let path =
            std::env::temp_dir().join(format!("filetree-cyberdrop-{}.txt", std::process::id()));
        save_text(&path, "first").unwrap();
        save_text(&path, "second 日本語\n").unwrap();
        assert_eq!(read_text(&path).unwrap(), "second 日本語\n");
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn removes_only_recent_partial_files() {
        let root =
            std::env::temp_dir().join(format!("filetree-cyberdrop-parts-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("album")).unwrap();
        for name in ["album/a.mp4.part", "b.PART", "album/done.mp4", "old.part"] {
            fs::write(root.join(name), "x").unwrap();
        }
        fs::File::options()
            .write(true)
            .open(root.join("old.part"))
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000))
            .unwrap();
        let started = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - 60;
        assert_eq!(remove_partial_files(&root, started), (2, 0));
        assert!(!root.join("album/a.mp4.part").exists() && !root.join("b.PART").exists());
        assert!(root.join("album/done.mp4").exists() && root.join("old.part").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[cfg(windows)]
    fn stop_clears_owned_process_and_allows_another_run() {
        let mut run = Run::default();
        for _ in 0..2 {
            run.child = Some(
                command("powershell.exe")
                    .args([
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        "Start-Sleep -Seconds 20",
                    ])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap(),
            );
            run.job = Some(ProcessJob::attach(run.child.as_ref().unwrap()).unwrap());
            run.status = "Running".into();
            stop_run(&mut run).unwrap();
            assert!(run.child.is_none());
            assert_eq!(run.status, "Stopped");
            stop_run(&mut run).unwrap();
        }
    }
}
