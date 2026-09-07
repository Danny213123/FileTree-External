//! Direct NTFS Master File Table reader — the scan fast path.
//!
//! Walking a directory tree costs one metadata lookup per directory index plus
//! at least one kernel transition per entry, and those lookups are scattered
//! across the volume. Scanning is therefore bound by random metadata latency and
//! syscall count, NOT by disk bandwidth: a faster disk barely moves the number.
//!
//! NTFS already keeps every file's metadata in one place. The Master File Table
//! is an array of fixed-size records (typically 1 KiB), one per file or
//! directory, stored in a handful of large extents. Reading it end to end turns
//! "millions of small random lookups" into "a few hundred MiB of sequential
//! reads", which is where the order-of-magnitude comes from. This is the same
//! approach WizTree and TreeSize Professional's NTFS mode use.
//!
//! What it costs:
//!
//!   * NTFS only. Anything else (exFAT, FAT32, ReFS, network shares) must walk.
//!   * Requires opening `\\.\X:` for raw read, i.e. an ELEVATED process.
//!   * Junctions/symlinks are recorded, never followed — the MFT is per volume.
//!
//! Every one of those is a fall-back-to-the-walker condition, never an error.
//!
//! Layout facts this module relies on (all little-endian):
//!   * Boot sector holds sector/cluster geometry and the MFT's start cluster.
//!   * MFT record 0 describes the MFT itself; its `$DATA` run list is the only
//!     way to find the rest of the table, which is usually fragmented.
//!   * Each record's per-sector last two bytes are replaced by an update
//!     sequence number and MUST be restored before the record can be read.
//!   * Record 5 is the volume's root directory.

use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// Bytes pulled from the volume per read while streaming the table. Large
/// enough that the sequential read dominates the per-call overhead, small
/// enough to stay off the large-page/CPU-cache cliff and to keep cancellation
/// responsive.
const STREAM_CHUNK_BYTES: usize = 4 * 1024 * 1024;

/// MFT record number of the volume's root directory, fixed by NTFS.
pub(crate) const ROOT_RECORD: u32 = 5;

// ── Errors ──────────────────────────────────────────────────────────────────
// Every variant means "use the walker instead". None of them are user-facing
// failures, so the caller logs at most a debug line and carries on.

#[derive(Debug)]
pub(crate) enum MftError {
    /// Not an NTFS volume, or geometry we don't know how to read.
    Unsupported(String),
    /// Raw volume access needs administrator rights.
    AccessDenied,
    /// The scan was cancelled mid-read.
    Cancelled,
    Io(io::Error),
}

impl std::fmt::Display for MftError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported(reason) => write!(f, "unsupported volume: {reason}"),
            Self::AccessDenied => write!(f, "raw volume access denied (needs elevation)"),
            Self::Cancelled => write!(f, "cancelled"),
            Self::Io(error) => write!(f, "io error: {error}"),
        }
    }
}

fn unsupported(reason: impl Into<String>) -> MftError {
    MftError::Unsupported(reason.into())
}

// ── Little-endian readers ───────────────────────────────────────────────────
// Bounds-checked: a record that claims an offset past its own end is corrupt
// (or a layout we don't understand) and must be skipped, never panicked on.

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

/// FILETIME (100-ns ticks since 1601-01-01) → Unix epoch milliseconds. Matches
/// `scan.rs`'s conversion so both scan paths emit identical timestamps.
#[inline]
fn filetime_to_ms(ticks: u64) -> u64 {
    ticks
        .saturating_sub(116_444_736_000_000_000)
        .checked_div(10_000)
        .unwrap_or(0)
}

// ── Volume geometry ─────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Geometry {
    pub(crate) bytes_per_sector: u32,
    pub(crate) bytes_per_cluster: u32,
    /// Cluster where the MFT's first extent begins.
    pub(crate) mft_start_lcn: u64,
    pub(crate) bytes_per_record: u32,
}

/// Parse the NTFS boot sector (first 512 bytes of the volume).
pub(crate) fn parse_boot_sector(sector: &[u8]) -> Result<Geometry, MftError> {
    if sector.len() < 512 {
        return Err(unsupported("boot sector short read"));
    }
    // OEM ID. The only positive identification of NTFS available here.
    if &sector[3..11] != b"NTFS    " {
        return Err(unsupported("not an NTFS volume"));
    }

    let bytes_per_sector = u16_at(sector, 0x0B).unwrap_or(0) as u32;
    if !(256..=8192).contains(&bytes_per_sector) || !bytes_per_sector.is_power_of_two() {
        return Err(unsupported(format!("bad sector size {bytes_per_sector}")));
    }

    // Sectors per cluster is a linear count up to 0x80; above that NTFS encodes
    // it as a negative power of two (used by volumes with >64 KiB clusters).
    let raw_spc = sector[0x0D];
    let sectors_per_cluster: u32 = match raw_spc {
        0 => return Err(unsupported("zero sectors per cluster")),
        value if value <= 0x80 => value as u32,
        value => {
            let shift = 256u32 - value as u32;
            if shift >= 32 {
                return Err(unsupported("cluster size overflow"));
            }
            1u32 << shift
        }
    };
    let bytes_per_cluster = bytes_per_sector
        .checked_mul(sectors_per_cluster)
        .ok_or_else(|| unsupported("cluster size overflow"))?;

    let mft_start_lcn = u64_at(sector, 0x30).unwrap_or(0);
    if mft_start_lcn == 0 {
        return Err(unsupported("zero MFT start cluster"));
    }

    // Same encoding trick: negative means "1 << abs", positive means clusters.
    let raw_cpr = sector[0x40] as i8;
    let bytes_per_record: u32 = if raw_cpr < 0 {
        let shift = (-(raw_cpr as i32)) as u32;
        if shift >= 32 {
            return Err(unsupported("record size overflow"));
        }
        1u32 << shift
    } else {
        (raw_cpr as u32)
            .checked_mul(bytes_per_cluster)
            .ok_or_else(|| unsupported("record size overflow"))?
    };
    if !(256..=65536).contains(&bytes_per_record) || !bytes_per_record.is_power_of_two() {
        return Err(unsupported(format!("bad record size {bytes_per_record}")));
    }

    Ok(Geometry {
        bytes_per_sector,
        bytes_per_cluster,
        mft_start_lcn,
        bytes_per_record,
    })
}

// ── Update sequence (fixup) array ───────────────────────────────────────────

/// Restore the bytes NTFS overwrote with the update sequence number.
///
/// NTFS replaces the last two bytes of every sector in a record with a single
/// per-record USN so a torn write is detectable. Reading a multi-sector record
/// without undoing this yields two corrupt bytes per sector, which lands right
/// in the middle of attribute headers. Returns false if the record fails the
/// integrity check (a torn write, or not a record at all).
pub(crate) fn apply_fixups(record: &mut [u8], bytes_per_sector: usize) -> bool {
    if bytes_per_sector < 4 {
        return false;
    }
    let usa_offset = match u16_at(record, 0x04) {
        Some(value) => value as usize,
        None => return false,
    };
    let usa_count = match u16_at(record, 0x06) {
        Some(value) => value as usize,
        None => return false,
    };
    // The array is the USN followed by one saved word per sector.
    if usa_count == 0 || usa_offset < 0x2A {
        return false;
    }
    if usa_offset + usa_count * 2 > record.len() {
        return false;
    }
    let usn = [record[usa_offset], record[usa_offset + 1]];

    for sector_index in 1..usa_count {
        let sector_end = sector_index * bytes_per_sector;
        if sector_end < 2 || sector_end > record.len() {
            return false;
        }
        let target = sector_end - 2;
        // Every patched slot must still hold the USN. If it doesn't, the record
        // was written torn and its contents can't be trusted.
        if record[target] != usn[0] || record[target + 1] != usn[1] {
            return false;
        }
        let source = usa_offset + sector_index * 2;
        record[target] = record[source];
        record[target + 1] = record[source + 1];
    }
    true
}

// ── Data runs ───────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Run {
    /// `None` for a sparse run (no clusters allocated).
    pub(crate) lcn: Option<u64>,
    pub(crate) clusters: u64,
}

/// Decode a non-resident attribute's run list.
///
/// Each entry is a header byte (low nibble = byte count of the length field,
/// high nibble = byte count of the offset field) followed by those two fields.
/// The offset is SIGNED and relative to the previous run's start cluster, so the
/// list has to be walked in order to resolve absolute positions.
pub(crate) fn parse_data_runs(bytes: &[u8]) -> Vec<Run> {
    let mut runs = Vec::new();
    let mut at = 0usize;
    let mut current_lcn: i64 = 0;

    while at < bytes.len() {
        let header = bytes[at];
        if header == 0 {
            break; // end of list
        }
        let length_bytes = (header & 0x0F) as usize;
        let offset_bytes = (header >> 4) as usize;
        if length_bytes == 0 || length_bytes > 8 || offset_bytes > 8 {
            break; // malformed
        }
        at += 1;

        let Some(length_field) = bytes.get(at..at + length_bytes) else {
            break;
        };
        let mut clusters: u64 = 0;
        for (i, byte) in length_field.iter().enumerate() {
            clusters |= (*byte as u64) << (8 * i);
        }
        at += length_bytes;

        if offset_bytes == 0 {
            // Sparse: the run occupies VCNs but no clusters on disk.
            runs.push(Run {
                lcn: None,
                clusters,
            });
            continue;
        }

        let Some(offset_field) = bytes.get(at..at + offset_bytes) else {
            break;
        };
        // Sign-extend the little-endian delta from its byte width.
        let mut delta: i64 = 0;
        for (i, byte) in offset_field.iter().enumerate() {
            delta |= (*byte as i64) << (8 * i);
        }
        let sign_bit = 1i64 << (offset_bytes * 8 - 1);
        if delta & sign_bit != 0 {
            delta -= 1i64 << (offset_bytes * 8);
        }
        at += offset_bytes;

        current_lcn = current_lcn.saturating_add(delta);
        if current_lcn < 0 {
            break; // corrupt list
        }
        runs.push(Run {
            lcn: Some(current_lcn as u64),
            clusters,
        });
    }

    runs
}

// ── Record parsing ──────────────────────────────────────────────────────────

const ATTR_STANDARD_INFORMATION: u32 = 0x10;
const ATTR_FILE_NAME: u32 = 0x30;
const ATTR_DATA: u32 = 0x80;
const ATTR_END: u32 = 0xFFFF_FFFF;

const FLAG_RECORD_IN_USE: u16 = 0x0001;
const FLAG_RECORD_IS_DIRECTORY: u16 = 0x0002;

/// Filename namespace. A file with a short (8.3) name has two `$FILE_NAME`
/// attributes; the DOS one must lose, or the tree fills up with `PROGRA~1`.
const NAMESPACE_DOS: u8 = 2;

/// One parsed MFT record, flattened to just what a scan row needs.
#[derive(Clone, Debug, Default)]
pub(crate) struct MftEntry {
    /// Parent directory's MFT record number.
    pub(crate) parent: u32,
    pub(crate) name: String,
    pub(crate) size: u64,
    pub(crate) allocated: u64,
    pub(crate) created_ms: u64,
    pub(crate) modified_ms: u64,
    pub(crate) accessed_ms: u64,
    pub(crate) attributes: u32,
    pub(crate) is_dir: bool,
    pub(crate) is_reparse: bool,
    /// False for records that are free, corrupt, or nameless — skip them.
    pub(crate) present: bool,
}

/// Sizes found on an extension record, to be folded into its base record.
///
/// A file with enough fragments or streams spills attributes into further MFT
/// records referenced by an `$ATTRIBUTE_LIST`. Those records aren't files in
/// their own right, but they can carry the `$DATA` header holding the real
/// size, so dropping them outright would report such files as 0 bytes.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ExtensionSize {
    pub(crate) base: u32,
    pub(crate) size: u64,
    pub(crate) allocated: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DataSizes {
    /// Content stored inside the record: no clusters allocated on disk.
    Resident(u64),
    /// `(real_size, allocated_size)` from the first extent's header.
    NonResident(u64, u64),
}

/// Outcome of parsing one record slot.
pub(crate) enum ParsedRecord {
    /// A file or directory.
    Entry(MftEntry),
    /// An extension record whose `$DATA` header belongs to `base`.
    Extension(ExtensionSize),
    /// Free slot, not a record, or nothing usable in it.
    Skip,
}

/// Parse a single MFT record. `record` must already have had fixups applied.
pub(crate) fn parse_record(record: &[u8]) -> ParsedRecord {
    if record.len() < 0x30 || &record[0..4] != b"FILE" {
        return ParsedRecord::Skip;
    }
    let flags = u16_at(record, 0x16).unwrap_or(0);
    if flags & FLAG_RECORD_IN_USE == 0 {
        return ParsedRecord::Skip; // deleted; its clusters are already free
    }
    let is_dir = flags & FLAG_RECORD_IS_DIRECTORY != 0;

    // A non-zero base reference means this record only holds spill-over
    // attributes for another record.
    let base_reference = u64_at(record, 0x20).unwrap_or(0);
    let base_index = base_reference & 0x0000_FFFF_FFFF_FFFF;

    let first_attribute = u16_at(record, 0x14).unwrap_or(0) as usize;
    let declared_len = u32_at(record, 0x18).unwrap_or(0) as usize;
    // Trust the smaller of "record says" and "buffer is" so a corrupt length
    // can't walk us out of the slot.
    let limit = declared_len.clamp(first_attribute, record.len());

    let mut name: Option<(String, u8)> = None;
    let mut parent: u32 = 0;
    let mut sizes: Option<DataSizes> = None;
    let mut created_ms = 0u64;
    let mut modified_ms = 0u64;
    let mut accessed_ms = 0u64;
    let mut attributes = 0u32;
    let mut name_flags = 0u32;

    let mut at = first_attribute;
    while at + 4 <= limit {
        let attr_type = match u32_at(record, at) {
            Some(value) => value,
            None => break,
        };
        if attr_type == ATTR_END {
            break;
        }
        let attr_len = u32_at(record, at + 4).unwrap_or(0) as usize;
        // A zero or unaligned length would loop forever.
        if attr_len < 16 || at + attr_len > limit {
            break;
        }
        let attr = &record[at..at + attr_len];
        let non_resident = attr.get(8).copied().unwrap_or(0) != 0;
        let attr_name_len = attr.get(9).copied().unwrap_or(0);

        match attr_type {
            ATTR_STANDARD_INFORMATION if !non_resident => {
                if let Some(value) = resident_value(attr) {
                    created_ms = filetime_to_ms(u64_at(value, 0x00).unwrap_or(0));
                    modified_ms = filetime_to_ms(u64_at(value, 0x08).unwrap_or(0));
                    accessed_ms = filetime_to_ms(u64_at(value, 0x18).unwrap_or(0));
                    attributes = u32_at(value, 0x20).unwrap_or(0);
                }
            }
            ATTR_FILE_NAME if !non_resident => {
                if let Some((candidate, namespace, parent_index, flags)) =
                    resident_value(attr).and_then(parse_file_name)
                {
                    // Prefer any real name over the 8.3 alias; among real names
                    // the first wins (hard links share one record).
                    let better = match &name {
                        None => true,
                        Some((_, existing)) => {
                            *existing == NAMESPACE_DOS && namespace != NAMESPACE_DOS
                        }
                    };
                    if better {
                        name = Some((candidate, namespace));
                        parent = parent_index;
                        name_flags = flags;
                    }
                }
            }
            // Only the unnamed stream is the file's content; named streams
            // ($DATA with a name) are alternate data streams.
            ATTR_DATA if attr_name_len == 0 => {
                if let Some(found) = data_sizes(attr, non_resident) {
                    // The first extent (starting VCN 0) is the one that carries
                    // the real/allocated sizes for the whole stream.
                    if sizes.is_none() {
                        sizes = Some(found);
                    }
                }
            }
            _ => {}
        }

        at += attr_len;
    }

    if base_index != 0 {
        // Spill-over record: hand any size it carried to the base record.
        let base = u32::try_from(base_index).unwrap_or(0);
        return match (base, sizes) {
            (0, _) | (_, None) => ParsedRecord::Skip,
            (base, Some(DataSizes::Resident(size))) => ParsedRecord::Extension(ExtensionSize {
                base,
                size,
                allocated: 0,
            }),
            (base, Some(DataSizes::NonResident(size, allocated))) => {
                ParsedRecord::Extension(ExtensionSize {
                    base,
                    size,
                    allocated,
                })
            }
        };
    }

    let Some((name, _)) = name else {
        return ParsedRecord::Skip; // no usable name: not a tree node
    };

    // `$STANDARD_INFORMATION` is authoritative for attributes; the copy in
    // `$FILE_NAME` is the fallback for records missing it.
    let attributes = if attributes != 0 { attributes } else { name_flags };
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

    let (size, allocated) = match sizes {
        // Directories have no content of their own; their size is the sum of
        // their children, which the aggregation pass computes.
        _ if is_dir => (0, 0),
        Some(DataSizes::Resident(size)) => (size, 0),
        Some(DataSizes::NonResident(size, allocated)) => (size, allocated),
        None => (0, 0),
    };

    ParsedRecord::Entry(MftEntry {
        parent,
        name,
        size,
        allocated,
        created_ms,
        modified_ms,
        accessed_ms,
        attributes,
        is_dir,
        is_reparse: attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0,
        present: true,
    })
}

/// Body of a resident attribute (`value_length` bytes at `value_offset`).
fn resident_value(attr: &[u8]) -> Option<&[u8]> {
    let length = u32_at(attr, 0x10)? as usize;
    let offset = u16_at(attr, 0x14)? as usize;
    attr.get(offset..offset.checked_add(length)?)
}

/// `(name, namespace, parent record number, attribute flags)` from `$FILE_NAME`.
fn parse_file_name(value: &[u8]) -> Option<(String, u8, u32, u32)> {
    let parent_reference = u64_at(value, 0x00)?;
    let parent_index = parent_reference & 0x0000_FFFF_FFFF_FFFF;
    let parent = u32::try_from(parent_index).ok()?;
    let flags = u32_at(value, 0x38).unwrap_or(0);
    let name_chars = *value.get(0x40)? as usize;
    let namespace = *value.get(0x41)?;
    if name_chars == 0 {
        return None;
    }
    let bytes = value.get(0x42..0x42 + name_chars * 2)?;
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    // Lossy: NTFS permits unpaired surrogates that Rust strings cannot hold.
    Some((
        String::from_utf16_lossy(&units),
        namespace,
        parent,
        flags,
    ))
}

/// Sizes from a `$DATA` header, or `None` for extents that don't carry them.
fn data_sizes(attr: &[u8], non_resident: bool) -> Option<DataSizes> {
    if !non_resident {
        return Some(DataSizes::Resident(u32_at(attr, 0x10)? as u64));
    }
    // Later extents of a fragmented stream repeat the header with a non-zero
    // starting VCN and stale sizes; only extent 0 is meaningful.
    if u64_at(attr, 0x10)? != 0 {
        return None;
    }
    let allocated = u64_at(attr, 0x28)?;
    let real = u64_at(attr, 0x30)?;
    Some(DataSizes::NonResident(real, allocated))
}

// ── The parsed table ────────────────────────────────────────────────────────

/// Every live record on a volume, indexed by MFT record number.
pub(crate) struct MftIndex {
    pub(crate) entries: Vec<MftEntry>,
    /// Records whose fixup check failed — a torn write or a layout surprise.
    pub(crate) corrupt: u64,
}

impl MftIndex {
    pub(crate) fn get(&self, index: u32) -> Option<&MftEntry> {
        self.entries
            .get(index as usize)
            .filter(|entry| entry.present)
    }

    /// Resolve an absolute path to its MFT record number by walking down from
    /// the root directory. Case-insensitive, like the filesystem itself.
    ///
    /// `children` must be the parent → children map for this index.
    pub(crate) fn resolve(&self, children: &[Vec<u32>], components: &[&str]) -> Option<u32> {
        let mut current = ROOT_RECORD;
        for component in components {
            let candidates = children.get(current as usize)?;
            let next = candidates.iter().copied().find(|candidate| {
                self.get(*candidate)
                    .is_some_and(|entry| entry.name.eq_ignore_ascii_case(component))
            })?;
            current = next;
        }
        Some(current)
    }

    /// Parent → children map. Built once and shared by path resolution and the
    /// tree walk, since both need it and it is O(records) to produce.
    ///
    /// Self-parented records (only the root) and entries pointing at a parent
    /// that isn't a live directory are dropped: they would either loop forever
    /// or hang a subtree off nothing.
    pub(crate) fn children_map(&self) -> Vec<Vec<u32>> {
        let mut map: Vec<Vec<u32>> = vec![Vec::new(); self.entries.len()];
        for (index, entry) in self.entries.iter().enumerate() {
            if !entry.present {
                continue;
            }
            let index = match u32::try_from(index) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if index == ROOT_RECORD || entry.parent == index {
                continue;
            }
            let parent_is_dir = self
                .get(entry.parent)
                .is_some_and(|parent| parent.is_dir);
            if !parent_is_dir {
                continue;
            }
            if let Some(bucket) = map.get_mut(entry.parent as usize) {
                bucket.push(index);
            }
        }
        map
    }
}

// ── Volume access (Windows only) ────────────────────────────────────────────

/// The drive letter a path lives on, if it has one. UNC paths have none, and
/// there is no MFT to read for them.
pub(crate) fn volume_letter(path: &Path) -> Option<char> {
    let text = path.to_str()?;
    let mut chars = text.chars();
    let letter = chars.next()?;
    if !letter.is_ascii_alphabetic() || chars.next()? != ':' {
        return None;
    }
    Some(letter.to_ascii_uppercase())
}

/// Whether `path` is a bare volume root (`C:\`), the case where reading the
/// whole table is unambiguously the right trade.
pub(crate) fn is_volume_root(path: &Path) -> bool {
    let Some(text) = path.to_str() else {
        return false;
    };
    let trimmed = text.trim_end_matches(['\\', '/']);
    trimmed.len() == 2 && volume_letter(path).is_some()
}

/// Path components below the volume root, e.g. `C:\Users\alex` → `["Users","dan"]`.
pub(crate) fn components_below_root(path: &Path) -> Vec<&str> {
    let Some(text) = path.to_str() else {
        return Vec::new();
    };
    let after_letter = text.get(2..).unwrap_or("");
    after_letter
        .split(['\\', '/'])
        .filter(|part| !part.is_empty() && *part != ".")
        .collect()
}

#[cfg(windows)]
mod volume {
    use super::{MftError, STREAM_CHUNK_BYTES};
    use std::io;

    // Handle spelling matches the rest of the crate's Win32 declarations
    // (`fileattr.rs`), so the linker sees one consistent signature per symbol.
    type Handle = *mut std::ffi::c_void;
    const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
    const GENERIC_READ: u32 = 0x8000_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const OPEN_EXISTING: u32 = 3;
    const ERROR_ACCESS_DENIED: u32 = 5;
    const FILE_BEGIN: u32 = 0;

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
        fn ReadFile(
            hFile: Handle,
            lpBuffer: *mut u8,
            nNumberOfBytesToRead: u32,
            lpNumberOfBytesRead: *mut u32,
            lpOverlapped: *mut u8,
        ) -> i32;
        fn SetFilePointerEx(
            hFile: Handle,
            liDistanceToMove: i64,
            lpNewFilePointer: *mut i64,
            dwMoveMethod: u32,
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

    /// Cheap pre-flight so a non-NTFS volume never triggers an elevation-only
    /// open attempt. Needs no special rights.
    pub(super) fn is_ntfs(letter: char) -> bool {
        let root = wide(&format!("{letter}:\\"));
        let mut name = [0u16; 16];
        let ok = unsafe {
            GetVolumeInformationW(
                root.as_ptr(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                name.as_mut_ptr(),
                name.len() as u32,
            )
        };
        if ok == 0 {
            return false;
        }
        let end = name.iter().position(|c| *c == 0).unwrap_or(name.len());
        String::from_utf16_lossy(&name[..end]).eq_ignore_ascii_case("NTFS")
    }

    /// A raw read handle on `\\.\X:`. Reads must be sector-aligned in both
    /// offset and length, which every caller here satisfies by working in whole
    /// clusters.
    pub(super) struct VolumeReader {
        handle: Handle,
    }

    impl VolumeReader {
        pub(super) fn open(letter: char) -> Result<Self, MftError> {
            // Trailing backslash omitted deliberately: `\\.\C:\` opens the
            // filesystem root, `\\.\C:` opens the volume itself.
            let path = wide(&format!("\\\\.\\{letter}:"));
            let handle = unsafe {
                CreateFileW(
                    path.as_ptr(),
                    GENERIC_READ,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    std::ptr::null_mut(),
                    OPEN_EXISTING,
                    0,
                    std::ptr::null_mut(),
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                let error = unsafe { GetLastError() };
                return Err(if error == ERROR_ACCESS_DENIED {
                    MftError::AccessDenied
                } else {
                    MftError::Io(io::Error::from_raw_os_error(error as i32))
                });
            }
            Ok(Self { handle })
        }

        /// Fill `buf` from `offset`, following short reads until it is full or
        /// the device stops returning data.
        pub(super) fn read_exact_at(&self, offset: u64, buf: &mut [u8]) -> Result<usize, MftError> {
            let moved = unsafe {
                SetFilePointerEx(self.handle, offset as i64, std::ptr::null_mut(), FILE_BEGIN)
            };
            if moved == 0 {
                let error = unsafe { GetLastError() };
                return Err(MftError::Io(io::Error::from_raw_os_error(error as i32)));
            }

            let mut filled = 0usize;
            while filled < buf.len() {
                let want = (buf.len() - filled).min(STREAM_CHUNK_BYTES) as u32;
                let mut read = 0u32;
                let ok = unsafe {
                    ReadFile(
                        self.handle,
                        buf[filled..].as_mut_ptr(),
                        want,
                        &mut read,
                        std::ptr::null_mut(),
                    )
                };
                if ok == 0 {
                    let error = unsafe { GetLastError() };
                    return Err(MftError::Io(io::Error::from_raw_os_error(error as i32)));
                }
                if read == 0 {
                    break; // end of volume
                }
                filled += read as usize;
            }
            Ok(filled)
        }
    }

    impl Drop for VolumeReader {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.handle) };
        }
    }
}

// ── Reading the table ───────────────────────────────────────────────────────

/// Read and parse the whole MFT of the volume holding `letter`.
///
/// `progress` is called with the running live-record count as chunks land, so a
/// long read can report movement. `cancel` is honoured between chunks.
#[cfg(windows)]
pub(crate) fn read_index<F>(
    letter: char,
    cancel: &AtomicBool,
    mut progress: F,
) -> Result<MftIndex, MftError>
where
    F: FnMut(u64),
{
    use volume::VolumeReader;

    if !volume::is_ntfs(letter) {
        return Err(unsupported("not an NTFS volume"));
    }
    let reader = VolumeReader::open(letter)?;

    // Geometry first: everything else is expressed in its units.
    let mut boot = vec![0u8; 512];
    reader.read_exact_at(0, &mut boot)?;
    let geometry = parse_boot_sector(&boot)?;

    let cluster = geometry.bytes_per_cluster as usize;
    let record_size = geometry.bytes_per_record as usize;
    let sector = geometry.bytes_per_sector as usize;

    // Record 0 IS the MFT. Its $DATA run list is the only map of the rest.
    let mut first_cluster = vec![0u8; cluster.max(record_size)];
    let mft_offset = geometry
        .mft_start_lcn
        .checked_mul(geometry.bytes_per_cluster as u64)
        .ok_or_else(|| unsupported("MFT offset overflow"))?;
    reader.read_exact_at(mft_offset, &mut first_cluster)?;

    let mut record_zero = first_cluster[..record_size].to_vec();
    if !apply_fixups(&mut record_zero, sector) {
        return Err(unsupported("MFT record 0 failed its integrity check"));
    }
    let (runs, mft_bytes) = mft_data_runs(&record_zero)?;
    if runs.is_empty() || mft_bytes == 0 {
        return Err(unsupported("MFT has no data runs"));
    }

    let record_count = (mft_bytes / geometry.bytes_per_record as u64) as usize;
    let mut index = MftIndex {
        entries: vec![MftEntry::default(); record_count],
        corrupt: 0,
    };
    let mut extensions: Vec<ExtensionSize> = Vec::new();
    let mut live = 0u64;

    // Chunks must hold whole records and whole sectors. Both sizes are powers
    // of two, so rounding down to a multiple of the larger satisfies both.
    let stride = record_size.max(cluster);
    let chunk_bytes = (STREAM_CHUNK_BYTES / stride).max(1) * stride;
    let mut buffer = vec![0u8; chunk_bytes];

    // Byte position within the MFT's own address space, which is what maps to
    // record numbers. Sparse runs advance it without contributing records.
    let mut stream_position: u64 = 0;

    'runs: for run in runs {
        let run_bytes = run.clusters.saturating_mul(geometry.bytes_per_cluster as u64);
        let Some(run_lcn) = run.lcn else {
            stream_position = stream_position.saturating_add(run_bytes);
            continue;
        };

        let mut consumed = 0u64;
        while consumed < run_bytes {
            if cancel.load(Ordering::Relaxed) {
                return Err(MftError::Cancelled);
            }
            if stream_position >= mft_bytes {
                break 'runs; // past the table's real size
            }

            let want = (run_bytes - consumed).min(chunk_bytes as u64) as usize;
            let disk_offset = run_lcn
                .checked_mul(geometry.bytes_per_cluster as u64)
                .and_then(|base| base.checked_add(consumed))
                .ok_or_else(|| unsupported("run offset overflow"))?;

            let filled = reader.read_exact_at(disk_offset, &mut buffer[..want])?;
            if filled == 0 {
                break;
            }

            for slot in buffer[..filled].chunks_mut(record_size) {
                if slot.len() < record_size {
                    break;
                }
                let record_number = stream_position / geometry.bytes_per_record as u64;
                stream_position += geometry.bytes_per_record as u64;
                if record_number >= record_count as u64 {
                    continue;
                }

                // A free slot is not an error and is not worth a fixup pass.
                if &slot[0..4] != b"FILE" {
                    continue;
                }
                if !apply_fixups(slot, sector) {
                    index.corrupt += 1;
                    continue;
                }
                match parse_record(slot) {
                    ParsedRecord::Entry(entry) => {
                        index.entries[record_number as usize] = entry;
                        live += 1;
                    }
                    ParsedRecord::Extension(extension) => extensions.push(extension),
                    ParsedRecord::Skip => {}
                }
            }

            consumed += filled as u64;
            progress(live);
        }
    }

    // Fold spill-over sizes into their base records, but never over a size the
    // base already reported.
    for extension in extensions {
        if let Some(entry) = index
            .entries
            .get_mut(extension.base as usize)
            .filter(|entry| entry.present && !entry.is_dir && entry.size == 0)
        {
            entry.size = extension.size;
            entry.allocated = extension.allocated;
        }
    }

    Ok(index)
}

#[cfg(not(windows))]
pub(crate) fn read_index<F>(
    _letter: char,
    _cancel: &AtomicBool,
    _progress: F,
) -> Result<MftIndex, MftError>
where
    F: FnMut(u64),
{
    Err(unsupported("MFT scanning is Windows-only"))
}

/// The MFT's own extent list and total size, from record 0's unnamed `$DATA`.
fn mft_data_runs(record_zero: &[u8]) -> Result<(Vec<Run>, u64), MftError> {
    let first_attribute = u16_at(record_zero, 0x14).unwrap_or(0) as usize;
    let declared_len = u32_at(record_zero, 0x18).unwrap_or(0) as usize;
    let limit = declared_len.clamp(first_attribute, record_zero.len());

    let mut at = first_attribute;
    while at + 4 <= limit {
        let attr_type = u32_at(record_zero, at).unwrap_or(ATTR_END);
        if attr_type == ATTR_END {
            break;
        }
        let attr_len = u32_at(record_zero, at + 4).unwrap_or(0) as usize;
        if attr_len < 16 || at + attr_len > limit {
            break;
        }
        let attr = &record_zero[at..at + attr_len];
        let non_resident = attr.get(8).copied().unwrap_or(0) != 0;
        let attr_name_len = attr.get(9).copied().unwrap_or(0);

        if attr_type == ATTR_DATA && attr_name_len == 0 && non_resident {
            let run_offset = u16_at(attr, 0x20).unwrap_or(0) as usize;
            let real_size = u64_at(attr, 0x30).unwrap_or(0);
            let allocated = u64_at(attr, 0x28).unwrap_or(0);
            let runs = attr
                .get(run_offset..)
                .map(parse_data_runs)
                .unwrap_or_default();
            // `real_size` can lag the allocation on the MFT itself; take the
            // larger so a chunk of the table is never left unread.
            return Ok((runs, real_size.max(allocated)));
        }
        at += attr_len;
    }

    Err(unsupported("MFT record 0 has no non-resident $DATA"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal but structurally real boot sector.
    fn boot_sector(sectors_per_cluster: u8, clusters_per_record: i8) -> Vec<u8> {
        let mut sector = vec![0u8; 512];
        sector[3..11].copy_from_slice(b"NTFS    ");
        sector[0x0B..0x0D].copy_from_slice(&512u16.to_le_bytes());
        sector[0x0D] = sectors_per_cluster;
        sector[0x30..0x38].copy_from_slice(&786_432u64.to_le_bytes());
        sector[0x40] = clusters_per_record as u8;
        sector
    }

    #[test]
    fn boot_sector_yields_geometry() {
        let geometry = parse_boot_sector(&boot_sector(8, -10)).expect("should parse");
        assert_eq!(geometry.bytes_per_sector, 512);
        assert_eq!(geometry.bytes_per_cluster, 4096);
        assert_eq!(geometry.mft_start_lcn, 786_432);
        // Negative clusters-per-record encodes 1 << 10 = 1 KiB records.
        assert_eq!(geometry.bytes_per_record, 1024);
    }

    #[test]
    fn boot_sector_accepts_positive_clusters_per_record() {
        let geometry = parse_boot_sector(&boot_sector(1, 2)).expect("should parse");
        assert_eq!(geometry.bytes_per_cluster, 512);
        assert_eq!(geometry.bytes_per_record, 1024);
    }

    #[test]
    fn boot_sector_rejects_foreign_filesystem() {
        let mut sector = boot_sector(8, -10);
        sector[3..11].copy_from_slice(b"EXFAT   ");
        assert!(parse_boot_sector(&sector).is_err());
    }

    #[test]
    fn boot_sector_rejects_zero_mft_start() {
        let mut sector = boot_sector(8, -10);
        sector[0x30..0x38].copy_from_slice(&0u64.to_le_bytes());
        assert!(parse_boot_sector(&sector).is_err());
    }

    #[test]
    fn fixups_restore_patched_sector_tails() {
        // Two 512-byte sectors, USN 0xBEEF, saved words 0x1111 and 0x2222.
        let mut record = vec![0u8; 1024];
        record[0..4].copy_from_slice(b"FILE");
        let usa_offset = 0x30usize;
        record[0x04..0x06].copy_from_slice(&(usa_offset as u16).to_le_bytes());
        record[0x06..0x08].copy_from_slice(&3u16.to_le_bytes());
        record[usa_offset..usa_offset + 2].copy_from_slice(&0xBEEFu16.to_le_bytes());
        record[usa_offset + 2..usa_offset + 4].copy_from_slice(&0x1111u16.to_le_bytes());
        record[usa_offset + 4..usa_offset + 6].copy_from_slice(&0x2222u16.to_le_bytes());
        // Both sector tails currently hold the USN, as NTFS leaves them.
        record[510..512].copy_from_slice(&0xBEEFu16.to_le_bytes());
        record[1022..1024].copy_from_slice(&0xBEEFu16.to_le_bytes());

        assert!(apply_fixups(&mut record, 512));
        assert_eq!(&record[510..512], &0x1111u16.to_le_bytes());
        assert_eq!(&record[1022..1024], &0x2222u16.to_le_bytes());
    }

    #[test]
    fn fixups_reject_torn_write() {
        let mut record = vec![0u8; 1024];
        record[0..4].copy_from_slice(b"FILE");
        record[0x04..0x06].copy_from_slice(&0x30u16.to_le_bytes());
        record[0x06..0x08].copy_from_slice(&3u16.to_le_bytes());
        record[0x30..0x32].copy_from_slice(&0xBEEFu16.to_le_bytes());
        record[510..512].copy_from_slice(&0xBEEFu16.to_le_bytes());
        // Second sector tail does NOT match the USN: the write was torn.
        record[1022..1024].copy_from_slice(&0xDEADu16.to_le_bytes());
        assert!(!apply_fixups(&mut record, 512));
    }

    #[test]
    fn data_runs_decode_relative_offsets() {
        // 0x21 = 1 length byte, 2 offset bytes → 0x28 clusters at +0x0134.
        // 0x11 = 1 length byte, 1 offset byte  → 0x10 clusters at +0x20 further.
        let bytes = [0x21, 0x28, 0x34, 0x01, 0x11, 0x10, 0x20, 0x00];
        let runs = parse_data_runs(&bytes);
        assert_eq!(
            runs,
            vec![
                Run {
                    lcn: Some(0x0134),
                    clusters: 0x28
                },
                Run {
                    lcn: Some(0x0154),
                    clusters: 0x10
                },
            ]
        );
    }

    #[test]
    fn data_runs_handle_negative_offsets_and_sparse_runs() {
        // A backwards jump (signed delta) then a sparse run (no offset field).
        let bytes = [0x11, 0x08, 0x40, 0x11, 0x04, 0xF0, 0x01, 0x02, 0x00];
        let runs = parse_data_runs(&bytes);
        assert_eq!(runs.len(), 3);
        assert_eq!(runs[0].lcn, Some(0x40));
        // 0xF0 as a signed byte is -16, so 0x40 - 0x10 = 0x30.
        assert_eq!(runs[1].lcn, Some(0x30));
        assert_eq!(runs[2].lcn, None, "offset width 0 means sparse");
        assert_eq!(runs[2].clusters, 2);
    }

    #[test]
    fn data_runs_stop_at_terminator() {
        let bytes = [0x11, 0x02, 0x10, 0x00, 0x11, 0x02, 0x20];
        assert_eq!(parse_data_runs(&bytes).len(), 1);
    }

    /// Build a one-sector record with the given attributes appended.
    fn record_with(flags: u16, base_reference: u64, attributes: &[Vec<u8>]) -> Vec<u8> {
        let mut record = vec![0u8; 1024];
        record[0..4].copy_from_slice(b"FILE");
        record[0x04..0x06].copy_from_slice(&0x30u16.to_le_bytes());
        record[0x06..0x08].copy_from_slice(&1u16.to_le_bytes()); // USN only: no patches
        record[0x14..0x16].copy_from_slice(&0x38u16.to_le_bytes());
        record[0x16..0x18].copy_from_slice(&flags.to_le_bytes());
        record[0x20..0x28].copy_from_slice(&base_reference.to_le_bytes());

        let mut at = 0x38usize;
        for attribute in attributes {
            record[at..at + attribute.len()].copy_from_slice(attribute);
            at += attribute.len();
        }
        record[at..at + 4].copy_from_slice(&ATTR_END.to_le_bytes());
        record[0x18..0x1C].copy_from_slice(&((at + 4) as u32).to_le_bytes());
        record
    }

    fn standard_information(created: u64, modified: u64, attributes: u32) -> Vec<u8> {
        let value_len = 0x48usize;
        let mut attr = vec![0u8; 0x18 + value_len];
        let total = attr.len() as u32;
        attr[0x00..0x04].copy_from_slice(&ATTR_STANDARD_INFORMATION.to_le_bytes());
        attr[0x04..0x08].copy_from_slice(&total.to_le_bytes());
        attr[0x10..0x14].copy_from_slice(&(value_len as u32).to_le_bytes());
        attr[0x14..0x16].copy_from_slice(&0x18u16.to_le_bytes());
        let value = 0x18usize;
        attr[value..value + 8].copy_from_slice(&created.to_le_bytes());
        attr[value + 0x08..value + 0x10].copy_from_slice(&modified.to_le_bytes());
        attr[value + 0x20..value + 0x24].copy_from_slice(&attributes.to_le_bytes());
        attr
    }

    fn file_name(name: &str, namespace: u8, parent: u32) -> Vec<u8> {
        let units: Vec<u16> = name.encode_utf16().collect();
        let value_len = 0x42 + units.len() * 2;
        let mut attr = vec![0u8; 0x18 + value_len];
        let total = attr.len() as u32;
        attr[0x00..0x04].copy_from_slice(&ATTR_FILE_NAME.to_le_bytes());
        attr[0x04..0x08].copy_from_slice(&total.to_le_bytes());
        attr[0x10..0x14].copy_from_slice(&(value_len as u32).to_le_bytes());
        attr[0x14..0x16].copy_from_slice(&0x18u16.to_le_bytes());
        let value = 0x18usize;
        attr[value..value + 8].copy_from_slice(&(parent as u64).to_le_bytes());
        attr[value + 0x40] = units.len() as u8;
        attr[value + 0x41] = namespace;
        for (i, unit) in units.iter().enumerate() {
            let at = value + 0x42 + i * 2;
            attr[at..at + 2].copy_from_slice(&unit.to_le_bytes());
        }
        attr
    }

    fn non_resident_data(real: u64, allocated: u64, starting_vcn: u64) -> Vec<u8> {
        let mut attr = vec![0u8; 0x48];
        let total = attr.len() as u32;
        attr[0x00..0x04].copy_from_slice(&ATTR_DATA.to_le_bytes());
        attr[0x04..0x08].copy_from_slice(&total.to_le_bytes());
        attr[0x08] = 1; // non-resident
        attr[0x10..0x18].copy_from_slice(&starting_vcn.to_le_bytes());
        attr[0x20..0x22].copy_from_slice(&0x40u16.to_le_bytes());
        attr[0x28..0x30].copy_from_slice(&allocated.to_le_bytes());
        attr[0x30..0x38].copy_from_slice(&real.to_le_bytes());
        attr
    }

    fn resident_data(size: u32) -> Vec<u8> {
        let mut attr = vec![0u8; 0x18 + size as usize];
        let total = attr.len() as u32;
        attr[0x00..0x04].copy_from_slice(&ATTR_DATA.to_le_bytes());
        attr[0x04..0x08].copy_from_slice(&total.to_le_bytes());
        attr[0x10..0x14].copy_from_slice(&size.to_le_bytes());
        attr[0x14..0x16].copy_from_slice(&0x18u16.to_le_bytes());
        attr
    }

    fn expect_entry(parsed: ParsedRecord) -> MftEntry {
        match parsed {
            ParsedRecord::Entry(entry) => entry,
            ParsedRecord::Extension(_) => panic!("expected an entry, got an extension record"),
            ParsedRecord::Skip => panic!("expected an entry, record was skipped"),
        }
    }

    #[test]
    fn parses_a_file_record() {
        // 2001-09-09T01:46:40Z (Unix ms 1_000_000_000_000) in FILETIME ticks:
        // ms * 10_000 + the 1601→1970 epoch offset.
        let created = 126_444_736_000_000_000u64;
        let record = record_with(
            FLAG_RECORD_IN_USE,
            0,
            &[
                standard_information(created, created, 0x20),
                file_name("report.pdf", 1, 5),
                non_resident_data(4096, 8192, 0),
            ],
        );
        let entry = expect_entry(parse_record(&record));
        assert_eq!(entry.name, "report.pdf");
        assert_eq!(entry.parent, 5);
        assert_eq!(entry.size, 4096);
        assert_eq!(entry.allocated, 8192, "allocated is the on-disk footprint");
        assert!(!entry.is_dir);
        assert_eq!(entry.attributes, 0x20);
        assert_eq!(entry.created_ms, 1_000_000_000_000);
    }

    #[test]
    fn prefers_the_long_name_over_the_dos_alias() {
        let record = record_with(
            FLAG_RECORD_IN_USE,
            0,
            &[
                file_name("PROGRA~1", NAMESPACE_DOS, 5),
                file_name("Program Files", 1, 5),
            ],
        );
        assert_eq!(expect_entry(parse_record(&record)).name, "Program Files");
    }

    #[test]
    fn keeps_the_dos_name_when_it_is_the_only_one() {
        let record = record_with(
            FLAG_RECORD_IN_USE,
            0,
            &[file_name("PROGRA~1", NAMESPACE_DOS, 5)],
        );
        assert_eq!(expect_entry(parse_record(&record)).name, "PROGRA~1");
    }

    #[test]
    fn directory_size_is_left_for_aggregation() {
        let record = record_with(
            FLAG_RECORD_IN_USE,
            0,
            &[
                file_name("Documents", 1, 5),
                non_resident_data(9_999, 9_999, 0),
            ],
        );
        let entry = expect_entry(parse_record(&record));
        assert!(!entry.is_dir, "control: this record is a file");

        let directory = record_with(
            FLAG_RECORD_IN_USE | FLAG_RECORD_IS_DIRECTORY,
            0,
            &[file_name("Documents", 1, 5)],
        );
        let entry = expect_entry(parse_record(&directory));
        assert!(entry.is_dir);
        assert_eq!(entry.size, 0, "a directory's size comes from its children");
    }

    #[test]
    fn resident_content_reports_no_allocation() {
        let record = record_with(
            FLAG_RECORD_IN_USE,
            0,
            &[file_name("tiny.txt", 1, 5), resident_data(64)],
        );
        let entry = expect_entry(parse_record(&record));
        assert_eq!(entry.size, 64);
        assert_eq!(
            entry.allocated, 0,
            "resident content lives in the record, not in clusters"
        );
    }

    #[test]
    fn later_extents_do_not_overwrite_the_real_size() {
        let record = record_with(
            FLAG_RECORD_IN_USE,
            0,
            &[
                file_name("fragmented.bin", 1, 5),
                non_resident_data(1_048_576, 1_048_576, 0),
                non_resident_data(0, 0, 256),
            ],
        );
        assert_eq!(expect_entry(parse_record(&record)).size, 1_048_576);
    }

    #[test]
    fn deleted_records_are_skipped() {
        let record = record_with(0, 0, &[file_name("gone.txt", 1, 5)]);
        assert!(matches!(parse_record(&record), ParsedRecord::Skip));
    }

    #[test]
    fn nameless_records_are_skipped() {
        let record = record_with(FLAG_RECORD_IN_USE, 0, &[non_resident_data(10, 10, 0)]);
        assert!(matches!(parse_record(&record), ParsedRecord::Skip));
    }

    #[test]
    fn non_file_slots_are_skipped() {
        assert!(matches!(parse_record(&[0u8; 1024]), ParsedRecord::Skip));
    }

    #[test]
    fn extension_records_report_their_size_to_the_base() {
        let base_reference = 42u64 | (1u64 << 48); // index 42, sequence 1
        let record = record_with(
            FLAG_RECORD_IN_USE,
            base_reference,
            &[non_resident_data(2048, 4096, 0)],
        );
        match parse_record(&record) {
            ParsedRecord::Extension(extension) => {
                assert_eq!(extension.base, 42);
                assert_eq!(extension.size, 2048);
                assert_eq!(extension.allocated, 4096);
            }
            _ => panic!("a based record should be reported as an extension"),
        }
    }

    #[test]
    fn volume_letter_and_root_detection() {
        assert_eq!(volume_letter(Path::new("c:\\Users")), Some('C'));
        assert_eq!(volume_letter(Path::new("D:/data")), Some('D'));
        assert_eq!(volume_letter(Path::new("\\\\server\\share")), None);

        assert!(is_volume_root(Path::new("C:\\")));
        assert!(is_volume_root(Path::new("C:")));
        assert!(!is_volume_root(Path::new("C:\\Users")));
    }

    #[test]
    fn components_below_root_splits_on_both_separators() {
        assert_eq!(
            components_below_root(Path::new("C:\\Users\\alex\\Downloads")),
            vec!["Users", "alex", "Downloads"]
        );
        assert_eq!(components_below_root(Path::new("C:\\")), Vec::<&str>::new());
        assert_eq!(
            components_below_root(Path::new("C:/Users//alex/")),
            vec!["Users", "alex"]
        );
    }

    /// Build a tiny index by hand: root 5 with a folder and a file under it.
    fn sample_index() -> MftIndex {
        let mut entries = vec![MftEntry::default(); 40];
        entries[ROOT_RECORD as usize] = MftEntry {
            parent: ROOT_RECORD,
            name: ".".to_string(),
            is_dir: true,
            present: true,
            ..MftEntry::default()
        };
        entries[20] = MftEntry {
            parent: ROOT_RECORD,
            name: "Users".to_string(),
            is_dir: true,
            present: true,
            ..MftEntry::default()
        };
        entries[21] = MftEntry {
            parent: 20,
            name: "notes.txt".to_string(),
            size: 12,
            present: true,
            ..MftEntry::default()
        };
        // Orphan: its parent slot is free, so it must not appear anywhere.
        entries[22] = MftEntry {
            parent: 39,
            name: "orphan.txt".to_string(),
            present: true,
            ..MftEntry::default()
        };
        MftIndex {
            entries,
            corrupt: 0,
        }
    }

    #[test]
    fn children_map_links_parents_and_drops_orphans() {
        let index = sample_index();
        let children = index.children_map();
        assert_eq!(children[ROOT_RECORD as usize], vec![20]);
        assert_eq!(children[20], vec![21]);
        assert!(
            children.iter().all(|bucket| !bucket.contains(&22)),
            "an entry whose parent is not a live directory must be dropped"
        );
    }

    #[test]
    fn children_map_does_not_self_link_the_root() {
        let children = sample_index().children_map();
        assert!(
            !children[ROOT_RECORD as usize].contains(&ROOT_RECORD),
            "the root is its own parent on disk and would loop forever"
        );
    }

    #[test]
    fn resolve_walks_a_path_case_insensitively() {
        let index = sample_index();
        let children = index.children_map();
        assert_eq!(index.resolve(&children, &[]), Some(ROOT_RECORD));
        assert_eq!(index.resolve(&children, &["Users"]), Some(20));
        assert_eq!(index.resolve(&children, &["users", "NOTES.TXT"]), Some(21));
        assert_eq!(index.resolve(&children, &["Users", "missing"]), None);
    }
}
