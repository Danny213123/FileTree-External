//! Windows Scheduled Task automation (gap #10).
//!
//! Lets the UI register a recurring Scheduled Task that runs the FileTree CLI
//! headless (`filetree scan --path … --out … --format …`) on a daily/weekly
//! cadence, then list and delete those tasks again.
//!
//! ## Why PowerShell + a temp script (not `schtasks /Create`)
//! `schtasks /Create /TR "…"` requires the whole command line to be smuggled
//! through one heavily-quoted `/TR` value; nested quotes around an exe path that
//! itself contains spaces is the classic source of silent breakage. The
//! `ScheduledTasks` PowerShell module instead takes the executable and its
//! arguments as *separate* parameters (`-Execute` / `-Argument`), so there is no
//! combined command line to mis-quote. We render a small script to a temp
//! `.ps1` and run it with `-File` — that sidesteps `-Command` quoting entirely
//! and keeps the user-supplied paths inside PowerShell **single-quoted string
//! literals**, which do not interpolate or execute anything.
//!
//! ## Injection posture
//! These endpoints run system commands, so every value that reaches the script
//! is either (a) whitelisted/regex-validated (name, schedule, time, weekday,
//! format) or (b) embedded as a single-quoted PS literal with `'` doubled
//! (paths). The server only reaches this module after the destructive-route
//! token gate, so an unauthenticated local process can't drive it.

use std::path::{Path, PathBuf};
use std::process::Command;

/// All the knobs the UI collects for one scheduled scan+export.
pub(crate) struct CreateRequest {
    /// Task name (also used in the output filename). Validated to a safe charset.
    pub name: String,
    /// Folder/drive to scan.
    pub path: String,
    /// `"daily"` or `"weekly"`.
    pub schedule: String,
    /// Start time, 24h `HH:MM`.
    pub time: String,
    /// Weekday for `weekly` (e.g. `Mon`/`Monday`); ignored for daily.
    pub day: String,
    /// Folder the report is written into.
    pub out_dir: String,
    /// Export format reused from #8: `csv|json|html|xml|xlsx`.
    pub format: String,
}

/// PowerShell task folder all FileTree tasks live under, so list/delete can
/// scope themselves and never touch a user's own tasks.
const TASK_PATH: &str = "\\FileTree\\";

/// Escape a string for embedding inside a PowerShell **single-quoted** literal:
/// the only metacharacter is `'`, which is doubled. Single-quoted strings do not
/// expand `$`, backticks, or subexpressions, so this fully neutralises content.
fn ps_lit(s: &str) -> String {
    s.replace('\'', "''")
}

/// Reject names that could escape the charset we embed/format with. Allows
/// letters, digits, space, underscore and hyphen; 1..=64 chars.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '_' || c == '-')
}

/// Validate a 24-hour `HH:MM` time string.
fn valid_time(time: &str) -> bool {
    let bytes = time.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return false;
    }
    let (h, m) = (&time[0..2], &time[3..5]);
    match (h.parse::<u32>(), m.parse::<u32>()) {
        (Ok(h), Ok(m)) => h < 24 && m < 60,
        _ => false,
    }
}

/// Map a user weekday (`mon`, `Monday`, …) to the canonical PowerShell
/// `DayOfWeek` enum name. Whitelist → safe to embed bare in the script.
fn canonical_weekday(day: &str) -> Option<&'static str> {
    match day.trim().to_ascii_lowercase().as_str() {
        "mon" | "monday" => Some("Monday"),
        "tue" | "tues" | "tuesday" => Some("Tuesday"),
        "wed" | "weds" | "wednesday" => Some("Wednesday"),
        "thu" | "thur" | "thurs" | "thursday" => Some("Thursday"),
        "fri" | "friday" => Some("Friday"),
        "sat" | "saturday" => Some("Saturday"),
        "sun" | "sunday" => Some("Sunday"),
        _ => None,
    }
}

/// Validate the export format against the set the CLI's `scan` command accepts.
fn valid_format(fmt: &str) -> Option<&'static str> {
    match fmt {
        "csv" => Some("csv"),
        "json" => Some("json"),
        "html" => Some("html"),
        "xml" => Some("xml"),
        "xlsx" => Some("xlsx"),
        _ => None,
    }
}

/// Path of the running FileTree executable — the binary the task should invoke.
fn current_exe_string() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("could not resolve FileTree executable path: {e}"))
}

/// Write `script` to a unique temp `.ps1`, run it with the bundled Windows
/// PowerShell, and return its trimmed stdout on success. The temp file is always
/// cleaned up. A non-zero exit returns the captured stderr (or stdout) as the
/// error so the UI can show Windows' own message.
fn run_powershell(script: &str) -> Result<String, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp: PathBuf =
        std::env::temp_dir().join(format!("filetree_sched_{}_{}.ps1", std::process::id(), nonce));

    std::fs::write(&tmp, script).map_err(|e| format!("could not stage task script: {e}"))?;

    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&tmp)
        .output();

    // Best-effort cleanup regardless of outcome.
    let _ = std::fs::remove_file(&tmp);

    let output = output.map_err(|e| format!("could not launch PowerShell: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let msg = if !stderr.is_empty() { stderr } else { stdout };
        Err(if msg.is_empty() {
            format!("PowerShell exited with status {}", output.status)
        } else {
            msg
        })
    }
}

/// Create (or overwrite, via `-Force`) a FileTree scheduled task. Returns the
/// full task name (`\FileTree\<name>`) on success.
pub(crate) fn create_task(req: &CreateRequest) -> Result<String, String> {
    if !valid_name(&req.name) {
        return Err("Task name must be 1-64 chars: letters, digits, space, _ or -".into());
    }
    if !valid_time(&req.time) {
        return Err("Time must be 24-hour HH:MM".into());
    }
    let format = valid_format(&req.format)
        .ok_or_else(|| "Format must be one of csv, json, html, xml, xlsx".to_string())?;
    if req.path.trim().is_empty() {
        return Err("Scan path is required".into());
    }
    if !Path::new(&req.path).exists() {
        return Err(format!("Scan path does not exist: {}", req.path));
    }
    if req.out_dir.trim().is_empty() {
        return Err("Output folder is required".into());
    }
    if !Path::new(&req.out_dir).is_dir() {
        return Err(format!("Output folder is not a directory: {}", req.out_dir));
    }
    // Disallow embedded quotes/newlines in paths up front: a literal " can't
    // exist in a real Windows path, and rejecting it keeps the generated CLI
    // arg string unambiguous on top of the PS single-quote escaping below.
    for (label, value) in [("scan path", &req.path), ("output folder", &req.out_dir)] {
        if value.contains('"') || value.contains('\n') || value.contains('\r') {
            return Err(format!("Invalid character in {label}"));
        }
    }

    let trigger = match req.schedule.as_str() {
        "daily" => format!("New-ScheduledTaskTrigger -Daily -At '{}'", req.time),
        "weekly" => {
            let day = canonical_weekday(&req.day)
                .ok_or_else(|| "Weekly schedule needs a valid weekday".to_string())?;
            format!(
                "New-ScheduledTaskTrigger -Weekly -DaysOfWeek {} -At '{}'",
                day, req.time
            )
        }
        _ => return Err("Schedule must be 'daily' or 'weekly'".into()),
    };

    let exe = current_exe_string()?;
    let out_file = format!(
        "{}\\filetree-report-{}.{}",
        req.out_dir.trim_end_matches(['\\', '/']),
        req.name,
        format
    );
    // The argument string Windows hands to the exe when the task fires. Paths are
    // double-quoted for the CLI's own arg parsing; the whole thing then lives in
    // a PS single-quoted literal (escaped) so PowerShell treats it verbatim.
    let cli_args = format!(
        "scan --path \"{}\" --out \"{}\" --format {}",
        req.path, out_file, format
    );

    let script = format!(
        "$ErrorActionPreference = 'Stop'\n\
         $act = New-ScheduledTaskAction -Execute '{exe}' -Argument '{args}'\n\
         $trg = {trigger}\n\
         Register-ScheduledTask -TaskName '{name}' -TaskPath '{task_path}' -Action $act -Trigger $trg -Force -Description 'FileTree scheduled scan + export' | Out-Null\n\
         Write-Output 'OK'\n",
        exe = ps_lit(&exe),
        args = ps_lit(&cli_args),
        trigger = trigger,
        name = ps_lit(&req.name),
        task_path = ps_lit(TASK_PATH),
    );

    let full_name = format!("{TASK_PATH}{}", req.name);
    let result = run_powershell(&script);
    let name_slice = [full_name.clone()];
    crate::audit::record(crate::audit::Entry {
        op: "schedule-create",
        src: &name_slice,
        dst: &out_file,
        error: result.as_ref().err().map(|s| s.as_str()),
        by: "server",
        ..Default::default()
    });
    result.map(|_| full_name)
}

/// List FileTree scheduled tasks as a JSON array string ready to return to the
/// renderer. Empty when none exist. Read-only (no token gate needed).
pub(crate) fn list_tasks() -> Result<String, String> {
    // PowerShell 5.1 unwraps single-element arrays, so a lone task would
    // serialise as a bare object; we normalise that in Rust below.
    let script = format!(
        "$ErrorActionPreference = 'SilentlyContinue'\n\
         $tasks = Get-ScheduledTask -TaskPath '{task_path}'\n\
         $rows = foreach ($t in $tasks) {{\n\
         \x20 $info = $t | Get-ScheduledTaskInfo\n\
         \x20 $a = $t.Actions | Select-Object -First 1\n\
         \x20 [pscustomobject]@{{\n\
         \x20\x20 name = [string]$t.TaskName\n\
         \x20\x20 state = [string]$t.State\n\
         \x20\x20 execute = [string]$a.Execute\n\
         \x20\x20 arguments = [string]$a.Arguments\n\
         \x20\x20 nextRun = [string]$info.NextRunTime\n\
         \x20\x20 lastRun = [string]$info.LastRunTime\n\
         \x20 }}\n\
         }}\n\
         if ($null -eq $rows) {{ Write-Output '[]' }} else {{ ConvertTo-Json -InputObject @($rows) -Compress }}\n",
        task_path = ps_lit(TASK_PATH),
    );

    let out = run_powershell(&script)?;
    let trimmed = out.trim();
    if trimmed.is_empty() {
        Ok("[]".to_string())
    } else if trimmed.starts_with('{') {
        // Single object → wrap as a one-element array for the client.
        Ok(format!("[{trimmed}]"))
    } else {
        Ok(trimmed.to_string())
    }
}

/// Delete one FileTree task by its short name (no `\FileTree\` prefix).
pub(crate) fn delete_task(name: &str) -> Result<(), String> {
    if !valid_name(name) {
        return Err("Invalid task name".into());
    }
    let script = format!(
        "$ErrorActionPreference = 'Stop'\n\
         Unregister-ScheduledTask -TaskName '{name}' -TaskPath '{task_path}' -Confirm:$false\n\
         Write-Output 'OK'\n",
        name = ps_lit(name),
        task_path = ps_lit(TASK_PATH),
    );
    let full_name = format!("{TASK_PATH}{name}");
    let result = run_powershell(&script);
    let name_slice = [full_name];
    crate::audit::record(crate::audit::Entry {
        op: "schedule-delete",
        src: &name_slice,
        dst: "",
        error: result.as_ref().err().map(|s| s.as_str()),
        by: "server",
        ..Default::default()
    });
    result.map(|_| ())
}
