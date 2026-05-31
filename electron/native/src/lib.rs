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

/// Result of a native drag, surfaced to the Electron main process.
#[napi(object)]
pub struct DragResult {
    /// "external-move" | "external-copy" | "internal" | "cancel"
    pub outcome: String,
    /// Drop point in *physical* screen pixels (valid for "internal").
    pub drop_x: i32,
    pub drop_y: i32,
    /// Source paths deleted as part of an external move.
    pub deleted: Vec<String>,
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
    type Output = bool;
    type JsValue = MoveResult;

    fn compute(&mut self) -> napi::Result<bool> {
        #[cfg(windows)]
        {
            let sources = std::mem::take(&mut self.sources);
            let dest = std::mem::take(&mut self.dest);
            windows_impl::move_items(sources, dest, self.owner).map_err(napi::Error::from_reason)
        }
        #[cfg(not(windows))]
        {
            Err(napi::Error::from_reason(
                "filetree-drag is only supported on Windows",
            ))
        }
    }

    fn resolve(&mut self, _env: Env, aborted: bool) -> napi::Result<MoveResult> {
        Ok(MoveResult { aborted })
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
#[napi(ts_return_type = "Promise<{ aborted: boolean }>")]
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
    use windows::Win32::Storage::FileSystem::DeleteFileW;
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
        FileOperation, IContextMenu, IContextMenu2, IFileOperation, IShellFolder, IShellItem,
        SHBindToParent, SHCreateItemFromParsingName, SHCreateShellItemArrayFromIDLists,
        SHDoDragDrop, SHParseDisplayName, BHID_DataObject, CMF_CANRENAME, CMF_EXPLORE, CMF_NORMAL,
        CMINVOKECOMMANDINFO, GCS_VERBA, IShellItemArray,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        AppendMenuW, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu, DestroyWindow,
        GetCursorPos, GetForegroundWindow, GetWindowLongPtrW, GetWindowThreadProcessId, LoadCursorW,
        PostMessageW, RegisterClassW, SetCursor, SetForegroundWindow, SetWindowLongPtrW,
        TrackPopupMenuEx, WindowFromPoint, GWLP_USERDATA, HMENU, IDC_ARROW, MF_SEPARATOR, MF_STRING,
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
            let outcome = if l_button_down {
                // Button still held => the drag was cancelled (Esc).
                "cancel"
            } else if is_external {
                if is_move {
                    for path in &existing {
                        // Files only (the renderer restricts native drag to files).
                        if Path::new(path).is_file() {
                            let wide = to_wide(path);
                            if DeleteFileW(PCWSTR(wide.as_ptr())).is_ok() {
                                deleted.push(path.clone());
                            }
                        }
                    }
                    "external-move"
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
            })
        }
    }

    /// Move `sources` into `dest` with the shell file-operation engine, showing
    /// the native Windows progress/conflict dialogs. Runs on a libuv worker
    /// thread (see `MoveTask`), so it initializes COM as STA for *this* thread
    /// and pairs it with `CoUninitialize`. Returns whether the user aborted;
    /// per-item failures are reported by the native UI, not here.
    pub fn move_items(sources: Vec<String>, dest: String, owner: isize) -> Result<bool, String> {
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

    unsafe fn move_items_inner(existing: &[String], dest: &str, owner: isize) -> Result<bool, String> {
        let op: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL)
            .map_err(|e| format!("CoCreateInstance(FileOperation) failed: {e}"))?;

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

        let mut queued = 0u32;
        for src in existing {
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
                queued += 1;
            }
        }
        if queued == 0 {
            return Err("no items could be queued for the move".to_string());
        }

        // PerformOperations runs the modal progress/conflict UI. Any per-item
        // failure or cancel is surfaced *by that native UI*, so we don't turn it
        // into a JS exception (that would double-report). The renderer rescans
        // afterward to reflect whatever actually happened on disk.
        let _ = op.PerformOperations();
        Ok(op
            .GetAnyOperationsAborted()
            .map(|b| b.as_bool())
            .unwrap_or(false))
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

            let verb = interpret_command(cmd, &menu, owner_hwnd);

            let _ = DestroyMenu(hmenu);
            let _ = DestroyWindow(host);
            Ok(verb)
        };

        let result = run();
        free_pidls(&owned);
        result
    }

    /// Map the TrackPopupMenuEx result to a FileTree verb, invoking the shell
    /// command in place for anything the shell can handle itself.
    unsafe fn interpret_command(cmd: i32, menu: &IContextMenu, owner: HWND) -> String {
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

        // The shell "rename" verb is a no-op outside an Explorer view, so bounce it
        // back to FileTree's own inline rename rather than invoking it.
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
            let verb = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
            if verb == "rename" {
                return "rename".to_string();
            }
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

    // Keep the Interface import meaningful across windows-rs versions.
    #[allow(dead_code)]
    fn _assert_interface<T: Interface>() {}
}
