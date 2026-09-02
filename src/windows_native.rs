#[cfg(windows)]
use std::collections::HashMap;
#[cfg(windows)]
use std::path::Path;
#[cfg(windows)]
use std::sync::{Condvar, Mutex, OnceLock};

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
}
