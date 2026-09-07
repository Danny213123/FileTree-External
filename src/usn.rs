//! NTFS USN change-journal reader.
//!
//! This is what lets a finished scan stay trustworthy without being redone. The
//! volume keeps an append-only journal in which every metadata change (create,
//! delete, rename, size change) gets a record stamped with a monotonically
//! increasing Update Sequence Number. A scan records the USN it finished at; the
//! next time that scan is opened we replay only the records past that mark, so
//! the cost tracks the number of *changes* rather than the number of files.
//!
//! Two properties make the replay safe to trust, and both are checked before a
//! single record is applied:
//!
//! * The journal has an id that changes whenever it is deleted and recreated.
//!   A different id means our checkpoint describes a journal that no longer
//!   exists, so the cached tree is void.
//! * The journal is a fixed-size ring. Once it wraps, the oldest records are
//!   gone. If our checkpoint is older than the journal's `first_usn`, the
//!   changes we missed are unrecoverable and the tree has to be rebuilt.
//!
//! Either case surfaces as [`UsnError::CheckpointExpired`], and every caller
//! answers it the same way: fall back to a full scan. That conservatism is the
//! whole reason the cache can never serve stale data.
//!
//! Records identify files by File Reference Number (the MFT record number plus a
//! reuse sequence) and carry the parent's FRN and the file's own name — but not
//! its size. The journal therefore says *what* changed, and the caller re-reads
//! metadata for just those entries.

#![cfg_attr(not(windows), allow(dead_code))]

use std::io;

/// Cap on records pulled in one incremental catch-up. A volume that has churned
/// harder than this since the snapshot is cheaper to rescan outright than to
/// replay, and the cap also bounds memory when the journal is enormous.
pub(crate) const MAX_REPLAY_RECORDS: usize = 400_000;

/// Read buffer handed to `FSCTL_READ_USN_JOURNAL`. Each call returns an 8-byte
/// next-USN header followed by packed records, so a larger buffer directly cuts
/// the number of round trips.
const READ_BUFFER_BYTES: usize = 256 * 1024;

// ── Reason flags ────────────────────────────────────────────────────────────

pub(crate) const USN_REASON_DATA_OVERWRITE: u32 = 0x0000_0001;
pub(crate) const USN_REASON_DATA_EXTEND: u32 = 0x0000_0002;
pub(crate) const USN_REASON_DATA_TRUNCATION: u32 = 0x0000_0004;
pub(crate) const USN_REASON_FILE_CREATE: u32 = 0x0000_0100;
pub(crate) const USN_REASON_FILE_DELETE: u32 = 0x0000_0200;
pub(crate) const USN_REASON_RENAME_OLD_NAME: u32 = 0x0000_1000;
pub(crate) const USN_REASON_RENAME_NEW_NAME: u32 = 0x0000_2000;
pub(crate) const USN_REASON_BASIC_INFO_CHANGE: u32 = 0x0000_8000;
pub(crate) const USN_REASON_HARD_LINK_CHANGE: u32 = 0x0001_0000;

/// Reasons that can move bytes on disk or move a node in the tree. A record
/// touching none of these (an access-time bump, a security-descriptor edit)
/// cannot change what the scan displays and is dropped before replay.
pub(crate) const REASON_AFFECTS_TREE: u32 = USN_REASON_DATA_OVERWRITE
    | USN_REASON_DATA_EXTEND
    | USN_REASON_DATA_TRUNCATION
    | USN_REASON_FILE_CREATE
    | USN_REASON_FILE_DELETE
    | USN_REASON_RENAME_OLD_NAME
    | USN_REASON_RENAME_NEW_NAME
    | USN_REASON_BASIC_INFO_CHANGE
    | USN_REASON_HARD_LINK_CHANGE;

const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;

// ── Errors ──────────────────────────────────────────────────────────────────
// As in `mft.rs`, none of these are user-facing failures. Every variant means
// "the cache cannot be trusted, do a full scan instead".

#[derive(Debug)]
pub(crate) enum UsnError {
    /// Not NTFS, or the volume has no active journal.
    Unsupported(String),
    /// Reading the journal needs administrator rights.
    AccessDenied,
    /// The journal was recreated, or our mark has already been overwritten by
    /// the ring wrapping. The changes in between are gone for good.
    CheckpointExpired,
    Io(io::Error),
}

impl std::fmt::Display for UsnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported(reason) => write!(f, "no usable change journal: {reason}"),
            Self::AccessDenied => write!(f, "change journal access denied (needs elevation)"),
            Self::CheckpointExpired => write!(f, "journal checkpoint expired; full rescan needed"),
            Self::Io(error) => write!(f, "io error: {error}"),
        }
    }
}

fn unsupported(reason: impl Into<String>) -> UsnError {
    UsnError::Unsupported(reason.into())
}

// ── Types ───────────────────────────────────────────────────────────────────

/// The volume's current journal state, from `FSCTL_QUERY_USN_JOURNAL`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct JournalInfo {
    /// Changes whenever the journal is deleted and recreated.
    pub(crate) journal_id: u64,
    /// Oldest USN still held. Anything below this has been overwritten.
    pub(crate) first_usn: i64,
    /// USN the next record will be written at — the mark to checkpoint at.
    pub(crate) next_usn: i64,
    pub(crate) lowest_valid_usn: i64,
    pub(crate) max_usn: i64,
    pub(crate) maximum_size: u64,
}

/// Everything needed to decide whether a saved scan can be caught up rather
/// than redone. Persisted alongside the scan and re-validated on every open.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Checkpoint {
    /// Guards against the drive letter being reassigned to another volume.
    pub(crate) volume_serial: u32,
    pub(crate) journal_id: u64,
    /// USN the scan finished at; replay resumes here.
    pub(crate) next_usn: i64,
}

impl Checkpoint {
    pub(crate) fn is_set(&self) -> bool {
        self.journal_id != 0 && self.next_usn > 0
    }
}

/// One journal record, flattened to what the tree replay needs.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct UsnChange {
    /// File reference number: MFT record index in the low 48 bits, reuse
    /// sequence in the high 16.
    pub(crate) frn: u64,
    pub(crate) parent_frn: u64,
    pub(crate) usn: i64,
    pub(crate) timestamp_ms: u64,
    pub(crate) reason: u32,
    pub(crate) attributes: u32,
    pub(crate) name: String,
}

impl UsnChange {
    pub(crate) fn is_dir(&self) -> bool {
        self.attributes & FILE_ATTRIBUTE_DIRECTORY != 0
    }

    /// MFT record index, with the reuse sequence masked off. This is the key
    /// that lines a journal record up with an entry from `mft.rs`.
    pub(crate) fn record_index(&self) -> u64 {
        self.frn & 0x0000_FFFF_FFFF_FFFF
    }

    pub(crate) fn parent_record_index(&self) -> u64 {
        self.parent_frn & 0x0000_FFFF_FFFF_FFFF
    }

    pub(crate) fn affects_tree(&self) -> bool {
        self.reason & REASON_AFFECTS_TREE != 0
    }
}

/// Result of catching a checkpoint up to the present.
#[derive(Clone, Debug, Default)]
pub(crate) struct Replay {
    pub(crate) changes: Vec<UsnChange>,
    /// Where to checkpoint after applying `changes`.
    pub(crate) next_usn: i64,
    /// Set when the record cap was hit before the journal was drained, meaning
    /// `changes` is a prefix and the caller must rescan instead.
    pub(crate) truncated: bool,
}

// ── Little-endian readers ───────────────────────────────────────────────────
// Bounds-checked for the same reason as `mft.rs`: a record claiming an offset
// past its own end is corrupt and must be skipped, never panicked on.

#[inline]
fn u16_at(buf: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(buf.get(at..at + 2)?.try_into().ok()?))
}

#[inline]
fn u32_at(buf: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(buf.get(at..at + 4)?.try_into().ok()?))
}

#[inline]
fn u64_at(buf: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_le_bytes(buf.get(at..at + 8)?.try_into().ok()?))
}

#[inline]
fn i64_at(buf: &[u8], at: usize) -> Option<i64> {
    Some(i64::from_le_bytes(buf.get(at..at + 8)?.try_into().ok()?))
}

/// FILETIME (100-ns ticks since 1601-01-01) → Unix epoch milliseconds. Matches
/// the conversion in `mft.rs` so both paths emit identical timestamps.
#[inline]
fn filetime_to_ms(ticks: i64) -> u64 {
    (ticks.max(0) as u64)
        .saturating_sub(116_444_736_000_000_000)
        .checked_div(10_000)
        .unwrap_or(0)
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/// Decode a `USN_JOURNAL_DATA` buffer. V0 is 56 bytes; V1 and V2 append
/// version-range fields we don't need, so the shared prefix is all we read.
pub(crate) fn parse_journal_data(buf: &[u8]) -> Option<JournalInfo> {
    if buf.len() < 56 {
        return None;
    }
    Some(JournalInfo {
        journal_id: u64_at(buf, 0x00)?,
        first_usn: i64_at(buf, 0x08)?,
        next_usn: i64_at(buf, 0x10)?,
        lowest_valid_usn: i64_at(buf, 0x18)?,
        max_usn: i64_at(buf, 0x20)?,
        maximum_size: u64_at(buf, 0x28)?,
    })
}

/// Decode one `USN_RECORD`. Handles both V2 (64-bit file ids, what NTFS emits)
/// and V3 (128-bit ids, used by ReFS and available on NTFS only when asked for);
/// V3's ids are truncated to their low 64 bits, which is the MFT reference.
pub(crate) fn parse_change_record(record: &[u8]) -> Option<UsnChange> {
    let major = u16_at(record, 0x04)?;
    let (frn, parent_frn, tail) = match major {
        2 => (u64_at(record, 0x08)?, u64_at(record, 0x10)?, 0x18),
        3 => (u64_at(record, 0x08)?, u64_at(record, 0x18)?, 0x28),
        _ => return None,
    };

    let usn = i64_at(record, tail)?;
    let timestamp_ms = filetime_to_ms(i64_at(record, tail + 0x08)?);
    let reason = u32_at(record, tail + 0x10)?;
    let attributes = u32_at(record, tail + 0x1C)?;
    let name_len = u16_at(record, tail + 0x20)? as usize;
    let name_at = u16_at(record, tail + 0x22)? as usize;

    // A name length that isn't a whole number of UTF-16 units, or that runs off
    // the end of the record, means we've lost the framing.
    if !name_len.is_multiple_of(2) {
        return None;
    }
    let name_bytes = record.get(name_at..name_at.checked_add(name_len)?)?;
    let units: Vec<u16> = name_bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();

    Some(UsnChange {
        frn,
        parent_frn,
        usn,
        timestamp_ms,
        reason,
        attributes,
        name: String::from_utf16_lossy(&units),
    })
}

/// Split one `FSCTL_READ_USN_JOURNAL` buffer into its next-USN header and the
/// packed records behind it. Returns `None` if the buffer is too short to even
/// hold the header.
pub(crate) fn parse_change_buffer(buf: &[u8]) -> Option<(i64, Vec<UsnChange>)> {
    let next_usn = i64_at(buf, 0)?;
    let mut changes = Vec::new();
    let mut at = 8usize;

    while at + 8 <= buf.len() {
        let length = match u32_at(buf, at) {
            Some(length) => length as usize,
            None => break,
        };
        // Zero length would spin forever; an over-long length means the tail is
        // truncated. Either way this buffer has no more usable records.
        if length < 8 || at + length > buf.len() {
            break;
        }
        if let Some(change) = parse_change_record(&buf[at..at + length]) {
            changes.push(change);
        }
        at += length;
    }

    Some((next_usn, changes))
}

/// Whether `checkpoint` still describes `info`'s journal closely enough to
/// replay from. False means the cached tree must be rebuilt.
pub(crate) fn checkpoint_is_live(checkpoint: &Checkpoint, info: &JournalInfo) -> bool {
    checkpoint.is_set()
        && checkpoint.journal_id == info.journal_id
        // Our mark must still be inside the ring. Equality is fine: it means no
        // record has aged out past where we stopped.
        && checkpoint.next_usn >= info.first_usn
        // A mark past the head means the journal was reset behind our back.
        && checkpoint.next_usn <= info.next_usn
}

// ── Windows implementation ──────────────────────────────────────────────────

#[cfg(windows)]
mod journal {
    use super::{READ_BUFFER_BYTES, UsnError};
    use std::io;

    // Handle spelling matches `mft.rs` and `fileattr.rs` so the linker sees one
    // consistent signature per symbol.
    type Handle = *mut std::ffi::c_void;
    const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
    const GENERIC_READ: u32 = 0x8000_0000;
    const FILE_READ_DATA: u32 = 0x0000_0001;
    const FILE_READ_ATTRIBUTES: u32 = 0x0000_0080;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const OPEN_EXISTING: u32 = 3;

    /// Access rights to try when opening the volume, weakest first.
    ///
    /// `GENERIC_READ` on `\\.\X:` is raw volume access and needs administrator
    /// rights, but the journal ioctls are queries rather than block reads, so a
    /// far weaker handle can be enough. Climbing the ladder means an unelevated
    /// process still gets whatever the system is willing to give it instead of
    /// failing at the top rung.
    const ACCESS_LADDER: [u32; 4] = [
        FILE_READ_ATTRIBUTES,
        FILE_READ_DATA,
        FILE_READ_DATA | FILE_READ_ATTRIBUTES,
        GENERIC_READ,
    ];

    const ERROR_ACCESS_DENIED: u32 = 5;
    const ERROR_INVALID_FUNCTION: u32 = 1;
    const ERROR_JOURNAL_DELETE_IN_PROGRESS: u32 = 1178;
    const ERROR_JOURNAL_NOT_ACTIVE: u32 = 1179;
    const ERROR_JOURNAL_ENTRY_DELETED: u32 = 1181;

    const FSCTL_QUERY_USN_JOURNAL: u32 = 0x0009_00F4;
    const FSCTL_READ_USN_JOURNAL: u32 = 0x0009_00BB;

    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            sa: *mut std::ffi::c_void,
            disposition: u32,
            flags: u32,
            tmpl: Handle,
        ) -> Handle;
        fn DeviceIoControl(
            hDevice: Handle,
            dwIoControlCode: u32,
            lpInBuffer: *const u8,
            nInBufferSize: u32,
            lpOutBuffer: *mut u8,
            nOutBufferSize: u32,
            lpBytesReturned: *mut u32,
            lpOverlapped: *mut u8,
        ) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
        fn GetLastError() -> u32;
        fn GetVolumeInformationW(
            lpRootPathName: *const u16,
            lpVolumeNameBuffer: *mut u16,
            nVolumeNameSize: u32,
            lpVolumeSerialNumber: *mut u32,
            lpMaximumComponentLength: *mut u32,
            lpFileSystemFlags: *mut u32,
            lpFileSystemNameBuffer: *mut u16,
            nFileSystemNameSize: u32,
        ) -> i32;
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    /// Map a Win32 journal error onto the variant whose recovery is correct.
    fn classify(error: u32) -> UsnError {
        match error {
            ERROR_ACCESS_DENIED => UsnError::AccessDenied,
            // The mark we asked to resume from has already been overwritten.
            ERROR_JOURNAL_ENTRY_DELETED => UsnError::CheckpointExpired,
            ERROR_JOURNAL_NOT_ACTIVE => UsnError::Unsupported("journal not active".into()),
            ERROR_JOURNAL_DELETE_IN_PROGRESS => {
                UsnError::Unsupported("journal being deleted".into())
            }
            // Non-NTFS volumes reject the ioctl outright.
            ERROR_INVALID_FUNCTION => UsnError::Unsupported("volume has no change journal".into()),
            other => UsnError::Io(io::Error::from_raw_os_error(other as i32)),
        }
    }

    /// The volume's serial number, used to notice a drive letter being
    /// reassigned to a different volume between sessions. Needs no privileges.
    pub(super) fn volume_serial(letter: char) -> Option<u32> {
        let root = wide(&format!("{letter}:\\"));
        let mut serial: u32 = 0;
        let ok = unsafe {
            GetVolumeInformationW(
                root.as_ptr(),
                std::ptr::null_mut(),
                0,
                &mut serial,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
            )
        };
        (ok != 0).then_some(serial)
    }

    /// A read handle on `\\.\X:`, the same raw volume device the MFT reader
    /// opens. Trailing backslash omitted deliberately: `\\.\C:\` would open the
    /// filesystem root instead of the volume.
    pub(super) struct VolumeHandle {
        handle: Handle,
    }

    /// Pick the more actionable of two Win32 errors. A weak handle makes the
    /// journal ioctls fail with `ERROR_INVALID_FUNCTION`, which is
    /// indistinguishable from "this volume has no journal" — so when some rung
    /// of the ladder was refused outright, that refusal is the honest cause and
    /// must not be masked by a weaker handle's misleading ioctl failure.
    fn preferred_error(current: u32, candidate: u32) -> u32 {
        fn rank(error: u32) -> u8 {
            match error {
                ERROR_ACCESS_DENIED => 3,
                ERROR_JOURNAL_NOT_ACTIVE | ERROR_JOURNAL_DELETE_IN_PROGRESS => 2,
                0 | ERROR_INVALID_FUNCTION => 0,
                _ => 1,
            }
        }
        if rank(candidate) > rank(current) {
            candidate
        } else {
            current
        }
    }

    impl VolumeHandle {
        /// Open the volume with the least access that can actually *drive* the
        /// journal ioctls, and hand back the journal state the probe already
        /// fetched so the caller doesn't pay for a second query.
        ///
        /// Validating each rung with a real query matters: on an unelevated
        /// process the weakest handle opens happily and then fails every ioctl,
        /// so an open-only ladder would settle on a useless handle.
        pub(super) fn open_with_journal(letter: char) -> Result<(Self, Vec<u8>), UsnError> {
            let path = wide(&format!("\\\\.\\{letter}:"));
            let mut best_error = 0u32;

            for access in ACCESS_LADDER {
                let raw = unsafe {
                    CreateFileW(
                        path.as_ptr(),
                        access,
                        FILE_SHARE_READ | FILE_SHARE_WRITE,
                        std::ptr::null_mut(),
                        OPEN_EXISTING,
                        0,
                        std::ptr::null_mut(),
                    )
                };
                if raw == INVALID_HANDLE_VALUE {
                    best_error = preferred_error(best_error, unsafe { GetLastError() });
                    continue;
                }

                let handle = Self { handle: raw };
                match handle.query() {
                    Ok(data) => return Ok((handle, data)),
                    Err(UsnError::Io(error)) => {
                        let code = error.raw_os_error().unwrap_or(0) as u32;
                        best_error = preferred_error(best_error, code);
                    }
                    Err(_) => {
                        // Re-read the code the classification came from; the
                        // handle is dropped at the end of this iteration.
                        best_error = preferred_error(best_error, unsafe { GetLastError() });
                    }
                }
            }

            Err(classify(best_error))
        }

        /// `FSCTL_QUERY_USN_JOURNAL` — the journal's id and USN range.
        pub(super) fn query(&self) -> Result<Vec<u8>, UsnError> {
            // Sized for USN_JOURNAL_DATA_V2, the largest shape any Windows
            // version returns; we only read the common prefix.
            let mut out = [0u8; 80];
            let mut returned: u32 = 0;
            let ok = unsafe {
                DeviceIoControl(
                    self.handle,
                    FSCTL_QUERY_USN_JOURNAL,
                    std::ptr::null(),
                    0,
                    out.as_mut_ptr(),
                    out.len() as u32,
                    &mut returned,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(classify(unsafe { GetLastError() }));
            }
            Ok(out[..returned as usize].to_vec())
        }

        /// One `FSCTL_READ_USN_JOURNAL` call starting at `start_usn`. Returns the
        /// raw buffer: an 8-byte next-USN header followed by packed records.
        ///
        /// The V0 input shape is deliberate — it makes NTFS emit V2 records,
        /// which carry the 64-bit file reference numbers the MFT index is keyed
        /// by. Asking for V3 would only widen the ids we then truncate.
        pub(super) fn read_from(
            &self,
            start_usn: i64,
            journal_id: u64,
            reason_mask: u32,
        ) -> Result<Vec<u8>, UsnError> {
            let mut input = [0u8; 40];
            input[0x00..0x08].copy_from_slice(&start_usn.to_le_bytes());
            input[0x08..0x0C].copy_from_slice(&reason_mask.to_le_bytes());
            // ReturnOnlyOnClose = 0: report changes as they happen, not only
            // once the last handle closes.
            input[0x0C..0x10].copy_from_slice(&0u32.to_le_bytes());
            // Timeout + BytesToWaitFor = 0: never block, just return what's
            // there. A blocking read would stall the caller's thread.
            input[0x10..0x18].copy_from_slice(&0u64.to_le_bytes());
            input[0x18..0x20].copy_from_slice(&0u64.to_le_bytes());
            input[0x20..0x28].copy_from_slice(&journal_id.to_le_bytes());

            let mut out = vec![0u8; READ_BUFFER_BYTES];
            let mut returned: u32 = 0;
            let ok = unsafe {
                DeviceIoControl(
                    self.handle,
                    FSCTL_READ_USN_JOURNAL,
                    input.as_ptr(),
                    input.len() as u32,
                    out.as_mut_ptr(),
                    out.len() as u32,
                    &mut returned,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(classify(unsafe { GetLastError() }));
            }
            out.truncate(returned as usize);
            Ok(out)
        }
    }

    impl Drop for VolumeHandle {
        fn drop(&mut self) {
            if self.handle != INVALID_HANDLE_VALUE {
                unsafe { CloseHandle(self.handle) };
            }
        }
    }
}

/// The volume's current journal state, or the reason it can't be used.
#[cfg(windows)]
pub(crate) fn query_journal(letter: char) -> Result<JournalInfo, UsnError> {
    let (_handle, raw) = journal::VolumeHandle::open_with_journal(letter)?;
    parse_journal_data(&raw).ok_or_else(|| unsupported("short journal query response"))
}

/// Serial number of the volume behind `letter`.
#[cfg(windows)]
pub(crate) fn volume_serial(letter: char) -> Option<u32> {
    journal::volume_serial(letter)
}

/// Capture the mark a scan of `letter` should be checkpointed at. Called at the
/// *start* of a scan, not the end: anything that changes while the scan runs
/// then shows up as a replayable record rather than being silently missed.
#[cfg(windows)]
pub(crate) fn capture_checkpoint(letter: char) -> Result<Checkpoint, UsnError> {
    let info = query_journal(letter)?;
    Ok(Checkpoint {
        volume_serial: volume_serial(letter).unwrap_or(0),
        journal_id: info.journal_id,
        next_usn: info.next_usn,
    })
}

/// Collect every change on `letter` since `checkpoint`.
///
/// Fails with [`UsnError::CheckpointExpired`] when the journal was recreated or
/// has wrapped past the mark — the two cases where the gap is unrecoverable and
/// the caller must rescan. Records that can't move bytes or nodes are dropped
/// here so callers only ever see changes worth applying.
#[cfg(windows)]
pub(crate) fn changes_since(letter: char, checkpoint: &Checkpoint) -> Result<Replay, UsnError> {
    if !checkpoint.is_set() {
        return Err(UsnError::CheckpointExpired);
    }
    // A drive letter can be reassigned to a different volume between sessions,
    // in which case the journal id could still coincidentally match.
    if let Some(serial) = volume_serial(letter)
        && checkpoint.volume_serial != 0
        && serial != checkpoint.volume_serial
    {
        return Err(UsnError::CheckpointExpired);
    }

    let (handle, raw) = journal::VolumeHandle::open_with_journal(letter)?;
    let info =
        parse_journal_data(&raw).ok_or_else(|| unsupported("short journal query response"))?;
    if !checkpoint_is_live(checkpoint, &info) {
        return Err(UsnError::CheckpointExpired);
    }

    let mut replay = Replay {
        next_usn: checkpoint.next_usn,
        ..Replay::default()
    };
    let mut cursor = checkpoint.next_usn;

    loop {
        let raw = handle.read_from(cursor, info.journal_id, REASON_AFFECTS_TREE)?;
        let Some((next_usn, batch)) = parse_change_buffer(&raw) else {
            break;
        };

        for change in batch {
            if change.affects_tree() {
                replay.changes.push(change);
            }
        }

        // The journal is drained when it stops advancing. Checking the cursor
        // rather than the batch being empty is what makes this terminate even
        // when every record in a batch was filtered out.
        if next_usn <= cursor {
            replay.next_usn = next_usn.max(cursor);
            break;
        }
        cursor = next_usn;
        replay.next_usn = next_usn;

        if replay.changes.len() >= MAX_REPLAY_RECORDS {
            replay.truncated = true;
            break;
        }
    }

    Ok(replay)
}

// ── Non-Windows stubs ───────────────────────────────────────────────────────
// The journal is an NTFS feature. Elsewhere every entry point reports "no
// journal", which routes callers to a full scan exactly as an unelevated or
// non-NTFS Windows volume would.

#[cfg(not(windows))]
pub(crate) fn query_journal(_letter: char) -> Result<JournalInfo, UsnError> {
    Err(unsupported("change journal is Windows-only"))
}

#[cfg(not(windows))]
pub(crate) fn volume_serial(_letter: char) -> Option<u32> {
    None
}

#[cfg(not(windows))]
pub(crate) fn capture_checkpoint(_letter: char) -> Result<Checkpoint, UsnError> {
    Err(unsupported("change journal is Windows-only"))
}

#[cfg(not(windows))]
pub(crate) fn changes_since(_letter: char, _checkpoint: &Checkpoint) -> Result<Replay, UsnError> {
    Err(unsupported("change journal is Windows-only"))
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// FILETIME ticks for Unix epoch millisecond 1_000_000_000_000.
    const FILETIME_1E12: i64 = 126_444_736_000_000_000;

    fn journal_data(journal_id: u64, first: i64, next: i64) -> Vec<u8> {
        let mut buf = vec![0u8; 56];
        buf[0x00..0x08].copy_from_slice(&journal_id.to_le_bytes());
        buf[0x08..0x10].copy_from_slice(&first.to_le_bytes());
        buf[0x10..0x18].copy_from_slice(&next.to_le_bytes());
        buf[0x18..0x20].copy_from_slice(&first.to_le_bytes());
        buf[0x20..0x28].copy_from_slice(&i64::MAX.to_le_bytes());
        buf[0x28..0x30].copy_from_slice(&(32u64 * 1024 * 1024).to_le_bytes());
        buf
    }

    /// Build a `USN_RECORD_V2` with `name` appended after the fixed header.
    fn record_v2(frn: u64, parent: u64, usn: i64, reason: u32, attrs: u32, name: &str) -> Vec<u8> {
        let units: Vec<u16> = name.encode_utf16().collect();
        let name_bytes = units.len() * 2;
        let header = 0x3Cusize;
        // Records are 8-byte aligned on disk; pad so packed iteration matches.
        let length = (header + name_bytes).div_ceil(8) * 8;

        let mut buf = vec![0u8; length];
        buf[0x00..0x04].copy_from_slice(&(length as u32).to_le_bytes());
        buf[0x04..0x06].copy_from_slice(&2u16.to_le_bytes());
        buf[0x06..0x08].copy_from_slice(&0u16.to_le_bytes());
        buf[0x08..0x10].copy_from_slice(&frn.to_le_bytes());
        buf[0x10..0x18].copy_from_slice(&parent.to_le_bytes());
        buf[0x18..0x20].copy_from_slice(&usn.to_le_bytes());
        buf[0x20..0x28].copy_from_slice(&FILETIME_1E12.to_le_bytes());
        buf[0x28..0x2C].copy_from_slice(&reason.to_le_bytes());
        buf[0x34..0x38].copy_from_slice(&attrs.to_le_bytes());
        buf[0x38..0x3A].copy_from_slice(&(name_bytes as u16).to_le_bytes());
        buf[0x3A..0x3C].copy_from_slice(&(header as u16).to_le_bytes());
        for (i, unit) in units.iter().enumerate() {
            let at = header + i * 2;
            buf[at..at + 2].copy_from_slice(&unit.to_le_bytes());
        }
        buf
    }

    /// Build a `USN_RECORD_V3`, whose 128-bit ids push every later field out.
    fn record_v3(frn: u64, parent: u64, usn: i64, reason: u32, attrs: u32, name: &str) -> Vec<u8> {
        let units: Vec<u16> = name.encode_utf16().collect();
        let name_bytes = units.len() * 2;
        let header = 0x4Cusize;
        let length = (header + name_bytes).div_ceil(8) * 8;

        let mut buf = vec![0u8; length];
        buf[0x00..0x04].copy_from_slice(&(length as u32).to_le_bytes());
        buf[0x04..0x06].copy_from_slice(&3u16.to_le_bytes());
        buf[0x08..0x10].copy_from_slice(&frn.to_le_bytes());
        buf[0x18..0x20].copy_from_slice(&parent.to_le_bytes());
        buf[0x28..0x30].copy_from_slice(&usn.to_le_bytes());
        buf[0x30..0x38].copy_from_slice(&FILETIME_1E12.to_le_bytes());
        buf[0x38..0x3C].copy_from_slice(&reason.to_le_bytes());
        buf[0x44..0x48].copy_from_slice(&attrs.to_le_bytes());
        buf[0x48..0x4A].copy_from_slice(&(name_bytes as u16).to_le_bytes());
        buf[0x4A..0x4C].copy_from_slice(&(header as u16).to_le_bytes());
        for (i, unit) in units.iter().enumerate() {
            let at = header + i * 2;
            buf[at..at + 2].copy_from_slice(&unit.to_le_bytes());
        }
        buf
    }

    fn change_buffer(next_usn: i64, records: &[Vec<u8>]) -> Vec<u8> {
        let mut buf = next_usn.to_le_bytes().to_vec();
        for record in records {
            buf.extend_from_slice(record);
        }
        buf
    }

    #[test]
    fn parses_journal_data() {
        let info = parse_journal_data(&journal_data(0xABCD, 4096, 900_000)).expect("parsed");
        assert_eq!(info.journal_id, 0xABCD);
        assert_eq!(info.first_usn, 4096);
        assert_eq!(info.next_usn, 900_000);
        assert_eq!(info.maximum_size, 32 * 1024 * 1024);
    }

    #[test]
    fn rejects_short_journal_data() {
        assert!(parse_journal_data(&[0u8; 32]).is_none());
    }

    #[test]
    fn parses_a_v2_record() {
        let raw = record_v2(0x0002_0000_0000_0100, 5, 8192, USN_REASON_FILE_CREATE, 0, "notes.txt");
        let change = parse_change_record(&raw).expect("parsed");
        assert_eq!(change.name, "notes.txt");
        assert_eq!(change.usn, 8192);
        assert_eq!(change.parent_frn, 5);
        assert_eq!(change.reason, USN_REASON_FILE_CREATE);
        assert_eq!(change.timestamp_ms, 1_000_000_000_000);
        assert!(!change.is_dir());
        // The reuse sequence in the high 16 bits must not leak into the index.
        assert_eq!(change.record_index(), 0x100);
    }

    #[test]
    fn parses_a_v3_record() {
        let raw = record_v3(0x2A, 5, 4096, USN_REASON_FILE_DELETE, FILE_ATTRIBUTE_DIRECTORY, "bin");
        let change = parse_change_record(&raw).expect("parsed");
        assert_eq!(change.name, "bin");
        assert_eq!(change.usn, 4096);
        assert_eq!(change.frn, 0x2A);
        assert_eq!(change.parent_frn, 5);
        assert!(change.is_dir());
    }

    #[test]
    fn rejects_an_unknown_record_version() {
        let mut raw = record_v2(1, 5, 64, USN_REASON_FILE_CREATE, 0, "x");
        raw[0x04..0x06].copy_from_slice(&9u16.to_le_bytes());
        assert!(parse_change_record(&raw).is_none());
    }

    #[test]
    fn rejects_a_name_running_past_the_record() {
        let mut raw = record_v2(1, 5, 64, USN_REASON_FILE_CREATE, 0, "x");
        raw[0x38..0x3A].copy_from_slice(&4096u16.to_le_bytes());
        assert!(parse_change_record(&raw).is_none());
    }

    #[test]
    fn walks_a_packed_change_buffer() {
        let buf = change_buffer(
            9000,
            &[
                record_v2(10, 5, 8192, USN_REASON_FILE_CREATE, 0, "a.txt"),
                record_v2(11, 5, 8256, USN_REASON_DATA_EXTEND, 0, "bb.txt"),
                record_v2(12, 5, 8320, USN_REASON_FILE_DELETE, 0, "ccc.txt"),
            ],
        );
        let (next_usn, changes) = parse_change_buffer(&buf).expect("parsed");
        assert_eq!(next_usn, 9000);
        assert_eq!(changes.len(), 3);
        assert_eq!(
            changes.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            ["a.txt", "bb.txt", "ccc.txt"]
        );
    }

    #[test]
    fn stops_at_a_truncated_trailing_record() {
        let mut buf = change_buffer(9000, &[record_v2(10, 5, 8192, USN_REASON_FILE_CREATE, 0, "a.txt")]);
        // A header claiming more bytes than the buffer holds.
        buf.extend_from_slice(&4096u32.to_le_bytes());
        buf.extend_from_slice(&[0u8; 16]);
        let (_, changes) = parse_change_buffer(&buf).expect("parsed");
        assert_eq!(changes.len(), 1);
    }

    #[test]
    fn a_zero_length_record_cannot_spin_the_walker() {
        let mut buf = change_buffer(9000, &[record_v2(10, 5, 8192, USN_REASON_FILE_CREATE, 0, "a.txt")]);
        buf.extend_from_slice(&[0u8; 16]);
        let (_, changes) = parse_change_buffer(&buf).expect("parsed");
        assert_eq!(changes.len(), 1);
    }

    #[test]
    fn an_empty_buffer_yields_only_the_next_usn() {
        let (next_usn, changes) = parse_change_buffer(&9000i64.to_le_bytes()).expect("parsed");
        assert_eq!(next_usn, 9000);
        assert!(changes.is_empty());
    }

    #[test]
    fn checkpoint_survives_a_journal_that_has_only_grown() {
        let checkpoint = Checkpoint { volume_serial: 1, journal_id: 7, next_usn: 5000 };
        let info = JournalInfo { journal_id: 7, first_usn: 4096, next_usn: 9000, ..Default::default() };
        assert!(checkpoint_is_live(&checkpoint, &info));
    }

    #[test]
    fn checkpoint_dies_when_the_journal_is_recreated() {
        let checkpoint = Checkpoint { volume_serial: 1, journal_id: 7, next_usn: 5000 };
        let info = JournalInfo { journal_id: 8, first_usn: 0, next_usn: 9000, ..Default::default() };
        assert!(!checkpoint_is_live(&checkpoint, &info));
    }

    #[test]
    fn checkpoint_dies_when_the_ring_has_wrapped_past_it() {
        let checkpoint = Checkpoint { volume_serial: 1, journal_id: 7, next_usn: 1000 };
        let info = JournalInfo { journal_id: 7, first_usn: 4096, next_usn: 9000, ..Default::default() };
        assert!(!checkpoint_is_live(&checkpoint, &info));
    }

    #[test]
    fn checkpoint_dies_when_it_sits_past_the_journal_head() {
        let checkpoint = Checkpoint { volume_serial: 1, journal_id: 7, next_usn: 99_000 };
        let info = JournalInfo { journal_id: 7, first_usn: 4096, next_usn: 9000, ..Default::default() };
        assert!(!checkpoint_is_live(&checkpoint, &info));
    }

    #[test]
    fn an_unset_checkpoint_is_never_live() {
        let info = JournalInfo { journal_id: 7, first_usn: 0, next_usn: 9000, ..Default::default() };
        assert!(!checkpoint_is_live(&Checkpoint::default(), &info));
    }

    #[test]
    fn a_mark_exactly_at_the_ring_tail_still_replays() {
        let checkpoint = Checkpoint { volume_serial: 1, journal_id: 7, next_usn: 4096 };
        let info = JournalInfo { journal_id: 7, first_usn: 4096, next_usn: 9000, ..Default::default() };
        assert!(checkpoint_is_live(&checkpoint, &info));
    }

    /// Opt-in smoke test against this machine's real journal — the only way to
    /// confirm the FSCTL buffer layouts match what the kernel actually returns.
    /// Ignored by default: it needs an NTFS volume and, on most systems,
    /// elevation. Run with `cargo test -- --ignored --nocapture usn::tests::live`.
    #[test]
    #[ignore = "needs a real NTFS volume and usually elevation"]
    fn live_journal_round_trip() {
        let letter = 'c';
        let info = match query_journal(letter) {
            Ok(info) => info,
            Err(error) => {
                println!("query_journal({letter}) unavailable: {error}");
                return;
            }
        };
        println!(
            "journal id={:#x} first={} next={} max_size={}",
            info.journal_id, info.first_usn, info.next_usn, info.maximum_size
        );
        assert!(info.journal_id != 0, "a live journal always has an id");
        assert!(info.next_usn >= info.first_usn, "head must not precede tail");

        // Replay the tail of the journal rather than the whole ring: start a
        // little behind the head so the read returns something without walking
        // millions of records.
        let checkpoint = Checkpoint {
            volume_serial: volume_serial(letter).unwrap_or(0),
            journal_id: info.journal_id,
            next_usn: (info.next_usn - 4_000_000).max(info.first_usn),
        };
        match changes_since(letter, &checkpoint) {
            Ok(replay) => {
                println!(
                    "replayed {} changes, next_usn={}, truncated={}",
                    replay.changes.len(),
                    replay.next_usn,
                    replay.truncated
                );
                for change in replay.changes.iter().take(5) {
                    println!(
                        "  frn={:#x} parent={:#x} reason={:#010x} dir={} {}",
                        change.record_index(),
                        change.parent_record_index(),
                        change.reason,
                        change.is_dir(),
                        change.name
                    );
                }
                assert!(replay.next_usn >= checkpoint.next_usn, "replay must advance");
            }
            Err(error) => println!("changes_since unavailable: {error}"),
        }
    }

    #[test]
    fn tree_relevance_filters_noise_reasons() {
        let touched = UsnChange { reason: 0x0000_0020, ..UsnChange::default() };
        assert!(!touched.affects_tree());
        let written = UsnChange { reason: USN_REASON_DATA_EXTEND, ..UsnChange::default() };
        assert!(written.affects_tree());
        let renamed = UsnChange { reason: USN_REASON_RENAME_NEW_NAME, ..UsnChange::default() };
        assert!(renamed.affects_tree());
    }
}
