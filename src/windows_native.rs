#[cfg(windows)]
use std::collections::HashMap;
#[cfg(windows)]
use std::path::Path;
#[cfg(windows)]
use std::sync::{Arc, Condvar, Mutex, OnceLock};

#[derive(Debug)]
pub(crate) struct NativeDragResult {
    pub(crate) outcome: String,
    pub(crate) drop_x: i32,
    pub(crate) drop_y: i32,
}

#[cfg(windows)]
pub(crate) fn native_drag_files(paths: Vec<String>) -> Result<NativeDragResult, String> {
    use std::ffi::c_void;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::{
        BOOL, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, HWND, POINT, S_OK,
    };
    use windows::Win32::System::Com::{CoTaskMemFree, IDataObject};
    use windows::Win32::System::Ole::{
        DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_MOVE, DROPEFFECT_NONE, IDropSource,
        IDropSource_Impl, OleInitialize, OleUninitialize,
    };
    use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{
        BHID_DataObject, IShellItemArray, SHCreateShellItemArrayFromIDLists, SHDoDragDrop,
        SHParseDisplayName,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    use windows::core::{HRESULT, PCWSTR, implement};

    #[implement(IDropSource)]
    struct FileTreeDropSource;

    struct OleGuard(bool);

    impl Drop for OleGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe { OleUninitialize() };
            }
        }
    }

    impl IDropSource_Impl for FileTreeDropSource_Impl {
        fn QueryContinueDrag(
            &self,
            escape_pressed: BOOL,
            key_state: MODIFIERKEYS_FLAGS,
        ) -> HRESULT {
            const MK_LBUTTON: u32 = 0x0001;
            if escape_pressed.as_bool() {
                return DRAGDROP_S_CANCEL;
            }
            if key_state.0 & MK_LBUTTON == 0 {
                return DRAGDROP_S_DROP;
            }
            S_OK
        }

        fn GiveFeedback(&self, _effect: DROPEFFECT) -> HRESULT {
            DRAGDROP_S_USEDEFAULTCURSORS
        }
    }

    unsafe fn free_pidls(pidls: &[*mut ITEMIDLIST]) {
        for &pidl in pidls {
            if !pidl.is_null() {
                unsafe {
                    CoTaskMemFree(Some(pidl as *const c_void));
                }
            }
        }
    }

    let existing = paths
        .into_iter()
        .filter(|path| !path.is_empty() && Path::new(path).exists())
        .collect::<Vec<_>>();
    if existing.is_empty() {
        return Err("No existing paths to drag".to_string());
    }

    unsafe {
        // The Tauri UI thread already owns the mouse gesture. OLE may already be
        // initialized there; S_FALSE is expected and does not need special care.
        let _ole = OleGuard(OleInitialize(None).is_ok());
        let mut pidls = Vec::<*mut ITEMIDLIST>::with_capacity(existing.len());
        for path in &existing {
            let wide = Path::new(path)
                .as_os_str()
                .encode_wide()
                .chain(once(0))
                .collect::<Vec<_>>();
            let mut pidl = std::ptr::null_mut();
            if SHParseDisplayName(PCWSTR(wide.as_ptr()), None, &mut pidl, 0, None).is_err()
                || pidl.is_null()
            {
                free_pidls(&pidls);
                return Err(format!("Windows could not prepare {path} for dragging"));
            }
            pidls.push(pidl);
        }
        let pointers = pidls
            .iter()
            .map(|value| *value as *const ITEMIDLIST)
            .collect::<Vec<_>>();
        let items: IShellItemArray = match SHCreateShellItemArrayFromIDLists(&pointers) {
            Ok(value) => value,
            Err(error) => {
                free_pidls(&pidls);
                return Err(format!("Could not create the shell drag list: {error}"));
            }
        };
        let data: IDataObject = match items.BindToHandler(None, &BHID_DataObject) {
            Ok(value) => value,
            Err(error) => {
                free_pidls(&pidls);
                return Err(format!("Could not create the shell drag data: {error}"));
            }
        };
        let source: IDropSource = FileTreeDropSource.into();
        let allowed = DROPEFFECT(DROPEFFECT_COPY.0 | DROPEFFECT_MOVE.0);
        let effect =
            SHDoDragDrop(HWND::default(), &data, &source, allowed).unwrap_or(DROPEFFECT_NONE);
        let mut point = POINT::default();
        let _ = GetCursorPos(&mut point);
        let button_down = (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0;
        let outcome = if button_down {
            "cancel"
        } else if effect.0 & DROPEFFECT_MOVE.0 != 0 {
            "move"
        } else if effect.0 & DROPEFFECT_COPY.0 != 0 {
            "copy"
        } else {
            // FileTree's WebView cannot report a shell effect while this modal
            // drag loop owns its UI thread. The desktop command classifies this
            // as an internal drop when the release point is inside our window.
            "none"
        };
        free_pidls(&pidls);
        Ok(NativeDragResult {
            outcome: outcome.to_string(),
            drop_x: point.x,
            drop_y: point.y,
        })
    }
}

#[cfg(not(windows))]
pub(crate) fn native_drag_files(_paths: Vec<String>) -> Result<NativeDragResult, String> {
    Err("Native file dragging is only available on Windows".to_string())
}

#[derive(Debug, Default)]
pub(crate) struct NativeMoveResult {
    pub(crate) aborted: bool,
    pub(crate) moved: usize,
    pub(crate) skipped: usize,
    pub(crate) failed: usize,
}

#[derive(Debug, Default)]
pub(crate) struct ClipboardFilesResult {
    pub(crate) paths: Vec<String>,
    pub(crate) prefer_move: bool,
}

/// Move files/folders through the same `IFileOperation` engine Explorer uses.
/// Because `FOF_SILENT` is deliberately absent, Windows supplies its normal
/// progress, collision, cancellation, and elevation UI for non-trivial moves.
#[cfg(windows)]
pub(crate) fn native_move_files(
    paths: Vec<String>,
    destination: String,
    owner_handle: isize,
) -> Result<NativeMoveResult, String> {
    native_transfer_files(paths, destination, owner_handle, true)
}

/// Copy files/folders through Explorer's `IFileOperation` engine.
#[cfg(windows)]
pub(crate) fn native_copy_files(
    paths: Vec<String>,
    destination: String,
    owner_handle: isize,
) -> Result<NativeMoveResult, String> {
    native_transfer_files(paths, destination, owner_handle, false)
}

#[cfg(windows)]
fn native_transfer_files(
    paths: Vec<String>,
    destination: String,
    owner_handle: isize,
    move_items: bool,
) -> Result<NativeMoveResult, String> {
    use std::ffi::c_void;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
    use windows::Win32::System::Ole::{OleInitialize, OleUninitialize};
    use windows::Win32::UI::Shell::{
        COPYENGINE_E_CANCELLED, COPYENGINE_E_USER_CANCELLED, COPYENGINE_S_ALREADY_DONE,
        COPYENGINE_S_USER_IGNORED, FILEOPERATION_FLAGS, FOF_ALLOWUNDO, FOF_NOCONFIRMMKDIR,
        FOF_WANTNUKEWARNING, FOFX_ADDUNDORECORD, FOFX_RECYCLEONDELETE, FOFX_SHOWELEVATIONPROMPT,
        FileOperation, IFileOperation, IFileOperationProgressSink, IFileOperationProgressSink_Impl,
        IShellItem, SHCreateItemFromParsingName,
    };
    use windows::core::{HRESULT, PCWSTR, implement};

    struct OleGuard(bool);
    impl Drop for OleGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe { OleUninitialize() };
            }
        }
    }

    #[derive(Clone, Copy)]
    enum ItemTransferOutcome {
        Completed,
        Skipped,
        Failed,
    }

    #[implement(IFileOperationProgressSink)]
    struct TransferProgressSink {
        outcome: Arc<Mutex<Option<ItemTransferOutcome>>>,
    }

    impl TransferProgressSink {
        fn record(&self, status: HRESULT) {
            let outcome = if status == COPYENGINE_S_USER_IGNORED
                || status == COPYENGINE_S_ALREADY_DONE
                || status == COPYENGINE_E_USER_CANCELLED
                || status == COPYENGINE_E_CANCELLED
            {
                ItemTransferOutcome::Skipped
            } else if status.is_ok() {
                ItemTransferOutcome::Completed
            } else {
                ItemTransferOutcome::Failed
            };
            if let Ok(mut current) = self.outcome.lock() {
                // A folder operation can report descendants through the same
                // item sink. Its top-level Post* callback is last, so retaining
                // the latest status yields the requested item's true outcome.
                *current = Some(outcome);
            }
        }
    }

    impl IFileOperationProgressSink_Impl for TransferProgressSink_Impl {
        fn StartOperations(&self) -> windows::core::Result<()> {
            Ok(())
        }

        fn FinishOperations(&self, _result: HRESULT) -> windows::core::Result<()> {
            Ok(())
        }

        fn PreRenameItem(
            &self,
            _flags: u32,
            _item: Option<&IShellItem>,
            _new_name: &PCWSTR,
        ) -> windows::core::Result<()> {
            Ok(())
        }

        fn PostRenameItem(
            &self,
            _flags: u32,
            _item: Option<&IShellItem>,
            _new_name: &PCWSTR,
            _result: HRESULT,
            _new_item: Option<&IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }

        fn PreMoveItem(
            &self,
            _flags: u32,
            _item: Option<&IShellItem>,
            _destination: Option<&IShellItem>,
            _new_name: &PCWSTR,
        ) -> windows::core::Result<()> {
            Ok(())
        }

        fn PostMoveItem(
            &self,
            _flags: u32,
            _item: Option<&IShellItem>,
            _destination: Option<&IShellItem>,
            _new_name: &PCWSTR,
            result: HRESULT,
            _new_item: Option<&IShellItem>,
        ) -> windows::core::Result<()> {
            self.record(result);
            Ok(())
        }

        fn PreCopyItem(
            &self,
            _flags: u32,
            _item: Option<&IShellItem>,
            _destination: Option<&IShellItem>,
            _new_name: &PCWSTR,
        ) -> windows::core::Result<()> {
            Ok(())
        }

        fn PostCopyItem(
            &self,
            _flags: u32,
            _item: Option<&IShellItem>,
            _destination: Option<&IShellItem>,
            _new_name: &PCWSTR,
            result: HRESULT,
            _new_item: Option<&IShellItem>,
        ) -> windows::core::Result<()> {
            self.record(result);
            Ok(())
        }

        fn PreDeleteItem(
            &self,
            _flags: u32,
            _item: Option<&IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }

        fn PostDeleteItem(
            &self,
            _flags: u32,
            _item: Option<&IShellItem>,
            _result: HRESULT,
            _new_item: Option<&IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }

        fn PreNewItem(
            &self,
            _flags: u32,
            _destination: Option<&IShellItem>,
            _new_name: &PCWSTR,
        ) -> windows::core::Result<()> {
            Ok(())
        }

        fn PostNewItem(
            &self,
            _flags: u32,
            _destination: Option<&IShellItem>,
            _new_name: &PCWSTR,
            _template_name: &PCWSTR,
            _file_attributes: u32,
            _result: HRESULT,
            _new_item: Option<&IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }

        fn UpdateProgress(&self, _total: u32, _completed: u32) -> windows::core::Result<()> {
            Ok(())
        }

        fn ResetTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }

        fn PauseTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }

        fn ResumeTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }
    }

    fn path_key(path: &Path) -> String {
        std::fs::canonicalize(path)
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_ascii_lowercase()
    }

    fn within(candidate: &Path, parent: &Path) -> bool {
        let candidate = path_key(candidate);
        let parent = path_key(parent);
        candidate == parent
            || candidate
                .strip_prefix(&parent)
                .is_some_and(|suffix| suffix.starts_with('/'))
    }

    fn shell_item(path: &Path) -> windows::core::Result<IShellItem> {
        let wide = path
            .as_os_str()
            .encode_wide()
            .chain(once(0))
            .collect::<Vec<_>>();
        unsafe { SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None) }
    }

    let owner = HWND(owner_handle as *mut c_void);
    if owner.is_invalid() {
        return Err("The FileTree window is unavailable".to_string());
    }
    let destination_path = Path::new(&destination);
    if !destination_path.is_dir() {
        return Err(format!("Destination is not a folder: {destination}"));
    }

    let _ole = OleGuard(unsafe { OleInitialize(None) }.is_ok());
    let destination_item = shell_item(destination_path)
        .map_err(|error| format!("Windows could not open the destination: {error}"))?;
    let operation_name = if move_items { "move" } else { "copy" };
    let operation: IFileOperation =
        unsafe { CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER) }
            .map_err(|error| format!("Windows could not start the {operation_name}: {error}"))?;
    unsafe { operation.SetOwnerWindow(owner) }.map_err(|error| {
        format!("Windows could not attach the {operation_name} dialog: {error}")
    })?;
    let flags = FILEOPERATION_FLAGS(
        FOF_ALLOWUNDO.0
            | FOF_NOCONFIRMMKDIR.0
            | FOF_WANTNUKEWARNING.0
            | FOFX_ADDUNDORECORD.0
            | FOFX_RECYCLEONDELETE.0
            | FOFX_SHOWELEVATIONPROMPT.0,
    );
    unsafe { operation.SetOperationFlags(flags) }
        .map_err(|error| format!("Windows could not configure the {operation_name}: {error}"))?;

    let mut result = NativeMoveResult::default();
    let mut queued = Vec::new();
    for path_text in paths {
        let source = Path::new(&path_text);
        let Some(name) = source.file_name() else {
            result.failed += 1;
            continue;
        };
        if std::fs::symlink_metadata(source).is_err() {
            result.failed += 1;
            continue;
        }
        let target = destination_path.join(name);
        if path_key(source) == path_key(&target) {
            result.skipped += 1;
            continue;
        }
        if source.is_dir() && within(destination_path, source) {
            result.failed += 1;
            continue;
        }
        let source_item = match shell_item(source) {
            Ok(item) => item,
            Err(_) => {
                result.failed += 1;
                continue;
            }
        };
        let target_existed = target.exists();
        let item_outcome = Arc::new(Mutex::new(None));
        let progress_sink: IFileOperationProgressSink = TransferProgressSink {
            outcome: Arc::clone(&item_outcome),
        }
        .into();
        let queued_item = unsafe {
            if move_items {
                operation.MoveItem(
                    &source_item,
                    &destination_item,
                    PCWSTR::null(),
                    Some(&progress_sink),
                )
            } else {
                operation.CopyItem(
                    &source_item,
                    &destination_item,
                    PCWSTR::null(),
                    Some(&progress_sink),
                )
            }
        };
        if queued_item.is_err() {
            result.failed += 1;
            continue;
        }
        queued.push((
            path_text,
            target,
            target_existed,
            item_outcome,
            progress_sink,
        ));
    }

    if queued.is_empty() {
        return Ok(result);
    }
    let perform_error = unsafe { operation.PerformOperations() }.err();
    result.aborted = unsafe { operation.GetAnyOperationsAborted() }
        .map(|value| value.as_bool())
        .unwrap_or(false);
    for (source, target, target_existed, item_outcome, _progress_sink) in queued {
        let sink_outcome = item_outcome.lock().ok().and_then(|outcome| *outcome);
        match sink_outcome {
            Some(ItemTransferOutcome::Completed) => {
                result.moved += 1;
                continue;
            }
            Some(ItemTransferOutcome::Skipped) => {
                result.skipped += 1;
                continue;
            }
            Some(ItemTransferOutcome::Failed) => {
                result.failed += 1;
                continue;
            }
            None => {}
        }
        // A progress sink should always report queued items. If an older shell
        // extension omits the callback, never infer completion from a partial
        // destination left by a canceled operation or from a pre-existing
        // overwrite target.
        if result.aborted {
            result.skipped += 1;
        } else if (move_items && std::fs::symlink_metadata(&source).is_err())
            || (perform_error.is_none() && !target_existed && target.exists())
        {
            result.moved += 1;
        } else {
            result.failed += 1;
        }
    }
    if let Some(error) = perform_error
        && !result.aborted
        && result.moved == 0
    {
        return Err(format!(
            "Windows could not complete the {operation_name}: {error}"
        ));
    }
    Ok(result)
}

#[cfg(not(windows))]
pub(crate) fn native_move_files(
    _paths: Vec<String>,
    _destination: String,
    _owner_handle: isize,
) -> Result<NativeMoveResult, String> {
    Err("Native file moves are only available on Windows".to_string())
}

#[cfg(not(windows))]
pub(crate) fn native_copy_files(
    _paths: Vec<String>,
    _destination: String,
    _owner_handle: isize,
) -> Result<NativeMoveResult, String> {
    Err("Native file copies are only available on Windows".to_string())
}

#[cfg(windows)]
pub(crate) fn clipboard_write_files(
    paths: Vec<String>,
    owner_handle: isize,
    cut: bool,
) -> Result<bool, String> {
    use std::ffi::{OsStr, c_void};
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::{BOOL, GlobalFree, HANDLE, HGLOBAL, HWND, POINT};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GHND, GlobalAlloc, GlobalLock, GlobalUnlock};
    use windows::Win32::System::Ole::{CF_HDROP, DROPEFFECT_COPY, DROPEFFECT_MOVE};
    use windows::Win32::UI::Shell::DROPFILES;
    use windows::core::w;

    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            let _ = unsafe { CloseClipboard() };
        }
    }

    struct GlobalMemory(Option<HGLOBAL>);
    impl GlobalMemory {
        fn handle(&self) -> HGLOBAL {
            self.0.expect("global clipboard memory")
        }
        fn release(&mut self) {
            self.0 = None;
        }
    }
    impl Drop for GlobalMemory {
        fn drop(&mut self) {
            if let Some(memory) = self.0 {
                // GlobalFree's generated Result interpretation is inverted for
                // the API's NULL-on-success contract, but the call still frees.
                let _ = unsafe { GlobalFree(memory) };
            }
        }
    }

    fn allocate_bytes(bytes: &[u8]) -> Result<GlobalMemory, String> {
        let memory = unsafe { GlobalAlloc(GHND, bytes.len()) }
            .map_err(|error| format!("Could not allocate clipboard memory: {error}"))?;
        let target = unsafe { GlobalLock(memory) }.cast::<u8>();
        if target.is_null() {
            let _ = unsafe { GlobalFree(memory) };
            return Err("Could not lock clipboard memory".to_string());
        }
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), target, bytes.len());
            let _ = GlobalUnlock(memory);
        }
        Ok(GlobalMemory(Some(memory)))
    }

    fn open(owner: HWND) -> Result<ClipboardGuard, String> {
        let mut last_error = String::new();
        for _ in 0..30 {
            match unsafe { OpenClipboard(owner) } {
                Ok(()) => return Ok(ClipboardGuard),
                Err(error) => {
                    last_error = error.to_string();
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
        }
        Err(format!("Windows clipboard is busy: {last_error}"))
    }

    let selected = paths
        .into_iter()
        .filter(|path| !path.is_empty() && Path::new(path).exists())
        .collect::<Vec<_>>();
    if selected.is_empty() {
        return Ok(false);
    }

    let mut file_list = Vec::<u16>::new();
    for path in &selected {
        file_list.extend(OsStr::new(path).encode_wide().chain(once(0)));
    }
    file_list.push(0);
    let header_size = std::mem::size_of::<DROPFILES>();
    let list_bytes = file_list
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .ok_or_else(|| "Clipboard selection is too large".to_string())?;
    let total_size = header_size
        .checked_add(list_bytes)
        .ok_or_else(|| "Clipboard selection is too large".to_string())?;
    let mut payload = vec![0u8; total_size];
    let drop_files = DROPFILES {
        pFiles: header_size as u32,
        pt: POINT { x: 0, y: 0 },
        fNC: BOOL(0),
        fWide: BOOL(1),
    };
    unsafe {
        std::ptr::write_unaligned(payload.as_mut_ptr().cast::<DROPFILES>(), drop_files);
        std::ptr::copy_nonoverlapping(
            file_list.as_ptr().cast::<u8>(),
            payload.as_mut_ptr().add(header_size),
            list_bytes,
        );
    }

    let mut file_memory = allocate_bytes(&payload)?;
    let effect = if cut {
        DROPEFFECT_MOVE.0
    } else {
        DROPEFFECT_COPY.0
    };
    let mut effect_memory = allocate_bytes(&effect.to_ne_bytes())?;
    let owner = HWND(owner_handle as *mut c_void);
    let _clipboard = open(owner)?;
    unsafe { EmptyClipboard() }
        .map_err(|error| format!("Could not clear the Windows clipboard: {error}"))?;
    unsafe { SetClipboardData(CF_HDROP.0 as u32, HANDLE(file_memory.handle().0)) }
        .map_err(|error| format!("Could not copy files to the Windows clipboard: {error}"))?;
    file_memory.release();

    let effect_format = unsafe { RegisterClipboardFormatW(w!("Preferred DropEffect")) };
    if effect_format == 0
        || unsafe { SetClipboardData(effect_format, HANDLE(effect_memory.handle().0)) }.is_err()
    {
        // Do not leave an apparently valid Cut that lost its MOVE intent.
        let _ = unsafe { EmptyClipboard() };
        return Err("Could not set the clipboard file operation".to_string());
    }
    effect_memory.release();
    Ok(true)
}

#[cfg(not(windows))]
pub(crate) fn clipboard_write_files(
    _paths: Vec<String>,
    _owner_handle: isize,
    _cut: bool,
) -> Result<bool, String> {
    Err("File clipboard operations are only available on Windows".to_string())
}

#[cfg(windows)]
pub(crate) fn clipboard_read_files(owner_handle: isize) -> Result<ClipboardFilesResult, String> {
    use std::ffi::c_void;
    use windows::Win32::Foundation::{HGLOBAL, HWND};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
        RegisterClipboardFormatW,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows::Win32::System::Ole::{CF_HDROP, DROPEFFECT_MOVE};
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
    use windows::core::w;

    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            let _ = unsafe { CloseClipboard() };
        }
    }

    let owner = HWND(owner_handle as *mut c_void);
    let mut last_error = String::new();
    let _clipboard = {
        let mut opened = false;
        for _ in 0..30 {
            match unsafe { OpenClipboard(owner) } {
                Ok(()) => {
                    opened = true;
                    break;
                }
                Err(error) => {
                    last_error = error.to_string();
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
        }
        if !opened {
            return Err(format!("Windows clipboard is busy: {last_error}"));
        }
        ClipboardGuard
    };

    if unsafe { IsClipboardFormatAvailable(CF_HDROP.0 as u32) }.is_err() {
        return Ok(ClipboardFilesResult::default());
    }
    let data = unsafe { GetClipboardData(CF_HDROP.0 as u32) }
        .map_err(|error| format!("Could not read files from the Windows clipboard: {error}"))?;
    let drop = HDROP(data.0);
    let count = unsafe { DragQueryFileW(drop, u32::MAX, None) };
    if count > 1_000 {
        return Err("Clipboard contains more than 1,000 items".to_string());
    }
    let mut paths = Vec::with_capacity(count as usize);
    for index in 0..count {
        let length = unsafe { DragQueryFileW(drop, index, None) } as usize;
        if length == 0 || length > 32_767 {
            continue;
        }
        let mut buffer = vec![0u16; length + 1];
        let copied = unsafe { DragQueryFileW(drop, index, Some(&mut buffer)) } as usize;
        if copied > 0 {
            paths.push(String::from_utf16_lossy(&buffer[..copied]));
        }
    }

    let effect_format = unsafe { RegisterClipboardFormatW(w!("Preferred DropEffect")) };
    let prefer_move =
        if effect_format != 0 && unsafe { IsClipboardFormatAvailable(effect_format) }.is_ok() {
            unsafe { GetClipboardData(effect_format) }
                .ok()
                .and_then(|handle| {
                    let memory = HGLOBAL(handle.0);
                    if unsafe { GlobalSize(memory) } < std::mem::size_of::<u32>() {
                        return None;
                    }
                    let pointer = unsafe { GlobalLock(memory) }.cast::<u32>();
                    if pointer.is_null() {
                        return None;
                    }
                    let value = unsafe { std::ptr::read_unaligned(pointer) };
                    let _ = unsafe { GlobalUnlock(memory) };
                    Some(value & DROPEFFECT_MOVE.0 != 0)
                })
                .unwrap_or(false)
        } else {
            false
        };
    Ok(ClipboardFilesResult { paths, prefer_move })
}

#[cfg(not(windows))]
pub(crate) fn clipboard_read_files(_owner_handle: isize) -> Result<ClipboardFilesResult, String> {
    Err("File clipboard operations are only available on Windows".to_string())
}

#[cfg(windows)]
struct ShellMenuMessageBridge {
    menu3: Option<windows::Win32::UI::Shell::IContextMenu3>,
    menu2: Option<windows::Win32::UI::Shell::IContextMenu2>,
}

#[cfg(windows)]
unsafe extern "system" fn shell_menu_subclass_proc(
    hwnd: windows::Win32::Foundation::HWND,
    message: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
    _subclass_id: usize,
    reference_data: usize,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::LRESULT;
    use windows::Win32::UI::Shell::DefSubclassProc;
    use windows::Win32::UI::WindowsAndMessaging::{
        WM_DRAWITEM, WM_INITMENUPOPUP, WM_MEASUREITEM, WM_MENUCHAR,
    };

    if reference_data != 0
        && matches!(
            message,
            WM_INITMENUPOPUP | WM_DRAWITEM | WM_MEASUREITEM | WM_MENUCHAR
        )
    {
        let bridge = unsafe { &*(reference_data as *const ShellMenuMessageBridge) };
        if let Some(menu) = &bridge.menu3 {
            let mut result = LRESULT(0);
            if unsafe { menu.HandleMenuMsg2(message, wparam, lparam, Some(&mut result)) }.is_ok() {
                return result;
            }
        } else if let Some(menu) = &bridge.menu2
            && unsafe { menu.HandleMenuMsg(message, wparam, lparam) }.is_ok()
        {
            return LRESULT(0);
        }
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

#[cfg(windows)]
fn is_deferred_clipboard_verb(verb: &str, defer_paste: bool) -> bool {
    verb.eq_ignore_ascii_case("copy")
        || verb.eq_ignore_ascii_case("cut")
        || (defer_paste && verb.eq_ignore_ascii_case("paste"))
}

/// Display Explorer's classic "Show more options" context menu for physical
/// files/folders. Cascades remain lazy, matching Explorer instead of blocking
/// initial display while every submenu and Shift-only extension initializes.
#[cfg(windows)]
pub(crate) fn shell_context_menu(
    paths: Vec<String>,
    owner_handle: isize,
    screen_x: i32,
    screen_y: i32,
    defer_paste: bool,
) -> Result<Option<String>, String> {
    use std::ffi::c_void;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, POINT, WPARAM};
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::System::Ole::{OleInitialize, OleUninitialize};
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{
        CMF_ASYNCVERBSTATE, CMF_CANRENAME, CMF_EXPLORE, CMIC_MASK_PTINVOKE, CMINVOKECOMMANDINFO,
        CMINVOKECOMMANDINFOEX, GCS_VERBW, IContextMenu, IContextMenu2, IContextMenu3, IShellFolder,
        RemoveWindowSubclass, SHBindToParent, SHParseDisplayName, SetWindowSubclass,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        AppendMenuW, CreatePopupMenu, CreateWindowExW, DestroyMenu, DestroyWindow, HMENU,
        MF_SEPARATOR, MF_STRING, PostMessageW, SW_SHOWNORMAL, SetForegroundWindow, TPM_RETURNCMD,
        TPM_RIGHTBUTTON, TrackPopupMenuEx, WM_NULL, WS_EX_TOOLWINDOW, WS_POPUP,
    };
    use windows::core::{Interface, PCSTR, PCWSTR, PSTR, w};

    const MENU_ID_FIRST: u32 = 1;
    const MENU_ID_LAST: u32 = 0x7fff;
    // Shell verbs own MENU_ID_FIRST..=MENU_ID_LAST. FileTree's explicit
    // Explorer action sits outside that range so it can never be mistaken for
    // an IContextMenu ordinal.
    const MENU_ID_OPEN_IN_EXPLORER: u32 = 0x8000;
    const SUBCLASS_ID: usize = 0x4654_434d;
    const CMIC_MASK_UNICODE: u32 = 0x0000_4000;

    struct OleGuard(bool);
    impl Drop for OleGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe { OleUninitialize() };
            }
        }
    }

    struct PidlGuard(Vec<*mut ITEMIDLIST>);
    impl Drop for PidlGuard {
        fn drop(&mut self) {
            for &pidl in &self.0 {
                if !pidl.is_null() {
                    unsafe { CoTaskMemFree(Some(pidl.cast::<c_void>())) };
                }
            }
        }
    }

    struct MenuGuard(windows::Win32::UI::WindowsAndMessaging::HMENU);
    impl Drop for MenuGuard {
        fn drop(&mut self) {
            let _ = unsafe { DestroyMenu(self.0) };
        }
    }

    struct ProxyWindow(HWND);
    impl Drop for ProxyWindow {
        fn drop(&mut self) {
            let _ = unsafe { DestroyWindow(self.0) };
        }
    }

    let owner = HWND(owner_handle as *mut c_void);
    if owner.is_invalid() {
        return Err("The FileTree window is unavailable".to_string());
    }

    let mut existing = paths
        .into_iter()
        .filter(|path| !path.is_empty())
        .collect::<Vec<_>>();
    if existing.is_empty() {
        return Err("No existing files or folders were selected".to_string());
    }

    // IShellFolder::GetUIObjectOf accepts a multi-selection only when every
    // child belongs to one parent folder. Keep the clicked item first and fall
    // back to that item alone if the FileTree selection crosses directories.
    let parent_key = |path: &str| {
        Path::new(path)
            .parent()
            .map(|parent| {
                parent
                    .to_string_lossy()
                    .replace('\\', "/")
                    .to_ascii_lowercase()
            })
            .unwrap_or_default()
    };
    let first_parent = parent_key(&existing[0]);
    if existing
        .iter()
        .skip(1)
        .any(|path| parent_key(path) != first_parent)
    {
        existing.truncate(1);
    }

    let _ole = OleGuard(unsafe { OleInitialize(None) }.is_ok());
    // This function runs on a dedicated STA worker. Keep every shell menu
    // callback on that worker by using a tiny local owner window; the real
    // FileTree HWND is still supplied when the selected command is invoked.
    let proxy = ProxyWindow(
        unsafe {
            CreateWindowExW(
                WS_EX_TOOLWINDOW,
                w!("STATIC"),
                w!(""),
                WS_POPUP,
                0,
                0,
                0,
                0,
                owner,
                HMENU::default(),
                HINSTANCE::default(),
                None,
            )
        }
        .map_err(|error| format!("Windows could not create a context-menu worker: {error}"))?,
    );
    let menu_owner = proxy.0;
    let mut pidls = PidlGuard(Vec::with_capacity(existing.len()));
    for path in &existing {
        let wide = Path::new(path)
            .as_os_str()
            .encode_wide()
            .chain(once(0))
            .collect::<Vec<_>>();
        let mut pidl = std::ptr::null_mut();
        unsafe { SHParseDisplayName(PCWSTR(wide.as_ptr()), None, &mut pidl, 0, None) }
            .map_err(|error| format!("Windows could not resolve {path}: {error}"))?;
        if pidl.is_null() {
            return Err(format!("Windows could not resolve {path}"));
        }
        pidls.0.push(pidl);
    }

    let mut parent_folder: Option<IShellFolder> = None;
    let mut children = Vec::<*const ITEMIDLIST>::with_capacity(pidls.0.len());
    for &pidl in &pidls.0 {
        let mut child = std::ptr::null_mut();
        let folder: IShellFolder = unsafe { SHBindToParent(pidl, Some(&mut child)) }
            .map_err(|error| format!("Windows could not open the containing folder: {error}"))?;
        if child.is_null() {
            return Err("Windows returned an invalid shell item".to_string());
        }
        if parent_folder.is_none() {
            parent_folder = Some(folder);
        }
        children.push(child);
    }

    let context: IContextMenu = unsafe {
        parent_folder
            .as_ref()
            .ok_or_else(|| "Windows could not resolve the containing folder".to_string())?
            .GetUIObjectOf(menu_owner, &children, None)
    }
    .map_err(|error| format!("Windows could not create the context menu: {error}"))?;
    let menu = MenuGuard(
        unsafe { CreatePopupMenu() }
            .map_err(|error| format!("Windows could not create the context menu: {error}"))?,
    );
    unsafe {
        context.QueryContextMenu(
            menu.0,
            0,
            MENU_ID_FIRST,
            MENU_ID_LAST,
            // Let supporting shell extensions evaluate expensive verb state in
            // the background instead of delaying the initial popup.
            CMF_EXPLORE | CMF_CANRENAME | CMF_ASYNCVERBSTATE,
        )
    }
    .map_err(|error| format!("Windows could not populate the context menu: {error}"))?;
    // Explorer's classic menu is extension-defined and does not reliably
    // expose "Open file location" for every item type or Windows version.
    // Always append one FileTree-owned action: files are selected in their
    // containing folder, while directories are opened directly.
    unsafe {
        AppendMenuW(menu.0, MF_SEPARATOR, 0, PCWSTR::null()).and_then(|_| {
            AppendMenuW(
                menu.0,
                MF_STRING,
                MENU_ID_OPEN_IN_EXPLORER as usize,
                w!("Open in File Explorer"),
            )
        })
    }
    .map_err(|error| format!("Windows could not add the Explorer menu item: {error}"))?;

    let bridge = Box::new(ShellMenuMessageBridge {
        menu3: context.cast::<IContextMenu3>().ok(),
        menu2: context.cast::<IContextMenu2>().ok(),
    });
    let subclassed = unsafe {
        SetWindowSubclass(
            menu_owner,
            Some(shell_menu_subclass_proc),
            SUBCLASS_ID,
            (&*bridge as *const ShellMenuMessageBridge) as usize,
        )
    }
    .as_bool();

    unsafe {
        let _ = SetForegroundWindow(owner);
    }
    let command = unsafe {
        TrackPopupMenuEx(
            menu.0,
            TPM_RETURNCMD.0 | TPM_RIGHTBUTTON.0,
            screen_x,
            screen_y,
            menu_owner,
            None,
        )
    }
    .0 as u32;
    if subclassed {
        unsafe {
            let _ = RemoveWindowSubclass(menu_owner, Some(shell_menu_subclass_proc), SUBCLASS_ID);
        }
    }
    // Required by TrackPopupMenu's foreground-window contract; without this,
    // dismissing one menu can make the next click immediately disappear.
    let _ = unsafe { PostMessageW(owner, WM_NULL, WPARAM(0), LPARAM(0)) };

    if command < MENU_ID_FIRST {
        // Destroy the worker-owned window while the bridge is still alive. This
        // keeps its callback pointer valid even if subclass removal ever fails.
        drop(proxy);
        drop(bridge);
        return Ok(None);
    }
    if command == MENU_ID_OPEN_IN_EXPLORER {
        let target = &existing[0];
        let open_result = if Path::new(target).is_dir() {
            crate::io::open_path(target)
        } else {
            crate::io::reveal_path(target)
        };
        drop(proxy);
        drop(bridge);
        open_result.map_err(|error| format!("Windows could not open File Explorer: {error}"))?;
        return Ok(Some("filetree_open_in_explorer".to_string()));
    }
    let command_offset = command - MENU_ID_FIRST;
    let mut verb_buffer = [0u16; 260];
    let verb = unsafe {
        context.GetCommandString(
            command_offset as usize,
            GCS_VERBW,
            None,
            PSTR(verb_buffer.as_mut_ptr().cast::<u8>()),
            verb_buffer.len() as u32,
        )
    }
    .ok()
    .and_then(|_| {
        let length = verb_buffer.iter().position(|value| *value == 0)?;
        (length > 0).then(|| String::from_utf16_lossy(&verb_buffer[..length]))
    });

    // Copy/Cut commonly use an OLE delayed-rendering data object tied to this
    // short-lived STA worker, so invoking them here can report success while
    // leaving an unusable clipboard after the worker exits. A workspace Paste
    // also needs FileTree's provenance-bound transfer accounting, while callers
    // without a contextual destination may leave Paste native. Return deferred
    // canonical verbs without invoking them; the renderer dispatches them
    // through the same concrete CF_HDROP and IFileOperation paths as shortcuts.
    if verb
        .as_deref()
        .is_some_and(|value| is_deferred_clipboard_verb(value, defer_paste))
    {
        drop(proxy);
        drop(bridge);
        return Ok(verb);
    }

    let ordinal_a = PCSTR(command_offset as usize as *const u8);
    let ordinal_w = PCWSTR(command_offset as usize as *const u16);
    let invoke = CMINVOKECOMMANDINFOEX {
        cbSize: std::mem::size_of::<CMINVOKECOMMANDINFOEX>() as u32,
        fMask: CMIC_MASK_UNICODE | CMIC_MASK_PTINVOKE,
        hwnd: owner,
        lpVerb: ordinal_a,
        lpVerbW: ordinal_w,
        nShow: SW_SHOWNORMAL.0,
        ptInvoke: POINT {
            x: screen_x,
            y: screen_y,
        },
        ..Default::default()
    };
    let invoke_result = unsafe {
        context
            .InvokeCommand((&invoke as *const CMINVOKECOMMANDINFOEX).cast::<CMINVOKECOMMANDINFO>())
    }
    .map_err(|error| format!("Windows could not run the selected command: {error}"));
    // Keep the context-menu owner and its message bridge alive until a native
    // verb finishes initializing. Always destroy the owner before the bridge in
    // case removing the subclass failed.
    drop(proxy);
    drop(bridge);
    invoke_result?;
    Ok(verb)
}

#[cfg(not(windows))]
pub(crate) fn shell_context_menu(
    _paths: Vec<String>,
    _owner_handle: isize,
    _screen_x: i32,
    _screen_y: i32,
    _defer_paste: bool,
) -> Result<Option<String>, String> {
    Err("The Windows shell context menu is only available on Windows".to_string())
}

#[cfg(windows)]
#[repr(C)]
struct DataBlob {
    size: u32,
    data: *mut u8,
}

#[cfg(windows)]
pub(crate) fn protect_secret(value: &[u8]) -> Result<Vec<u8>, String> {
    crypt_secret(value, true)
}

#[cfg(windows)]
pub(crate) fn unprotect_secret(value: &[u8]) -> Result<Vec<u8>, String> {
    crypt_secret(value, false)
}

#[cfg(windows)]
fn crypt_secret(value: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;
    #[link(name = "Crypt32")]
    unsafe extern "system" {
        fn CryptProtectData(
            input: *const DataBlob,
            description: *const u16,
            entropy: *const DataBlob,
            reserved: *mut std::ffi::c_void,
            prompt: *mut std::ffi::c_void,
            flags: u32,
            output: *mut DataBlob,
        ) -> i32;
        fn CryptUnprotectData(
            input: *const DataBlob,
            description: *mut *mut u16,
            entropy: *const DataBlob,
            reserved: *mut std::ffi::c_void,
            prompt: *mut std::ffi::c_void,
            flags: u32,
            output: *mut DataBlob,
        ) -> i32;
    }
    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn LocalFree(memory: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    }

    let input = DataBlob {
        size: value.len() as u32,
        data: value.as_ptr() as *mut u8,
    };
    let mut output = DataBlob {
        size: 0,
        data: std::ptr::null_mut(),
    };
    let ok = unsafe {
        if protect {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let bytes = unsafe { std::slice::from_raw_parts(output.data, output.size as usize).to_vec() };
    unsafe {
        LocalFree(output.data.cast());
    }
    Ok(bytes)
}

#[cfg(windows)]
pub(crate) fn set_keep_awake(active: bool) {
    static SENDER: OnceLock<std::sync::mpsc::Sender<bool>> = OnceLock::new();
    let sender = SENDER.get_or_init(|| {
        let (sender, receiver) = std::sync::mpsc::channel::<bool>();
        let _ = std::thread::Builder::new()
            .name("filetree-keep-awake".to_string())
            .spawn(move || {
                const ES_CONTINUOUS: u32 = 0x8000_0000;
                const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
                const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;
                #[link(name = "Kernel32")]
                unsafe extern "system" {
                    fn SetThreadExecutionState(flags: u32) -> u32;
                }
                while let Ok(active) = receiver.recv() {
                    let flags = if active {
                        ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
                    } else {
                        ES_CONTINUOUS
                    };
                    unsafe {
                        SetThreadExecutionState(flags);
                    }
                }
                unsafe {
                    SetThreadExecutionState(ES_CONTINUOUS);
                }
            });
        sender
    });
    let _ = sender.send(active);
}

#[cfg(windows)]
struct ImageCache {
    entries: HashMap<String, (Vec<u8>, u64)>,
    bytes: usize,
    tick: u64,
    max_bytes: usize,
}

#[cfg(windows)]
impl ImageCache {
    fn new(max_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            bytes: 0,
            tick: 0,
            max_bytes,
        }
    }

    fn get(&mut self, key: &str) -> Option<Vec<u8>> {
        self.tick = self.tick.wrapping_add(1);
        let entry = self.entries.get_mut(key)?;
        entry.1 = self.tick;
        Some(entry.0.clone())
    }

    fn insert(&mut self, key: String, value: Vec<u8>) {
        if value.len() > self.max_bytes {
            return;
        }
        if let Some((old, _)) = self.entries.remove(&key) {
            self.bytes = self.bytes.saturating_sub(old.len());
        }
        while self.bytes.saturating_add(value.len()) > self.max_bytes {
            let Some(victim) = self
                .entries
                .iter()
                .min_by_key(|(_, (_, tick))| *tick)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some((old, _)) = self.entries.remove(&victim) {
                self.bytes = self.bytes.saturating_sub(old.len());
            }
        }
        self.tick = self.tick.wrapping_add(1);
        self.bytes = self.bytes.saturating_add(value.len());
        self.entries.insert(key, (value, self.tick));
    }
}

#[cfg(windows)]
fn icon_cache() -> &'static Mutex<ImageCache> {
    static CACHE: OnceLock<Mutex<ImageCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(ImageCache::new(4 * 1024 * 1024)))
}

#[cfg(windows)]
fn thumbnail_cache() -> &'static Mutex<ImageCache> {
    static CACHE: OnceLock<Mutex<ImageCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(ImageCache::new(16 * 1024 * 1024)))
}

#[cfg(windows)]
struct ThumbnailPermit;

#[cfg(windows)]
impl Drop for ThumbnailPermit {
    fn drop(&mut self) {
        release_thumbnail_permit();
    }
}

#[cfg(windows)]
fn thumbnail_gate() -> &'static (Mutex<usize>, Condvar) {
    static GATE: OnceLock<(Mutex<usize>, Condvar)> = OnceLock::new();
    GATE.get_or_init(|| (Mutex::new(0), Condvar::new()))
}

#[cfg(windows)]
fn release_thumbnail_permit() {
    let (active, wake) = thumbnail_gate();
    let mut count = active.lock().unwrap_or_else(|error| error.into_inner());
    *count = count.saturating_sub(1);
    wake.notify_one();
}

#[cfg(windows)]
pub(crate) fn shell_icon_png(extension: &str) -> Option<Vec<u8>> {
    let key = extension.trim_start_matches('.').to_ascii_lowercase();
    if key.is_empty() {
        return None;
    }
    if let Some(hit) = icon_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(&key)
    {
        return Some(hit);
    }
    let image = render_shell_icon_png(&key)?;
    icon_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(key, image.clone());
    Some(image)
}

#[cfg(windows)]
pub(crate) fn shell_thumbnail_png(path: &str, size: i32, icon_fallback: bool) -> Option<Vec<u8>> {
    let size = size.clamp(16, 512);
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let key = format!(
        "{}|{}|{}|{}|{}",
        path.replace('\\', "/").to_ascii_lowercase(),
        metadata.len(),
        modified,
        size,
        icon_fallback
    );
    if let Some(hit) = thumbnail_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(&key)
    {
        return Some(hit);
    }
    let _permit = acquire_thumbnail_permit();
    let image = render_shell_thumbnail_png(path, size, icon_fallback)?;
    thumbnail_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(key, image.clone());
    Some(image)
}

#[cfg(windows)]
fn acquire_thumbnail_permit() -> ThumbnailPermit {
    let (active, wake) = thumbnail_gate();
    let mut count = active.lock().unwrap_or_else(|error| error.into_inner());
    while *count >= 2 {
        count = wake.wait(count).unwrap_or_else(|error| error.into_inner());
    }
    *count += 1;
    ThumbnailPermit
}

#[cfg(windows)]
const SHELL_ICON_SENTINEL: [u8; 4] = [3, 2, 1, 0];

#[cfg(windows)]
fn normalize_shell_icon_bgra(bgra: &mut [u8]) -> bool {
    let mut visible = false;
    for pixel in bgra.chunks_exact_mut(4) {
        if pixel == SHELL_ICON_SENTINEL {
            pixel.fill(0);
            continue;
        }
        if pixel[3] == 0 {
            // Legacy HICONs use an AND mask and often leave the alpha channel
            // unset even though DrawIconEx produced valid color pixels.
            pixel[3] = 255;
        }
        visible |= pixel[3] != 0;
    }
    visible
}

#[cfg(windows)]
#[allow(non_snake_case, non_camel_case_types)]
fn render_shell_icon_png(extension: &str) -> Option<Vec<u8>> {
    use std::ffi::c_void;
    const SHGFI_ICON: u32 = 0x0000_0100;
    const SHGFI_SMALLICON: u32 = 0x0000_0001;
    const SHGFI_USEFILEATTRIBUTES: u32 = 0x0000_0010;
    const FILE_ATTRIBUTE_NORMAL: u32 = 0x0000_0080;
    const DIB_RGB_COLORS: u32 = 0;
    const DI_NORMAL: u32 = 0x0003;
    const SIZE: i32 = 16;

    #[repr(C)]
    struct ShFileInfoW {
        hIcon: isize,
        iIcon: i32,
        dwAttributes: u32,
        szDisplayName: [u16; 260],
        szTypeName: [u16; 80],
    }
    #[repr(C)]
    struct BitmapInfoHeader {
        biSize: u32,
        biWidth: i32,
        biHeight: i32,
        biPlanes: u16,
        biBitCount: u16,
        biCompression: u32,
        biSizeImage: u32,
        biXPelsPerMeter: i32,
        biYPelsPerMeter: i32,
        biClrUsed: u32,
        biClrImportant: u32,
    }
    #[repr(C)]
    struct BitmapInfo {
        bmiHeader: BitmapInfoHeader,
        bmiColors: [u32; 1],
    }
    #[link(name = "Shell32")]
    unsafe extern "system" {
        fn SHGetFileInfoW(
            path: *const u16,
            attributes: u32,
            info: *mut ShFileInfoW,
            size: u32,
            flags: u32,
        ) -> usize;
    }
    #[link(name = "Gdi32")]
    unsafe extern "system" {
        fn CreateCompatibleDC(hdc: isize) -> isize;
        fn CreateDIBSection(
            hdc: isize,
            info: *const BitmapInfo,
            usage: u32,
            bits: *mut *mut c_void,
            section: *mut c_void,
            offset: u32,
        ) -> isize;
        fn SelectObject(hdc: isize, object: isize) -> isize;
        fn GetDIBits(
            hdc: isize,
            bitmap: isize,
            start: u32,
            lines: u32,
            bits: *mut c_void,
            info: *mut BitmapInfo,
            usage: u32,
        ) -> i32;
        fn DeleteDC(hdc: isize) -> i32;
        fn DeleteObject(object: isize) -> i32;
    }
    #[link(name = "User32")]
    unsafe extern "system" {
        fn DrawIconEx(
            hdc: isize,
            x: i32,
            y: i32,
            icon: isize,
            width: i32,
            height: i32,
            step: u32,
            brush: isize,
            flags: u32,
        ) -> i32;
        fn DestroyIcon(icon: isize) -> i32;
    }

    let wide: Vec<u16> = format!(".{extension}")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    unsafe {
        let mut info: ShFileInfoW = std::mem::zeroed();
        if SHGetFileInfoW(
            wide.as_ptr(),
            FILE_ATTRIBUTE_NORMAL,
            &mut info,
            std::mem::size_of::<ShFileInfoW>() as u32,
            SHGFI_ICON | SHGFI_SMALLICON | SHGFI_USEFILEATTRIBUTES,
        ) == 0
            || info.hIcon == 0
        {
            return None;
        }
        let dc = CreateCompatibleDC(0);
        if dc == 0 {
            DestroyIcon(info.hIcon);
            return None;
        }
        let bitmap_info = BitmapInfo {
            bmiHeader: BitmapInfoHeader {
                biSize: std::mem::size_of::<BitmapInfoHeader>() as u32,
                biWidth: SIZE,
                biHeight: -SIZE,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [0],
        };
        let mut bits = std::ptr::null_mut();
        let bitmap = CreateDIBSection(
            dc,
            &bitmap_info,
            DIB_RGB_COLORS,
            &mut bits,
            std::ptr::null_mut(),
            0,
        );
        if bitmap == 0 {
            DeleteDC(dc);
            DestroyIcon(info.hIcon);
            return None;
        }
        if bits.is_null() {
            DeleteObject(bitmap);
            DeleteDC(dc);
            DestroyIcon(info.hIcon);
            return None;
        }
        SelectObject(dc, bitmap);
        let pixels = std::slice::from_raw_parts_mut(bits.cast::<u8>(), (SIZE * SIZE * 4) as usize);
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.copy_from_slice(&SHELL_ICON_SENTINEL);
        }
        let drawn = DrawIconEx(dc, 0, 0, info.hIcon, SIZE, SIZE, 0, 0, DI_NORMAL);
        let mut bgra = vec![0u8; (SIZE * SIZE * 4) as usize];
        let mut read_info = bitmap_info;
        let rows = GetDIBits(
            dc,
            bitmap,
            0,
            SIZE as u32,
            bgra.as_mut_ptr().cast(),
            &mut read_info,
            DIB_RGB_COLORS,
        );
        DeleteObject(bitmap);
        DeleteDC(dc);
        DestroyIcon(info.hIcon);
        let visible = normalize_shell_icon_bgra(&mut bgra);
        if rows == 0 || drawn == 0 || !visible {
            return None;
        }
        Some(encode_bgra_png(SIZE, SIZE, &bgra))
    }
}

#[cfg(windows)]
#[allow(non_snake_case, non_camel_case_types)]
fn render_shell_thumbnail_png(path: &str, size: i32, icon_fallback: bool) -> Option<Vec<u8>> {
    use std::ffi::c_void;
    const IID_SHELL_ITEM: [u8; 16] = [
        0x1E, 0x6D, 0x82, 0x43, 0x18, 0xE7, 0xEE, 0x42, 0xBC, 0x55, 0xA1, 0xE2, 0x61, 0xC3, 0x7B,
        0xFE,
    ];
    const IID_IMAGE_FACTORY: [u8; 16] = [
        0x79, 0x8B, 0xC1, 0xBC, 0x16, 0xBA, 0x2F, 0x44, 0x80, 0xC4, 0x8A, 0x59, 0xC3, 0x0C, 0x46,
        0x3B,
    ];
    const SIIGBF_ICONONLY: u32 = 0x4;
    const SIIGBF_THUMBNAILONLY: u32 = 0x8;
    const DIB_RGB_COLORS: u32 = 0;
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Size {
        cx: i32,
        cy: i32,
    }
    #[repr(C)]
    struct BitmapInfoHeader {
        biSize: u32,
        biWidth: i32,
        biHeight: i32,
        biPlanes: u16,
        biBitCount: u16,
        biCompression: u32,
        biSizeImage: u32,
        biXPelsPerMeter: i32,
        biYPelsPerMeter: i32,
        biClrUsed: u32,
        biClrImportant: u32,
    }
    #[repr(C)]
    struct BitmapInfo {
        bmiHeader: BitmapInfoHeader,
        bmiColors: [u32; 1],
    }
    #[repr(C)]
    struct GdiBitmap {
        bmType: i32,
        bmWidth: i32,
        bmHeight: i32,
        bmWidthBytes: i32,
        bmPlanes: u16,
        bmBitsPixel: u16,
        bmBits: *mut c_void,
    }
    #[repr(C)]
    struct UnknownVtbl {
        query_interface:
            unsafe extern "system" fn(*mut c_void, *const [u8; 16], *mut *mut c_void) -> i32,
        add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
        release: unsafe extern "system" fn(*mut c_void) -> u32,
    }
    #[repr(C)]
    struct ImageFactoryVtbl {
        query_interface:
            unsafe extern "system" fn(*mut c_void, *const [u8; 16], *mut *mut c_void) -> i32,
        add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
        release: unsafe extern "system" fn(*mut c_void) -> u32,
        get_image: unsafe extern "system" fn(*mut c_void, Size, u32, *mut isize) -> i32,
    }
    #[link(name = "Shell32")]
    unsafe extern "system" {
        fn SHCreateItemFromParsingName(
            path: *const u16,
            bind: *mut c_void,
            iid: *const [u8; 16],
            value: *mut *mut c_void,
        ) -> i32;
    }
    #[link(name = "Ole32")]
    unsafe extern "system" {
        fn CoInitializeEx(reserved: *mut c_void, mode: u32) -> i32;
        fn CoUninitialize();
    }
    #[link(name = "Gdi32")]
    unsafe extern "system" {
        fn CreateCompatibleDC(hdc: isize) -> isize;
        #[link_name = "GetObjectW"]
        fn GetGdiObject(object: isize, size: i32, value: *mut c_void) -> i32;
        fn GetDIBits(
            hdc: isize,
            bitmap: isize,
            start: u32,
            lines: u32,
            bits: *mut c_void,
            info: *mut BitmapInfo,
            usage: u32,
        ) -> i32;
        fn DeleteDC(hdc: isize) -> i32;
        fn DeleteObject(object: isize) -> i32;
    }

    if !Path::new(path).exists() {
        return None;
    }
    let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    unsafe {
        let com_result = CoInitializeEx(std::ptr::null_mut(), 2);
        let should_uninitialize = com_result >= 0;
        let mut item = std::ptr::null_mut();
        if SHCreateItemFromParsingName(
            wide.as_ptr(),
            std::ptr::null_mut(),
            &IID_SHELL_ITEM,
            &mut item,
        ) < 0
            || item.is_null()
        {
            if should_uninitialize {
                CoUninitialize();
            }
            return None;
        }
        let unknown = *(item as *mut *mut UnknownVtbl);
        let mut factory = std::ptr::null_mut();
        let query = ((*unknown).query_interface)(item, &IID_IMAGE_FACTORY, &mut factory);
        if query < 0 || factory.is_null() {
            ((*unknown).release)(item);
            if should_uninitialize {
                CoUninitialize();
            }
            return None;
        }
        let factory_vtbl = *(factory as *mut *mut ImageFactoryVtbl);
        let requested = Size { cx: size, cy: size };
        let mut bitmap = 0isize;
        let mut result =
            ((*factory_vtbl).get_image)(factory, requested, SIIGBF_THUMBNAILONLY, &mut bitmap);
        if (result < 0 || bitmap == 0) && icon_fallback {
            bitmap = 0;
            result = ((*factory_vtbl).get_image)(factory, requested, SIIGBF_ICONONLY, &mut bitmap);
        }
        ((*factory_vtbl).release)(factory);
        ((*unknown).release)(item);
        if result < 0 || bitmap == 0 {
            if should_uninitialize {
                CoUninitialize();
            }
            return None;
        }
        let dc = CreateCompatibleDC(0);
        if dc == 0 {
            DeleteObject(bitmap);
            if should_uninitialize {
                CoUninitialize();
            }
            return None;
        }
        let mut dimensions: GdiBitmap = std::mem::zeroed();
        if GetGdiObject(
            bitmap,
            std::mem::size_of::<GdiBitmap>() as i32,
            (&mut dimensions as *mut GdiBitmap).cast(),
        ) == 0
        {
            DeleteDC(dc);
            DeleteObject(bitmap);
            if should_uninitialize {
                CoUninitialize();
            }
            return None;
        }
        let width = dimensions.bmWidth.abs();
        let height = dimensions.bmHeight.abs();
        if width == 0 || height == 0 {
            DeleteDC(dc);
            DeleteObject(bitmap);
            if should_uninitialize {
                CoUninitialize();
            }
            return None;
        }
        let mut info = BitmapInfo {
            bmiHeader: BitmapInfoHeader {
                biSize: std::mem::size_of::<BitmapInfoHeader>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [0],
        };
        let mut bgra = vec![0u8; (width * height * 4) as usize];
        let rows = GetDIBits(
            dc,
            bitmap,
            0,
            height as u32,
            bgra.as_mut_ptr().cast(),
            &mut info,
            DIB_RGB_COLORS,
        );
        DeleteDC(dc);
        DeleteObject(bitmap);
        if should_uninitialize {
            CoUninitialize();
        }
        if rows == 0 {
            return None;
        }
        Some(encode_bgra_png(width, height, &bgra))
    }
}

#[cfg(windows)]
fn encode_bgra_png(width: i32, height: i32, bgra: &[u8]) -> Vec<u8> {
    let has_alpha = bgra.chunks_exact(4).any(|pixel| pixel[3] != 0);
    let mut rgba = vec![0u8; bgra.len()];
    for (source, target) in bgra.chunks_exact(4).zip(rgba.chunks_exact_mut(4)) {
        target[0] = source[2];
        target[1] = source[1];
        target[2] = source[0];
        target[3] = if has_alpha {
            source[3]
        } else if source[0] | source[1] | source[2] != 0 {
            255
        } else {
            0
        };
    }
    encode_rgba_png(width as u32, height as u32, &rgba)
}

#[cfg(windows)]
fn encode_rgba_png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(rgba.len() + height as usize + 128);
    output.extend_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);
    let mut header = [0u8; 13];
    header[0..4].copy_from_slice(&width.to_be_bytes());
    header[4..8].copy_from_slice(&height.to_be_bytes());
    header[8] = 8;
    header[9] = 6;
    png_chunk(&mut output, b"IHDR", &header);
    let stride = width as usize * 4;
    let mut raw = Vec::with_capacity((stride + 1) * height as usize);
    for row in 0..height as usize {
        raw.push(0);
        raw.extend_from_slice(&rgba[row * stride..(row + 1) * stride]);
    }
    png_chunk(&mut output, b"IDAT", &deflate_store_zlib(&raw));
    png_chunk(&mut output, b"IEND", &[]);
    output
}

#[cfg(windows)]
fn png_chunk(output: &mut Vec<u8>, tag: &[u8; 4], data: &[u8]) {
    output.extend_from_slice(&(data.len() as u32).to_be_bytes());
    output.extend_from_slice(tag);
    output.extend_from_slice(data);
    output.extend_from_slice(&png_crc32(tag, data).to_be_bytes());
}

#[cfg(windows)]
fn png_crc32(tag: &[u8], data: &[u8]) -> u32 {
    static TABLE: OnceLock<[u32; 256]> = OnceLock::new();
    let table = TABLE.get_or_init(|| {
        std::array::from_fn(|index| {
            let mut value = index as u32;
            for _ in 0..8 {
                value = if value & 1 != 0 {
                    0xedb88320 ^ (value >> 1)
                } else {
                    value >> 1
                };
            }
            value
        })
    });
    let mut crc = !0u32;
    for byte in tag.iter().chain(data) {
        crc = table[((crc ^ *byte as u32) & 0xff) as usize] ^ (crc >> 8);
    }
    !crc
}

#[cfg(windows)]
fn deflate_store_zlib(data: &[u8]) -> Vec<u8> {
    let mut output = vec![0x78, 0x01];
    let mut offset = 0usize;
    while offset < data.len() {
        let end = (offset + 65_535).min(data.len());
        let length = (end - offset) as u16;
        output.push(if end == data.len() { 1 } else { 0 });
        output.extend_from_slice(&length.to_le_bytes());
        output.extend_from_slice(&(!length).to_le_bytes());
        output.extend_from_slice(&data[offset..end]);
        offset = end;
    }
    if data.is_empty() {
        output.extend_from_slice(&[1, 0, 0, 255, 255]);
    }
    let (mut first, mut second) = (1u32, 0u32);
    for byte in data {
        first = (first + *byte as u32) % 65_521;
        second = (second + first) % 65_521;
    }
    output.extend_from_slice(&((second << 16) | first).to_be_bytes());
    output
}

#[cfg(not(windows))]
pub(crate) fn protect_secret(value: &[u8]) -> Result<Vec<u8>, String> {
    Ok(value.to_vec())
}

#[cfg(not(windows))]
pub(crate) fn unprotect_secret(value: &[u8]) -> Result<Vec<u8>, String> {
    Ok(value.to_vec())
}

#[cfg(not(windows))]
pub(crate) fn set_keep_awake(_active: bool) {}

#[cfg(not(windows))]
pub(crate) fn shell_icon_png(_extension: &str) -> Option<Vec<u8>> {
    None
}

#[cfg(not(windows))]
pub(crate) fn shell_thumbnail_png(
    _path: &str,
    _size: i32,
    _icon_fallback: bool,
) -> Option<Vec<u8>> {
    None
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn shell_clipboard_verbs_are_deferred_to_filetree() {
        for verb in ["copy", "Copy", "cut", "CUT"] {
            assert!(is_deferred_clipboard_verb(verb, false));
            assert!(is_deferred_clipboard_verb(verb, true));
        }
        assert!(is_deferred_clipboard_verb("paste", true));
        assert!(is_deferred_clipboard_verb("Paste", true));
        assert!(!is_deferred_clipboard_verb("paste", false));
        for verb in ["open", "properties", "delete", "pastelink"] {
            assert!(!is_deferred_clipboard_verb(verb, true));
        }
    }

    #[test]
    fn dpapi_round_trip_uses_encrypted_bytes() {
        let plain = b"filetree-v2-dpapi-round-trip";
        let cipher = protect_secret(plain).expect("protect with the current Windows account");
        assert_ne!(cipher, plain);
        assert_eq!(
            unprotect_secret(&cipher).expect("unprotect with the current Windows account"),
            plain
        );
    }

    #[test]
    fn shell_images_are_png_and_use_icon_fallback() {
        for extension in [
            // Images
            "jpg",
            "jpeg",
            "png",
            "gif",
            "webp",
            "bmp",
            "tiff",
            "svg",
            // Video and audio
            "mp4",
            "mkv",
            "mov",
            "avi",
            "webm",
            "mp3",
            "wav",
            "flac",
            // Archives, documents, and applications
            "zip",
            "rar",
            "7z",
            "tar",
            "gz",
            "txt",
            "pdf",
            "docx",
            "xlsx",
            "exe",
            "dll",
            "msi",
            "iso",
            "torrent",
            // Partial, uncommon, and unregistered file types must still receive
            // Windows' generic file icon.
            "part",
            "vmw",
            "unknown_filetree_extension",
        ] {
            let icon = shell_icon_png(extension).expect("Windows file type icon");
            assert_eq!(&icon[..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
        }

        let executable = std::env::current_exe().expect("current test executable");
        let image = shell_thumbnail_png(
            executable.to_str().expect("UTF-8 test executable path"),
            32,
            true,
        )
        .expect("Windows thumbnail or icon fallback");
        assert_eq!(&image[..8], &[137, 80, 78, 71, 13, 10, 26, 10]);

        let folder = std::env::temp_dir().join(format!(
            "filetree-folder-thumbnail-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&folder).expect("create thumbnail test folder");
        let folder_image =
            shell_thumbnail_png(folder.to_str().expect("UTF-8 test folder path"), 32, true)
                .expect("Windows folder thumbnail or icon fallback");
        assert_eq!(&folder_image[..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
        std::fs::remove_dir_all(folder).expect("remove thumbnail test folder");
    }

    #[test]
    fn legacy_shell_icon_pixels_recover_alpha_without_filling_the_background() {
        let mut pixels = [
            SHELL_ICON_SENTINEL,
            [0, 0, 0, 0],
            [20, 40, 60, 0],
            [80, 100, 120, 128],
        ]
        .concat();

        assert!(normalize_shell_icon_bgra(&mut pixels));
        assert_eq!(&pixels[0..4], &[0, 0, 0, 0]);
        assert_eq!(&pixels[4..8], &[0, 0, 0, 255]);
        assert_eq!(&pixels[8..12], &[20, 40, 60, 255]);
        assert_eq!(&pixels[12..16], &[80, 100, 120, 128]);
    }

    #[test]
    fn image_cache_enforces_its_byte_budget() {
        let mut cache = ImageCache::new(8);
        cache.insert("first".to_string(), vec![1; 6]);
        cache.insert("second".to_string(), vec![2; 6]);
        assert!(cache.get("first").is_none());
        assert_eq!(cache.get("second"), Some(vec![2; 6]));
        assert!(cache.bytes <= 8);
    }

    #[test]
    fn native_move_uses_windows_file_operation() {
        use windows::Win32::UI::WindowsAndMessaging::GetDesktopWindow;

        let root = std::env::temp_dir().join(format!(
            "filetree-native-move-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let source_dir = root.join("source");
        let destination = root.join("destination");
        std::fs::create_dir_all(&source_dir).expect("create native move source");
        std::fs::create_dir_all(&destination).expect("create native move destination");
        let source = source_dir.join("move-me.txt");
        std::fs::write(&source, b"native move").expect("write native move source");

        let owner = unsafe { GetDesktopWindow() };
        let result = native_move_files(
            vec![source.to_string_lossy().into_owned()],
            destination.to_string_lossy().into_owned(),
            owner.0 as isize,
        )
        .expect("move through IFileOperation");

        assert!(!result.aborted);
        assert_eq!(result.moved, 1);
        assert_eq!(result.failed, 0);
        assert!(!source.exists());
        assert!(destination.join("move-me.txt").exists());
        std::fs::remove_dir_all(root).expect("remove native move fixture");
    }
}
