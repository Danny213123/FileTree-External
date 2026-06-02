//! Native Windows drag-out for FileTree.
//!
//! Electron's `webContents.startDrag()` always advertises a *copy* effect and
//! returns nothing, so the renderer can never tell whether the OS performed a
//! move, a copy, or a cancel. That makes a safe "true move" impossible from JS
//! alone (deleting the source after a cancelled drop loses data).
//!
//! This addon runs the drag itself with the Windows shell (`SHDoDragDrop`),
//! which DOES report the real drop effect. It must run on the caller's thread
//! (Electron's UI thread) because OLE drag-and-drop is driven by the mouse
//! capture owned by the thread that received the button-down — a background
//! thread has no capture and the drag never starts.
//!
//! Running on the UI thread blocks Chromium just enough that it can't complete
//! an *internal* drop itself (it still fires `dragover`, so highlight and
//! auto-scroll work, but it never returns the effect or fires `drop`). So we
//! classify the drop here and hand internal drops back to the renderer:
//!
//!   * Pointer over a window owned by *another* process  -> external drop.
//!       - effect MOVE -> delete the source (true move), report "external-move".
//!       - otherwise   -> report "external-copy" (source preserved).
//!   * Pointer over one of *our* windows                 -> "internal": the
//!       renderer hit-tests the drop point and performs the move via the
//!       backend. We never delete here.
//!   * Left mouse button still down on return            -> "cancel" (the user
//!       pressed Esc); do nothing.

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Task};
use napi_derive::napi;

mod audit;

/// Result of a native drag, surfaced to the Electron main process.
#[napi(object)]
pub struct DragResult {
    /// "external-move" | "external-copy" | "internal" | "cancel"
    pub outcome: String,
    /// Drop point in *physical* screen pixels (valid for "internal").
    pub drop_x: i32,
    pub drop_y: i32,
    /// Source paths deleted as part of a *synchronous* external move. Empty for
    /// an async external move (see `deferred`): nothing is deleted by us there.
    pub deleted: Vec<String>,
    /// True when an async external MOVE was initiated: the OS performs the copy
    /// on its own thread AFTER this returns, so the source removal isn't known
    /// yet and we deliberately delete nothing here. The caller should await
    /// `confirm_external_move` and rescan once it resolves. False for every
    /// synchronous outcome (internal / cancel / external-copy / sync move).
    pub deferred: bool,
}

/// Perform a native shell drag of the given absolute paths.
///
/// Blocks for the duration of the drag (the shell runs a modal loop until the
/// user drops or cancels). MUST be called on the Electron main-process UI
/// thread so it inherits the mouse capture from the originating click.
#[napi]
pub fn drag_files(paths: Vec<String>) -> napi::Result<DragResult> {
    #[cfg(windows)]
    {
        windows_impl::drag(paths).map_err(napi::Error::from_reason)
    }
    #[cfg(not(windows))]
    {
        let _ = paths;
        Err(napi::Error::from_reason(
            "filetree-drag is only supported on Windows",
        ))
    }
}

/// Result of a native shell move, surfaced to the Electron main process.
#[napi(object)]
pub struct MoveResult {
    /// True if the user cancelled / the operation was aborted in the native
    /// Windows progress or conflict dialog.
    pub aborted: bool,
    /// Sources gone from their origin after the operation — i.e. moved.
    pub moved: u32,
    /// Sources skipped *before* the operation as no-ops/unsafe (already in the
    /// destination, or moving a folder into itself / its own descendant).
    pub skipped: u32,
    /// Sources that were queued but remain at their origin afterward: a per-item
    /// failure, or the user chose "Skip" in the native collision dialog.
    pub failed: u32,
}

/// Runs the shell move on a background (libuv) thread so it NEVER blocks
/// Electron's main/UI thread. The native progress/conflict dialog still appears
/// (parented to FileTree via `owner`) and drives its own modal message loop on
/// the worker thread; meanwhile the main thread — and the whole app — stays
/// responsive. Blocking the main thread here would freeze the entire UI (drag,
/// clicks, IPC) until the dialog closed, which is the bug this avoids.
pub struct MoveTask {
    sources: Vec<String>,
    dest: String,
    owner: isize,
}

impl Task for MoveTask {
    type Output = MoveResult;
    type JsValue = MoveResult;

    fn compute(&mut self) -> napi::Result<MoveResult> {
        #[cfg(windows)]
        {
            let sources = std::mem::take(&mut self.sources);
            let dest = std::mem::take(&mut self.dest);
            let o = windows_impl::move_items(sources, dest, self.owner)
                .map_err(napi::Error::from_reason)?;
            Ok(MoveResult {
                aborted: o.aborted,
                moved: o.moved,
                skipped: o.skipped,
                failed: o.failed,
            })
        }
        #[cfg(not(windows))]
        {
            Err(napi::Error::from_reason(
                "filetree-drag is only supported on Windows",
            ))
        }
    }

    fn resolve(&mut self, _env: Env, out: MoveResult) -> napi::Result<MoveResult> {
        Ok(out)
    }
}

/// Move the given absolute source paths into `dest` using the Windows shell
/// file-operation engine (`IFileOperation`) — the *real* native dialogs
/// (progress, "Replace / Skip / Keep both", "the source and destination file
/// names are the same", elevation), exactly like Explorer.
///
/// `owner_hwnd` is FileTree's top-level window handle (0 = let the shell use the
/// foreground window) so the dialogs are modal to the app. Returns a Promise;
/// the operation runs on a background thread and the renderer rescans afterward.
#[napi(
    ts_return_type = "Promise<{ aborted: boolean; moved: number; skipped: number; failed: number }>"
)]
pub fn move_items_native(
    sources: Vec<String>,
    dest: String,
    owner_hwnd: f64,
) -> AsyncTask<MoveTask> {
    AsyncTask::new(MoveTask {
        sources,
        dest,
        owner: owner_hwnd as i64 as isize,
    })
}

/// Result of observing an async external move to completion.
#[napi(object)]
pub struct ConfirmMoveResult {
    /// Source paths that are gone from disk after the transfer settled (the OS
    /// performed the move and removed them itself). Empty if the sources
    /// remained (e.g. the target copied instead of moved) or the wait hit its
    /// backstop — in which case the renderer's rescan / fs-watcher reconciles.
    pub deleted: Vec<String>,
}

/// Observes an in-flight *async* external MOVE and reports which sources the OS
/// removed once it finishes. It NEVER deletes anything itself — it only watches
/// the source paths disappear — so it can never lose data. Runs on a libuv
/// worker thread (see `confirm_external_move`), so the main/UI thread stays
/// responsive throughout.
pub struct ConfirmMoveTask {
    sources: Vec<String>,
}

impl Task for ConfirmMoveTask {
    type Output = Vec<String>;
    type JsValue = ConfirmMoveResult;

    fn compute(&mut self) -> napi::Result<Vec<String>> {
        let sources = std::mem::take(&mut self.sources);
        Ok(wait_sources_removed(sources))
    }

    fn resolve(&mut self, _env: Env, deleted: Vec<String>) -> napi::Result<ConfirmMoveResult> {
        Ok(ConfirmMoveResult { deleted })
    }
}

/// Wait for an async external move to settle, then resolve with the sources the
/// OS removed. Returns a Promise; the polling runs on a background thread so the
/// main thread / UI stays responsive while Explorer copies on its own thread.
/// Pass the same absolute source paths that were dragged.
#[napi(ts_return_type = "Promise<{ deleted: string[] }>")]
pub fn confirm_external_move(sources: Vec<String>) -> AsyncTask<ConfirmMoveTask> {
    AsyncTask::new(ConfirmMoveTask { sources })
}

// ── Recycle Bin restore (Phase 6: in-app undo of a recycle delete) ──────────────

/// A restorable record discovered in the Recycle Bin: the `$R` payload to move
/// back, the `$I` index to drop afterward, and when it was deleted (so the most
/// recent match wins if the same path was recycled more than once).
struct RecycledMatch {
    payload: std::path::PathBuf,
    index: std::path::PathBuf,
    deleted_ticks: u64,
}

/// Restore an in-flight async external MOVE / recycled item to `original_full_path`
/// without COM. Windows stores each recycled item on its *source drive* under
/// `…:\$Recycle.Bin\<user-SID>\` as a pair: `$R<token><ext>` holds the real
/// file/folder, and `$I<token><ext>` is a tiny index recording the original full
/// path, size, and deletion time. We scan that drive's bin for an `$I` whose
/// recorded path matches, then move the paired `$R` back and delete the `$I`.
///
/// Safety: we never overwrite an item already sitting at the target, and if the
/// move fails we leave the bin untouched — so a failed restore can never lose
/// data. Returns false (the UI then tells the user to restore manually from the
/// Recycle Bin) when no match is found, the target is occupied, or the path is
/// not a drive-rooted local path (UNC / relative paths have no per-drive bin).
fn restore_recycled(original_full_path: &str) -> bool {
    use std::path::{Path, PathBuf};

    let target = original_full_path.trim();
    let bytes = target.as_bytes();
    // Require a local, drive-rooted path ("X:\…"): the recycle bin lives there.
    if bytes.len() < 3 || bytes[1] != b':' || (bytes[2] != b'\\' && bytes[2] != b'/') {
        return false;
    }
    let drive = bytes[0] as char;
    if !drive.is_ascii_alphabetic() {
        return false;
    }
    let bin_root = PathBuf::from(format!("{drive}:\\$Recycle.Bin"));
    let want = normalize_win_path(target);

    let mut best: Option<RecycledMatch> = None;
    let Ok(sid_dirs) = std::fs::read_dir(&bin_root) else {
        return false;
    };
    for sid in sid_dirs.flatten() {
        let sid_path = sid.path();
        if !sid_path.is_dir() {
            continue;
        }
        // Another user's SID folder we can't read → skip (best-effort).
        let Ok(entries) = std::fs::read_dir(&sid_path) else {
            continue;
        };
        for ent in entries.flatten() {
            let fname = ent.file_name();
            let fname = fname.to_string_lossy();
            // Index records begin with "$I"; the payload is the same name with
            // the leading "$I" swapped for "$R".
            if fname.len() < 2 || !fname.as_bytes()[..2].eq_ignore_ascii_case(b"$I") {
                continue;
            }
            let idx_path = ent.path();
            let Some((orig, ticks)) = parse_recycle_index(&idx_path) else {
                continue;
            };
            if normalize_win_path(&orig) != want {
                continue;
            }
            let payload = sid_path.join(format!("$R{}", &fname[2..]));
            if !payload.exists() {
                continue; // orphaned index — nothing to restore
            }
            if best.as_ref().map_or(true, |b| ticks >= b.deleted_ticks) {
                best = Some(RecycledMatch { payload, index: idx_path, deleted_ticks: ticks });
            }
        }
    }

    let Some(found) = best else {
        return false;
    };
    // Never clobber something already at the original location.
    if Path::new(target).exists() {
        return false;
    }
    if let Some(parent) = Path::new(target).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Same-volume rename: atomic, and moves a whole folder tree in one shot. On
    // failure we leave the bin intact and report failure (no data loss).
    if std::fs::rename(&found.payload, target).is_err() {
        return false;
    }
    // Payload is home; drop the now-stale index so the entry stops showing in
    // the Recycle Bin (best-effort — the data is already safe either way).
    let _ = std::fs::remove_file(&found.index);
    audit::record(audit::Entry {
        op: "restore",
        disposition: "restored",
        dst: target,
        ..Default::default()
    });
    true
}

/// Parse a Recycle Bin `$I` index file → (original full path, deletion FILETIME
/// ticks). Supports v1 (Vista–8.1: fixed 260-wide-char path) and v2 (Win10+:
/// length-prefixed path). Returns None for anything unrecognized or truncated.
fn parse_recycle_index(path: &std::path::Path) -> Option<(String, u64)> {
    let data = std::fs::read(path).ok()?;
    if data.len() < 24 {
        return None;
    }
    let version = u64::from_le_bytes(data[0..8].try_into().ok()?);
    let deleted_ticks = u64::from_le_bytes(data[16..24].try_into().ok()?);
    let wide: Vec<u16> = match version {
        1 => {
            let end = 24 + 520; // 260 UTF-16 chars
            if data.len() < end {
                return None;
            }
            data[24..end]
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .take_while(|&u| u != 0)
                .collect()
        }
        2 => {
            if data.len() < 28 {
                return None;
            }
            let chars = u32::from_le_bytes(data[24..28].try_into().ok()?) as usize;
            let end = 28 + chars.checked_mul(2)?;
            if chars == 0 || data.len() < end {
                return None;
            }
            data[28..end]
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .take_while(|&u| u != 0)
                .collect()
        }
        _ => return None,
    };
    Some((String::from_utf16_lossy(&wide), deleted_ticks))
}

/// Case-insensitive Windows path key: unify separators and drop any trailing
/// separator so "C:\A\b" and "c:/a/b\" compare equal.
fn normalize_win_path(p: &str) -> String {
    let mut s = p.trim().replace('/', "\\");
    while s.len() > 3 && s.ends_with('\\') {
        s.pop();
    }
    s.to_ascii_lowercase()
}

/// Scans the Recycle Bin and restores one item on a libuv worker thread, so a
/// large bin never blocks the UI thread.
pub struct RestoreTask {
    original: String,
}

impl Task for RestoreTask {
    type Output = bool;
    type JsValue = bool;

    fn compute(&mut self) -> napi::Result<bool> {
        Ok(restore_recycled(&self.original))
    }

    fn resolve(&mut self, _env: Env, out: bool) -> napi::Result<bool> {
        Ok(out)
    }
}

/// Best-effort restore of a recycled item back to `original_full_path`. Resolves
/// to `true` when the item was located in the Recycle Bin and moved back, and
/// `false` when it couldn't be found / the spot is occupied (the UI then tells
/// the user to restore it manually). Never deletes or overwrites on failure, so
/// it cannot lose data. Audited as a `restore` op when it succeeds.
#[napi(ts_return_type = "Promise<boolean>")]
pub fn restore_from_recycle_bin(original_full_path: String) -> AsyncTask<RestoreTask> {
    AsyncTask::new(RestoreTask { original: original_full_path })
}

/// Poll until every `source` path is gone from disk (the OS finished the move
/// and removed it) or a backstop elapses. Pure observation — no deletion — so it
/// cannot cause data loss. Returns the sources that are gone. Exits early when
/// all are removed (the common case finishes in well under a second for small
/// moves); the cap only stops the worker lingering on a very large transfer, in
/// which case the app's filesystem watcher reconciles the final tree state.
fn wait_sources_removed(sources: Vec<String>) -> Vec<String> {
    use std::path::Path;
    use std::time::{Duration, Instant};
    if sources.is_empty() {
        return Vec::new();
    }
    let start = Instant::now();
    let cap = Duration::from_secs(300); // 5-minute backstop; early-exits when done
    loop {
        let gone: Vec<String> = sources
            .iter()
            .filter(|p| !Path::new(p).exists())
            .cloned()
            .collect();
        if gone.len() == sources.len() || start.elapsed() >= cap {
            // Audit the async external move once it settles (Phase 5): the OS
            // performed an optimized move and removed each source itself. The
            // disposition is left blank — unlike the sync path we did NOT recycle
            // it, so undo can't assume a Recycle Bin restore — but the original
            // path is recorded so a future undo at least knows what moved.
            for path in &gone {
                crate::audit::record(crate::audit::Entry {
                    op: "external-move",
                    src: std::slice::from_ref(path),
                    ..Default::default()
                });
            }
            return gone;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Result of showing the native shell context menu.
#[napi(object)]
pub struct ContextMenuResult {
    /// A FileTree action the renderer must handle itself because the shell can't:
    ///   "rename"       — start inline rename of the item
    ///   "new-folder"   — create a new folder in the target dir
    ///   "open-new-tab" — open the folder in a new tab
    /// Empty when the shell already handled the chosen command (Open, Copy, Cut,
    /// Delete, Properties, Send to, third-party verbs, …) or the menu was dismissed.
    pub verb: String,
}

/// Show the real Windows shell context menu (`IContextMenu`) for `paths` at the
/// current cursor position — the same menu Explorer/TreeSize show, including
/// third-party extensions (CrowdStrike, Git, Visual Studio, "Send to", …).
///
/// Runs SYNCHRONOUSLY on the caller's thread, which MUST be Electron's main/UI
/// thread. That thread is an STA already initialized by Electron, so any UI a
/// verb raises (Properties, "Open with", …) lives on that apartment and is
/// pumped by the app's message loop. On a background thread the STA tears down
/// the instant the call returns — killing the dialog (Properties did nothing) —
/// and a non-blocking menu lets a second one open on top. `owner_hwnd` parents
/// any such UI to FileTree. Blocks (modally) only while the menu is interacted
/// with, exactly like every Win32 app's context menu.
#[napi]
pub fn show_context_menu_native(
    paths: Vec<String>,
    owner_hwnd: f64,
) -> napi::Result<ContextMenuResult> {
    #[cfg(windows)]
    {
        let verb = windows_impl::show_context_menu(paths, owner_hwnd as i64 as isize)
            .map_err(napi::Error::from_reason)?;
        Ok(ContextMenuResult { verb })
    }
    #[cfg(not(windows))]
    {
        let _ = (paths, owner_hwnd);
        Err(napi::Error::from_reason(
            "filetree-drag is only supported on Windows",
        ))
    }
}

// ── Integrated terminal (PTY) ─────────────────────────────────────────────────
// A real pseudo-terminal per session via portable-pty (ConPTY on Windows). The
// Electron main process spawns a shell here, polls `pty_read` on a short timer to
// drain output to the renderer's xterm.js, and forwards keystrokes via
// `pty_write`. Keeping this in the existing Rust addon reuses the cargo build
// pipeline instead of pulling in node-pty's node-gyp / Electron-ABI build.
use napi::bindgen_prelude::Buffer;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    buf: Vec<u8>,
    exit: Option<i32>,
    done: bool,
}

fn pty_sessions() -> &'static Mutex<HashMap<u32, PtySession>> {
    static SESSIONS: OnceLock<Mutex<HashMap<u32, PtySession>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

static NEXT_PTY_ID: AtomicU32 = AtomicU32::new(1);

/// A drained chunk of terminal output, plus the exit code delivered exactly once
/// after the shell has exited and all buffered output has been read.
#[napi(object)]
pub struct PtyChunk {
    pub data: Buffer,
    pub exit: Option<i32>,
}

/// Spawn `program args…` in a new pseudo-terminal sized `cols`×`rows`, starting in
/// `cwd`. Returns an id used by the read/write/resize/kill calls below.
#[napi]
pub fn pty_spawn(
    program: String,
    args: Vec<String>,
    cwd: String,
    cols: u16,
    rows: u16,
) -> napi::Result<u32> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| napi::Error::from_reason(format!("openpty failed: {e}")))?;

    let mut cmd = CommandBuilder::new(&program);
    for a in &args {
        cmd.arg(a);
    }
    if !cwd.is_empty() {
        cmd.cwd(&cwd);
    }
    // Inherit the parent environment so PATH, USERPROFILE, … are present.
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| napi::Error::from_reason(format!("spawn failed: {e}")))?;
    drop(pair.slave);

    let killer = child.clone_killer();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| napi::Error::from_reason(format!("clone reader failed: {e}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| napi::Error::from_reason(format!("take writer failed: {e}")))?;

    let id = NEXT_PTY_ID.fetch_add(1, Ordering::Relaxed);
    pty_sessions().lock().unwrap().insert(
        id,
        PtySession {
            master: pair.master,
            writer,
            killer,
            buf: Vec::new(),
            exit: None,
            done: false,
        },
    );

    // Drain the pty off-thread into the session buffer so the shell never blocks
    // on a full pipe; the main process collects it via `pty_read`. On Windows the
    // ConPTY read side stays open until the master is dropped, so a read EOF here
    // means the session was removed (after the exit code was delivered).
    std::thread::spawn(move || {
        let mut tmp = [0u8; 16384];
        loop {
            match reader.read(&mut tmp) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut map = pty_sessions().lock().unwrap();
                    match map.get_mut(&id) {
                        Some(s) => s.buf.extend_from_slice(&tmp[..n]),
                        None => break,
                    }
                }
            }
        }
    });

    // Wait for the shell to exit on its own thread — ConPTY won't EOF the reader
    // while we hold the master. A short grace period lets the reader drain any
    // trailing output before the exit code is surfaced through `pty_read`.
    std::thread::spawn(move || {
        let code = child.wait().map(|st| st.exit_code() as i32).unwrap_or(-1);
        std::thread::sleep(std::time::Duration::from_millis(60));
        let mut map = pty_sessions().lock().unwrap();
        if let Some(s) = map.get_mut(&id) {
            s.exit = Some(code);
            s.done = true;
        }
    });

    Ok(id)
}

/// Drain buffered output for `id`. Returns the bytes produced since the previous
/// call; once the shell has exited and its output is fully drained, returns the
/// exit code and removes the session.
#[napi]
pub fn pty_read(id: u32) -> napi::Result<PtyChunk> {
    let mut map = pty_sessions().lock().unwrap();
    let s = match map.get_mut(&id) {
        Some(s) => s,
        None => return Ok(PtyChunk { data: Buffer::from(Vec::new()), exit: None }),
    };
    let data = std::mem::take(&mut s.buf);
    if s.done && data.is_empty() {
        let code = s.exit.unwrap_or(-1);
        map.remove(&id);
        return Ok(PtyChunk { data: Buffer::from(Vec::new()), exit: Some(code) });
    }
    Ok(PtyChunk { data: Buffer::from(data), exit: None })
}

/// Send keystrokes / pasted text to the shell.
#[napi]
pub fn pty_write(id: u32, data: Buffer) -> napi::Result<()> {
    let mut map = pty_sessions().lock().unwrap();
    if let Some(s) = map.get_mut(&id) {
        s.writer
            .write_all(data.as_ref())
            .map_err(|e| napi::Error::from_reason(format!("write failed: {e}")))?;
        s.writer
            .flush()
            .map_err(|e| napi::Error::from_reason(format!("flush failed: {e}")))?;
    }
    Ok(())
}

/// Resize the pseudo-terminal to `cols`×`rows` character cells.
#[napi]
pub fn pty_resize(id: u32, cols: u16, rows: u16) -> napi::Result<()> {
    let map = pty_sessions().lock().unwrap();
    if let Some(s) = map.get(&id) {
        s.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| napi::Error::from_reason(format!("resize failed: {e}")))?;
    }
    Ok(())
}

/// Terminate the shell. The reader thread observes EOF, records the exit code,
/// and the session is removed on the next `pty_read`.
#[napi]
pub fn pty_kill(id: u32) -> napi::Result<()> {
    let mut map = pty_sessions().lock().unwrap();
    if let Some(s) = map.get_mut(&id) {
        let _ = s.killer.kill();
    }
    Ok(())
}

#[cfg(windows)]
mod windows_impl {
    use super::DragResult;
    use std::ffi::c_void;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows::core::{implement, w, Interface, HRESULT, PCSTR, PCWSTR, PSTR};
    use windows::Win32::Foundation::{
        BOOL, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, HINSTANCE, HWND,
        LPARAM, LRESULT, POINT, S_OK, WPARAM,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IDataObject, CLSCTX_ALL,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Ole::{
        IDropSource, IDropSource_Impl, OleInitialize, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_MOVE,
        DROPEFFECT_NONE,
    };
    use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
    use windows::Win32::System::Threading::GetCurrentProcessId;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{
        FileOperation, IContextMenu, IContextMenu2, IDataObjectAsyncCapability, IFileOperation,
        IShellFolder, IShellItem, SHBindToParent, SHCreateItemFromParsingName,
        SHCreateShellItemArrayFromIDLists, SHDoDragDrop, SHParseDisplayName, BHID_DataObject,
        CMF_CANRENAME, CMF_EXPLORE, CMF_NORMAL, CMINVOKECOMMANDINFO, FOF_ALLOWUNDO, FOF_NO_UI,
        FOF_WANTNUKEWARNING, FOFX_ADDUNDORECORD, FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE,
        GCS_VERBA, IShellItemArray,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        AppendMenuW, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu, DestroyWindow,
        GetCursorPos, GetForegroundWindow, GetWindowLongPtrW, GetWindowThreadProcessId, LoadCursorW,
        MessageBoxW, PostMessageW, RegisterClassW, SetCursor, SetForegroundWindow,
        SetWindowLongPtrW, TrackPopupMenuEx, WindowFromPoint, GWLP_USERDATA, HMENU, IDC_ARROW,
        IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_SETFOREGROUND, MB_YESNO, MF_SEPARATOR, MF_STRING,
        SW_SHOWNORMAL, TPM_RETURNCMD, TPM_RIGHTBUTTON, WINDOW_EX_STYLE, WM_DRAWITEM,
        WM_INITMENUPOPUP, WM_MEASUREITEM, WM_NULL, WNDCLASSW, WS_POPUP,
    };

    fn to_wide(value: &str) -> Vec<u16> {
        Path::new(value).as_os_str().encode_wide().chain(once(0)).collect()
    }

    /// Frees a list of absolute PIDLs allocated by `SHParseDisplayName`.
    unsafe fn free_pidls(pidls: &[*mut ITEMIDLIST]) {
        for &pidl in pidls {
            if !pidl.is_null() {
                CoTaskMemFree(Some(pidl as *const c_void));
            }
        }
    }

    /// Custom drop source so we own the feedback cursor.
    ///
    /// `SHDoDragDrop`'s default source paints whatever effect the drop *target*
    /// reports. When the pointer is over one of our own Chromium windows,
    /// Chromium reports `DROPEFFECT_NONE` (it can't finish an internal drop while
    /// our modal loop blocks its UI thread), so the OS shows a misleading
    /// "no-drop" (X) cursor even though we complete the move ourselves on release.
    ///
    /// Over our own windows we force a plain arrow; over everything else we defer
    /// to the OS cursors so external copy/move/no-drop feedback stays accurate.
    #[implement(IDropSource)]
    struct FeedbackDropSource;

    impl IDropSource_Impl for FeedbackDropSource_Impl {
        fn QueryContinueDrag(
            &self,
            fescapepressed: BOOL,
            grfkeystate: MODIFIERKEYS_FLAGS,
        ) -> HRESULT {
            // MK_LBUTTON: the left mouse button is still held.
            const MK_LBUTTON: u32 = 0x0001;
            if fescapepressed.as_bool() {
                return DRAGDROP_S_CANCEL;
            }
            if grfkeystate.0 & MK_LBUTTON == 0 {
                return DRAGDROP_S_DROP;
            }
            S_OK
        }

        fn GiveFeedback(&self, _dweffect: DROPEFFECT) -> HRESULT {
            unsafe {
                let mut pt = POINT::default();
                if GetCursorPos(&mut pt).is_ok() && !point_is_external(pt) {
                    if let Ok(cursor) = LoadCursorW(None, IDC_ARROW) {
                        let _ = SetCursor(cursor);
                    }
                    return S_OK;
                }
            }
            DRAGDROP_S_USEDEFAULTCURSORS
        }
    }

    pub fn drag(paths: Vec<String>) -> Result<DragResult, String> {
        let existing: Vec<String> = paths
            .into_iter()
            .filter(|p| !p.is_empty() && Path::new(p).exists())
            .collect();
        if existing.is_empty() {
            return Err("no existing paths to drag".to_string());
        }

        unsafe {
            // OLE is already initialized on Electron's UI thread; calling again
            // returns S_FALSE which is fine. We deliberately never uninitialize
            // (it would tear down the process-wide apartment and break Electron).
            let _ = OleInitialize(None);

            // Parse each path into an absolute PIDL.
            let mut pidls: Vec<*mut ITEMIDLIST> = Vec::with_capacity(existing.len());
            for path in &existing {
                let wide = to_wide(path);
                let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
                let hr = SHParseDisplayName(PCWSTR(wide.as_ptr()), None, &mut pidl, 0, None);
                if hr.is_err() || pidl.is_null() {
                    free_pidls(&pidls);
                    return Err(format!("SHParseDisplayName failed for {path}"));
                }
                pidls.push(pidl);
            }

            let const_pidls: Vec<*const ITEMIDLIST> =
                pidls.iter().map(|p| *p as *const ITEMIDLIST).collect();

            // Build a shell IShellItemArray, then a shell IDataObject (provides
            // CFSTR_SHELLIDLIST / CF_HDROP that Explorer and Chromium understand).
            let item_array: IShellItemArray = match SHCreateShellItemArrayFromIDLists(&const_pidls) {
                Ok(arr) => arr,
                Err(e) => {
                    free_pidls(&pidls);
                    return Err(format!("SHCreateShellItemArrayFromIDLists failed: {e}"));
                }
            };

            let data_object: IDataObject =
                match item_array.BindToHandler(None, &BHID_DataObject) {
                    Ok(obj) => obj,
                    Err(e) => {
                        free_pidls(&pidls);
                        return Err(format!("BindToHandler(BHID_DataObject) failed: {e}"));
                    }
                };

            // Ask the shell data object to transfer ASYNCHRONOUSLY. When the drop
            // target (Explorer) honors this it performs the copy on its OWN
            // thread, so `SHDoDragDrop` returns right after the drop *gesture*
            // instead of blocking our UI thread for the entire transfer — that
            // blocking is what froze the whole app during a big external drag.
            // The shell's own data object already implements
            // IDataObjectAsyncCapability (it is agile and correctly drives
            // StartOperation/EndOperation with the target), so we enable async on
            // it directly rather than wrapping it in a custom IDataObject (which
            // would be far riskier). If the QI or SetAsyncMode fails we simply
            // fall back to the synchronous path below — unchanged and safe.
            let async_enabled = match data_object.cast::<IDataObjectAsyncCapability>() {
                Ok(async_cap) => async_cap.SetAsyncMode(BOOL(1)).is_ok(),
                Err(_) => false,
            };

            // Allow both copy and move; the user's modifier keys + the target
            // decide which actually happens.
            let allowed = DROPEFFECT(DROPEFFECT_COPY.0 | DROPEFFECT_MOVE.0);

            // Supply our own drop source so we control the feedback cursor over
            // our own windows. SHDoDragDrop still builds the drag image from the
            // data object regardless of the source we pass.
            let drop_source: IDropSource = FeedbackDropSource.into();
            let effect = SHDoDragDrop(HWND::default(), &data_object, &drop_source, allowed)
                .unwrap_or(DROPEFFECT_NONE);

            // Classify the drop. Capture the drop point + button state first.
            let mut pt = POINT::default();
            let have_point = GetCursorPos(&mut pt).is_ok();
            let l_button_down = (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0;
            let is_external = have_point && point_is_external(pt);
            let is_move = (effect.0 & DROPEFFECT_MOVE.0) != 0;

            let mut deleted: Vec<String> = Vec::new();
            let mut deferred = false;
            let outcome = if l_button_down {
                // Button still held => the drag was cancelled (Esc).
                "cancel"
            } else if is_external {
                if is_move {
                    if async_enabled {
                        // ASYNC move: the OS is still copying on its own thread,
                        // so deleting the source now would race (or precede) the
                        // copy and risk data loss. We delete NOTHING here. For
                        // real shell items dropped on Explorer the shell performs
                        // an *optimized move* and removes the source itself once
                        // its progress dialog finishes; the caller observes that
                        // via `confirm_external_move` (which only watches, never
                        // deletes) and rescans when the transfer settles.
                        deferred = true;
                        "external-move"
                    } else {
                        // SYNC fallback (async not honored): `SHDoDragDrop` blocked
                        // until the whole copy completed, so the copy is confirmed
                        // and removing the source now completes a true move. Route
                        // BOTH files and directories through the shell engine so the
                        // source goes to the Recycle Bin (recoverable) — files used
                        // to be a permanent `DeleteFileW`, the data-loss this fixes.
                        for path in &existing {
                            let removed = if Path::new(path).exists() {
                                shell_recycle(path)
                            } else {
                                false
                            };
                            if removed {
                                // Audit the source removal half of a true external
                                // move (Phase 5). It went to the Recycle Bin, so a
                                // future undo can attempt a Recycle Bin restore.
                                crate::audit::record(crate::audit::Entry {
                                    op: "external-move",
                                    disposition: "recycle",
                                    src: std::slice::from_ref(path),
                                    ..Default::default()
                                });
                                deleted.push(path.clone());
                            }
                        }
                        "external-move"
                    }
                } else {
                    "external-copy"
                }
            } else {
                // Dropped over one of our own windows: let the renderer move it.
                "internal"
            };

            free_pidls(&pidls);
            drop(data_object);
            drop(item_array);

            Ok(DragResult {
                outcome: outcome.to_string(),
                drop_x: pt.x,
                drop_y: pt.y,
                deleted,
                deferred,
            })
        }
    }

    /// Recycle a moved-out source — file OR directory — after an external target
    /// already received its copy, completing a true move. Uses the shell file
    /// engine (`IFileOperation`): it recurses a whole tree, copes with long paths
    /// / junctions, and sends the item to the Recycle Bin so a mistaken move
    /// stays recoverable. The flags force recoverability:
    ///   • `FOFX_RECYCLEONDELETE` — recycle even when the item would otherwise be
    ///     permanently deleted (large items, etc.),
    ///   • `FOFX_ADDUNDORECORD`  — push it onto the Win8+ session undo stack,
    ///   • `FOF_WANTNUKEWARNING` — warn rather than silently destroy anything that
    ///     truly can't be recycled,
    ///   • `FOF_ALLOWUNDO`       — undoable, and `FOF_NO_UI` keeps it silent.
    /// Runs on the UI thread, which is already an OLE/STA apartment (see `drag`).
    /// Returns whether the source is gone afterward. On shell-engine failure it
    /// deliberately does NOT fall back to a permanent `remove_dir_all`: that would
    /// silently destroy the source. Leaving it in place degrades the move to a
    /// copy (recoverable), so it just reports failure.
    fn shell_recycle(path: &str) -> bool {
        let shelled = (|| -> windows::core::Result<()> {
            unsafe {
                let op: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL)?;
                op.SetOperationFlags(
                    FOF_NO_UI
                        | FOF_ALLOWUNDO
                        | FOFX_RECYCLEONDELETE
                        | FOFX_ADDUNDORECORD
                        | FOF_WANTNUKEWARNING,
                )?;
                let wide = to_wide(path);
                let item: IShellItem =
                    SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None)?;
                op.DeleteItem(&item, None)?;
                op.PerformOperations()?;
                Ok(())
            }
        })();
        match shelled {
            Ok(()) if !Path::new(path).exists() => true,
            Ok(()) => false, // engine reported success but the item is still there
            Err(e) => {
                eprintln!(
                    "[filetree-drag] shell recycle failed for {path:?}: {e}; \
                     leaving source in place (move degraded to copy)"
                );
                false
            }
        }
    }

    /// Per-item outcome of a batch move, surfaced to JS via `MoveResult` so the
    /// renderer can react to a partial move instead of assuming success.
    pub struct MoveOutcome {
        /// User cancelled / the op was aborted in the native dialog.
        pub aborted: bool,
        /// Queued sources gone from their origin afterward (true moves).
        pub moved: u32,
        /// Sources skipped before the op as no-ops/unsafe.
        pub skipped: u32,
        /// Queued sources still present afterward (failure or dialog "Skip").
        pub failed: u32,
    }

    /// Move `sources` into `dest` with the shell file-operation engine, showing
    /// the native Windows progress/conflict dialogs. Runs on a libuv worker
    /// thread (see `MoveTask`), so it initializes COM as STA for *this* thread
    /// and pairs it with `CoUninitialize`. Returns per-item counts + whether the
    /// user aborted; per-item *messages* are still shown by the native UI.
    pub fn move_items(sources: Vec<String>, dest: String, owner: isize) -> Result<MoveOutcome, String> {
        let existing: Vec<String> = sources
            .into_iter()
            .filter(|p| !p.is_empty() && Path::new(p).exists())
            .collect();
        if existing.is_empty() {
            return Err("no existing paths to move".to_string());
        }
        if dest.trim().is_empty() {
            return Err("no destination".to_string());
        }

        unsafe {
            // Fresh worker thread → initialize COM as STA (an STA is required for
            // the shell file-operation UI to pump its modal dialog). PerformOperations
            // runs that modal loop on this thread; Electron's main thread is free.
            let did_init = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
            let result = move_items_inner(&existing, &dest, owner);
            if did_init {
                CoUninitialize();
            }
            result
        }
    }

    unsafe fn move_items_inner(existing: &[String], dest: &str, owner: isize) -> Result<MoveOutcome, String> {
        let op: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL)
            .map_err(|e| format!("CoCreateInstance(FileOperation) failed: {e}"))?;

        // Recoverable moves: FOF_ALLOWUNDO routes anything the operation displaces
        // or overwrites through the Recycle Bin (matching `shell_recycle`), so
        // even a move that would clobber an existing item stays undoable instead
        // of being a permanent loss. FOFX_EARLYFAILURE keeps the batch atomic-ish:
        // it stops at the first failure rather than pressing on through a
        // half-broken batch. We deliberately do NOT add FOF_NO_UI or
        // FOF_NOCONFIRMATION here — the native progress dialog and the collision
        // prompt must still appear exactly as before.
        op.SetOperationFlags(FOF_ALLOWUNDO | FOFX_EARLYFAILURE)
            .map_err(|e| format!("SetOperationFlags failed: {e}"))?;

        // Parent the dialogs to FileTree's window so they're modal to the app.
        // Fall back to the foreground window if no handle was supplied.
        let owner_hwnd = if owner != 0 {
            HWND(owner as *mut std::ffi::c_void)
        } else {
            GetForegroundWindow()
        };
        if owner_hwnd != HWND::default() {
            let _ = op.SetOwnerWindow(owner_hwnd);
        }

        let dest_wide = to_wide(dest);
        let dest_item: IShellItem = SHCreateItemFromParsingName(PCWSTR(dest_wide.as_ptr()), None)
            .map_err(|e| format!("destination not found ({dest}): {e}"))?;

        let dest_path = Path::new(dest);
        // Track the actual sources we queued so we can report a real per-item
        // outcome (moved vs. still-present) after the operation runs.
        let mut queued_srcs: Vec<&String> = Vec::new();
        let mut skipped = 0u32;
        for src in existing {
            // No-op / unsafe guard, mirroring the renderer's `isNoOpMove` and the
            // HTTP server's canonicalized check: never queue a move whose source
            // is already at the destination, whose destination sits inside the
            // source (moving a folder into its own descendant), or whose source
            // already lives directly in `dest`. Such a move does nothing — and on
            // a name collision could destroy the source — so we skip it outright.
            if is_noop_move(Path::new(src), dest_path) {
                skipped += 1;
                continue;
            }

            let src_wide = to_wide(src);
            let src_item: IShellItem =
                match SHCreateItemFromParsingName(PCWSTR(src_wide.as_ptr()), None) {
                    Ok(item) => item,
                    Err(_) => continue, // skip anything that vanished
                };
            // psznewname = null → keep the original name and let the shell raise
            // its native collision prompt. null progress sink.
            if op
                .MoveItem(&src_item, &dest_item, PCWSTR::null(), None)
                .is_ok()
            {
                queued_srcs.push(src);
            }
        }
        if queued_srcs.is_empty() {
            // Everything was a no-op (already in place / self-targeted): that is a
            // success with nothing to do, not a failure. Only report an error when
            // there was something real to move but none of it could be queued.
            if skipped > 0 {
                return Ok(MoveOutcome { aborted: false, moved: 0, skipped, failed: 0 });
            }
            return Err("no items could be queued for the move".to_string());
        }

        // PerformOperations runs the modal progress/conflict UI. Any per-item
        // failure or cancel is surfaced *by that native UI*, so we don't turn it
        // into a JS exception (that would double-report). The renderer rescans
        // afterward to reflect whatever actually happened on disk.
        let _ = op.PerformOperations();
        let aborted = op
            .GetAnyOperationsAborted()
            .map(|b| b.as_bool())
            .unwrap_or(false);

        // Post-hoc per-item result: a queued source that's gone from its origin
        // moved successfully; one still present either errored or was "Skip"-ed
        // in the native collision dialog. (Without a progress sink this is the
        // reliable signal, and it's enough for the renderer to react to partials.)
        let mut moved = 0u32;
        let mut failed = 0u32;
        for src in &queued_srcs {
            if Path::new(src).exists() {
                failed += 1;
            } else {
                moved += 1;
                // Audit the actual data mutation (Phase 5). Record the exact
                // src -> dst (dest dir + original name) so a future undo can move
                // it back. We only log items that truly moved; a queued item left
                // in place changed nothing on disk.
                let name = Path::new(src)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let dst = dest_path.join(&name).to_string_lossy().into_owned();
                crate::audit::record(crate::audit::Entry {
                    op: "move",
                    src: std::slice::from_ref(*src),
                    dst: &dst,
                    ..Default::default()
                });
            }
        }
        Ok(MoveOutcome { aborted, moved, skipped, failed })
    }

    /// True when moving `src` into the folder `dest` would do nothing meaningful
    /// — or would be unsafe. Mirrors the renderer's `isNoOpMove` and the HTTP
    /// server's canonicalized guard. Returns true when ANY of these hold:
    ///   • the source is already at its effective target (`dest\<name>`),
    ///   • that effective target is the source or one of its descendants (i.e.
    ///     dropping a folder onto itself or into its own subtree), or
    ///   • the source already lives directly in `dest`.
    /// Paths are compared via `canonicalize` when possible (so symlinks, 8.3
    /// names and `.`/`..` collapse), degrading to a normalized case-insensitive
    /// string compare when a path can't be canonicalized (e.g. the effective
    /// target does not exist yet).
    fn is_noop_move(src: &Path, dest: &Path) -> bool {
        // Normalize a path to a comparable string: prefer the canonical on-disk
        // form (minus Windows' `\\?\` / `\\?\UNC\` verbatim prefix), else the raw
        // path; then unify separators, drop a trailing separator, and lowercase.
        fn norm(p: &Path) -> String {
            let raw = std::fs::canonicalize(p)
                .map(|c| c.to_string_lossy().into_owned())
                .unwrap_or_else(|_| p.to_string_lossy().into_owned());
            let stripped = raw
                .strip_prefix(r"\\?\UNC\")
                .map(|rest| format!(r"\\{rest}"))
                .or_else(|| raw.strip_prefix(r"\\?\").map(|rest| rest.to_string()))
                .unwrap_or(raw);
            stripped
                .replace('/', "\\")
                .trim_end_matches('\\')
                .to_lowercase()
        }

        let Some(name) = src.file_name() else {
            return false; // no file name (e.g. a drive root) -> nothing sensible
        };
        let src_n = norm(src);
        let dest_n = norm(dest);
        // Build the effective target from the (normalized) dest + source name so
        // it stays consistent: `dest\name` usually doesn't exist yet and so can't
        // be canonicalized directly.
        let eff_n = format!("{dest_n}\\{}", name.to_string_lossy().to_lowercase());

        // (1) source already exactly at the effective destination.
        if src_n == eff_n {
            return true;
        }
        // (2) effective target is the source itself or a descendant of it.
        if eff_n.starts_with(&format!("{src_n}\\")) {
            return true;
        }
        // (3) source already lives directly in `dest`.
        if let Some(parent) = src.parent() {
            if norm(parent) == dest_n {
                return true;
            }
        }
        false
    }

    /// True if `pt` is over a window owned by another process (a real external
    /// drop target), false if it is over one of our own windows or unknown.
    unsafe fn point_is_external(pt: POINT) -> bool {
        let hwnd = WindowFromPoint(pt);
        if hwnd == HWND::default() {
            return false;
        }
        let mut target_pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut target_pid));
        if target_pid == 0 {
            return false;
        }
        target_pid != GetCurrentProcessId()
    }

    // ── Native shell context menu ─────────────────────────────────────────────

    // FileTree's own items use IDs *above* the shell command range (the shell
    // gets [SHELL_ID_FIRST, 0x7FFF]), so a returned id is trivial to classify.
    const SHELL_ID_FIRST: u32 = 1;
    const FT_NEW_FOLDER: u32 = 0x9001;
    const FT_OPEN_NEW_TAB: u32 = 0x9002;

    static MENU_CLASS_ONCE: std::sync::Once = std::sync::Once::new();
    const MENU_CLASS: PCWSTR = w!("FileTreeShellMenuHost");

    /// Hidden host-window proc. Forwards menu-init / owner-draw messages to the
    /// shell's `IContextMenu2` so dynamic submenus ("Send to", "New", "Open
    /// with") populate and icons render. The `IContextMenu2` pointer lives in
    /// GWLP_USERDATA for the lifetime of the popup.
    unsafe extern "system" fn menu_host_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_INITMENUPOPUP || msg == WM_DRAWITEM || msg == WM_MEASUREITEM {
            let raw = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut c_void;
            if !raw.is_null() {
                if let Some(cm2) = IContextMenu2::from_raw_borrowed(&raw) {
                    let _ = cm2.HandleMenuMsg(msg, wparam, lparam);
                    return LRESULT(0);
                }
            }
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    unsafe fn ensure_menu_class(hinstance: HINSTANCE) {
        MENU_CLASS_ONCE.call_once(|| {
            let wc = WNDCLASSW {
                lpfnWndProc: Some(menu_host_proc),
                hInstance: hinstance,
                lpszClassName: MENU_CLASS,
                ..Default::default()
            };
            let _ = RegisterClassW(&wc);
        });
    }

    /// Resolve `paths` (those that share a parent folder) into the parent
    /// `IShellFolder` plus the child PIDLs the shell needs to build a context
    /// menu. The returned child pointers borrow into `owned` (absolute PIDLs),
    /// which the caller must keep alive until the menu closes, then `free_pidls`.
    unsafe fn resolve_menu_items(
        paths: &[String],
    ) -> Result<(IShellFolder, Vec<*const ITEMIDLIST>, Vec<*mut ITEMIDLIST>), String> {
        let first_parent = Path::new(&paths[0]).parent().map(|p| p.to_path_buf());
        let mut owned: Vec<*mut ITEMIDLIST> = Vec::new();
        let mut children: Vec<*const ITEMIDLIST> = Vec::new();
        let mut folder: Option<IShellFolder> = None;

        for p in paths {
            // A single IContextMenu can't span parents, so only group items that
            // live in the same folder (the common multi-select case).
            if Path::new(p).parent().map(|x| x.to_path_buf()) != first_parent {
                continue;
            }
            let wide = to_wide(p);
            let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
            if SHParseDisplayName(PCWSTR(wide.as_ptr()), None, &mut pidl, 0, None).is_err()
                || pidl.is_null()
            {
                continue;
            }
            // windows-rs returns the parent folder directly (IID inferred); the
            // child PIDL points *into* `pidl`, so `pidl` must outlive its use.
            let mut child: *mut ITEMIDLIST = std::ptr::null_mut();
            match SHBindToParent::<IShellFolder>(pidl, Some(&mut child)) {
                Ok(this_folder) if !child.is_null() => {
                    if folder.is_none() {
                        folder = Some(this_folder);
                    }
                    // else: `this_folder` drops here → releases the duplicate ref.
                    owned.push(pidl);
                    children.push(child as *const ITEMIDLIST);
                }
                _ => {
                    CoTaskMemFree(Some(pidl as *const c_void));
                }
            }
        }

        match folder {
            Some(f) if !children.is_empty() => Ok((f, children, owned)),
            _ => {
                free_pidls(&owned);
                Err("could not resolve shell items for context menu".to_string())
            }
        }
    }

    pub fn show_context_menu(paths: Vec<String>, owner: isize) -> Result<String, String> {
        let existing: Vec<String> = paths
            .into_iter()
            .filter(|p| !p.is_empty() && Path::new(p).exists())
            .collect();
        if existing.is_empty() {
            return Err("no existing paths for context menu".to_string());
        }
        unsafe {
            // We're on Electron's main/UI thread — already an OLE/STA apartment.
            // Calling again returns S_FALSE (harmless); we deliberately NEVER
            // uninitialize: that would tear down the process-wide apartment (and
            // kill any dialog a verb just opened, e.g. Properties).
            let _ = OleInitialize(None);
            show_context_menu_inner(&existing, owner)
        }
    }

    unsafe fn show_context_menu_inner(existing: &[String], owner: isize) -> Result<String, String> {
        let (folder, children, owned) = resolve_menu_items(existing)?;

        // Child PIDLs borrow into `owned`; run the menu inside a closure and free
        // the PIDLs afterward no matter how it exits.
        let run = || -> Result<String, String> {
            let hinstance: HINSTANCE = GetModuleHandleW(None)
                .map(|h| HINSTANCE(h.0))
                .unwrap_or_default();
            ensure_menu_class(hinstance);

            let host = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                MENU_CLASS,
                MENU_CLASS,
                WS_POPUP,
                0,
                0,
                0,
                0,
                HWND::default(),
                HMENU::default(),
                hinstance,
                None,
            )
            .map_err(|e| format!("CreateWindowExW failed: {e}"))?;

            let owner_hwnd = if owner != 0 {
                HWND(owner as *mut c_void)
            } else {
                GetForegroundWindow()
            };

            let menu: IContextMenu = match folder.GetUIObjectOf(owner_hwnd, &children, None) {
                Ok(m) => m,
                Err(e) => {
                    let _ = DestroyWindow(host);
                    return Err(format!("GetUIObjectOf(IContextMenu) failed: {e}"));
                }
            };
            let menu2 = menu.cast::<IContextMenu2>().ok();

            let hmenu = CreatePopupMenu().map_err(|e| format!("CreatePopupMenu failed: {e}"))?;

            // FileTree's own items first (the shell can't supply these).
            let single_dir = existing.len() == 1 && Path::new(&existing[0]).is_dir();
            let mut index: u32 = 0;
            let _ = AppendMenuW(hmenu, MF_STRING, FT_NEW_FOLDER as usize, w!("New Folder"));
            index += 1;
            if single_dir {
                let _ =
                    AppendMenuW(hmenu, MF_STRING, FT_OPEN_NEW_TAB as usize, w!("Open in new tab"));
                index += 1;
            }
            let _ = AppendMenuW(hmenu, MF_SEPARATOR, 0, PCWSTR::null());
            index += 1;

            // The real shell items, appended after ours. CMF_CANRENAME makes the
            // shell include the "Rename" verb (only for a single item) — without
            // it Windows omits Rename entirely, since rename needs the host to do
            // the in-place edit (which we route back to FileTree's inline rename).
            let mut cmf = CMF_NORMAL | CMF_EXPLORE;
            if existing.len() == 1 {
                cmf |= CMF_CANRENAME;
            }
            let _ = menu.QueryContextMenu(hmenu, index, SHELL_ID_FIRST, 0x7FFF, cmf);

            // Stash IContextMenu2 so the host window can populate dynamic submenus.
            if let Some(ref m2) = menu2 {
                SetWindowLongPtrW(host, GWLP_USERDATA, m2.as_raw() as isize);
            }

            let mut pt = POINT::default();
            let _ = GetCursorPos(&mut pt);
            let _ = SetForegroundWindow(host);
            let cmd = TrackPopupMenuEx(
                hmenu,
                (TPM_RETURNCMD | TPM_RIGHTBUTTON).0,
                pt.x,
                pt.y,
                host,
                None,
            )
            .0;
            // MSDN's documented trick so the popup dismisses cleanly afterward.
            let _ = PostMessageW(host, WM_NULL, WPARAM(0), LPARAM(0));
            // Clear the stashed pointer before `menu2` drops.
            SetWindowLongPtrW(host, GWLP_USERDATA, 0);

            let verb = interpret_command(cmd, &menu, owner_hwnd, existing);

            let _ = DestroyMenu(hmenu);
            let _ = DestroyWindow(host);
            Ok(verb)
        };

        let result = run();
        free_pidls(&owned);
        result
    }

    /// Map the TrackPopupMenuEx result to a FileTree verb, invoking the shell
    /// command in place for anything the shell can handle itself. `paths` is the
    /// set of items the menu was shown for (used for the destructive-verb gate).
    unsafe fn interpret_command(
        cmd: i32,
        menu: &IContextMenu,
        owner: HWND,
        paths: &[String],
    ) -> String {
        if cmd <= 0 {
            return String::new();
        }
        let cmd = cmd as u32;
        if cmd == FT_NEW_FOLDER {
            return "new-folder".to_string();
        }
        if cmd == FT_OPEN_NEW_TAB {
            return "open-new-tab".to_string();
        }

        let offset = cmd - SHELL_ID_FIRST;

        // Resolve the canonical verb string for the chosen command. We use it to
        // bounce "rename" back to FileTree and to gate the destructive "delete".
        let mut verb = String::new();
        let mut buf = [0u8; 128];
        if menu
            .GetCommandString(
                offset as usize,
                GCS_VERBA,
                None,
                PSTR(buf.as_mut_ptr()),
                buf.len() as u32,
            )
            .is_ok()
        {
            let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
            verb = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
        }

        // The shell "rename" verb is a no-op outside an Explorer view, so bounce it
        // back to FileTree's own inline rename rather than invoking it.
        if verb == "rename" {
            return "rename".to_string();
        }

        // FileTree confirmation gate (Phase 4): the shell context-menu "delete"
        // verb otherwise bypasses every app-level guard. Confirm before invoking
        // it, and record the user-initiated delete to the audit log (Phase 5).
        //
        // "cut" is intentionally NOT gated: it mutates nothing on invoke — it
        // only marks a clipboard move that completes on a later paste, which
        // happens outside FileTree where we cannot intercept it. Prompting there
        // would add friction without adding safety, so it stays frictionless per
        // the balanced-friction policy.
        if verb == "delete" {
            if !confirm_shell_delete(paths, owner) {
                return String::new(); // user declined → don't invoke the shell verb
            }
            // The shell "delete" verb defaults to the Recycle Bin. We don't get a
            // per-item result back from InvokeCommand, so this is a best-effort
            // record of the user-initiated delete.
            crate::audit::record(crate::audit::Entry {
                op: "delete",
                disposition: "recycle",
                src: paths,
                ..Default::default()
            });
        }

        let info = CMINVOKECOMMANDINFO {
            cbSize: std::mem::size_of::<CMINVOKECOMMANDINFO>() as u32,
            hwnd: owner,
            lpVerb: PCSTR(offset as usize as *const u8),
            nShow: SW_SHOWNORMAL.0,
            ..Default::default()
        };
        let _ = menu.InvokeCommand(&info);
        String::new()
    }

    /// Modal Yes/No confirmation shown before invoking the destructive shell
    /// "delete" verb. Returns true only when the user explicitly chose Yes.
    /// "No" is the default button so an accidental Enter/Space cancels safely.
    unsafe fn confirm_shell_delete(paths: &[String], owner: HWND) -> bool {
        let detail = match paths.len() {
            0 => "Delete the selected item?".to_string(),
            1 => format!("Delete \"{}\"?", paths[0]),
            n => format!("Delete these {n} items?"),
        };
        let body = format!("{detail}\n\nThey will be moved to the Recycle Bin.");
        let text: Vec<u16> = body.encode_utf16().chain(once(0)).collect();
        let caption: Vec<u16> = "FileTree".encode_utf16().chain(once(0)).collect();
        let result = MessageBoxW(
            owner,
            PCWSTR(text.as_ptr()),
            PCWSTR(caption.as_ptr()),
            MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2 | MB_SETFOREGROUND,
        );
        result == IDYES
    }

    // Keep the Interface import meaningful across windows-rs versions.
    #[allow(dead_code)]
    fn _assert_interface<T: Interface>() {}
}
