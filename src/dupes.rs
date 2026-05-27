use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use crate::export::push_json_string;
use crate::model::{NodeRecord, ScanResult};

// ── Core types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ScanMode {
    Exact,
    Filename,
    Audio,
}

#[derive(Debug, Clone)]
pub(crate) struct DupeFileV2 {
    pub(crate) path: PathBuf,
    pub(crate) name: String,
    pub(crate) size: u64,
    pub(crate) modified: u64,
    pub(crate) is_ref: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct DupeGroupV2 {
    pub(crate) files: Vec<DupeFileV2>, // files[0] is the reference
    pub(crate) score: u8,              // 100 for exact; 0-100 for fuzzy
    pub(crate) waste: u64,             // size * (count - 1)
}

// ── FNV-1a file hash ────────────────────────────────────────────────────────

pub(crate) fn fnv1a_file(path: &Path) -> io::Result<u64> {
    let mut file = File::open(path)?;
    let mut buffer = [0u8; 1024 * 1024];
    let mut hash = 0xcbf29ce484222325u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        for byte in &buffer[..read] {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    Ok(hash)
}

// ── Build candidate file list from scan result ──────────────────────────────

#[derive(Debug, Default)]
pub(crate) struct DupeFilter2 {
    pub(crate) min_size: u64,
    pub(crate) max_size: Option<u64>,
    pub(crate) extensions: Vec<String>,
}

#[allow(dead_code)]
pub(crate) fn build_candidates(result: &ScanResult, filter: &DupeFilter2) -> Vec<DupeFileV2> {
    result
        .nodes
        .iter()
        .filter(|n| !n.is_dir && n.size >= filter.min_size.max(1))
        .filter(|n| filter.max_size.map_or(true, |max| n.size <= max))
        .filter(|n| {
            filter.extensions.is_empty()
                || filter.extensions.contains(&n.extension.to_lowercase())
        })
        .map(|n| DupeFileV2 {
            path: PathBuf::from(&n.path),
            name: n.name.clone(),
            size: n.size,
            modified: (n.modified_ms / 1000) as u64,
            is_ref: false,
        })
        .collect()
}

pub(crate) fn build_candidates_from_nodes(nodes: &[NodeRecord], filter: &DupeFilter2) -> Vec<DupeFileV2> {
    nodes
        .iter()
        .filter(|n| !n.is_dir && n.size >= filter.min_size.max(1))
        .filter(|n| filter.max_size.map_or(true, |max| n.size <= max))
        .filter(|n| {
            filter.extensions.is_empty()
                || filter.extensions.contains(&n.extension.to_lowercase())
        })
        .map(|n| DupeFileV2 {
            path: PathBuf::from(&n.path),
            name: n.name.clone(),
            size: n.size,
            modified: (n.modified_ms / 1000) as u64,
            is_ref: false,
        })
        .collect()
}

// ── Algorithm 1: Exact (byte-identical via FNV-1a) ─────────────────────────

pub(crate) fn scan_exact(files: &[DupeFileV2]) -> Vec<(usize, usize, u8)> {
    // Group by size first — only files with identical sizes can be identical
    let mut by_size: HashMap<u64, Vec<usize>> = HashMap::new();
    for (idx, f) in files.iter().enumerate() {
        by_size.entry(f.size).or_default().push(idx);
    }

    let mut matches = Vec::new();
    for indices in by_size.values() {
        if indices.len() < 2 {
            continue;
        }
        // Hash each file in this size bucket
        let mut by_hash: HashMap<u64, Vec<usize>> = HashMap::new();
        for &idx in indices {
            if let Ok(h) = fnv1a_file(&files[idx].path) {
                by_hash.entry(h).or_default().push(idx);
            }
        }
        // Emit all pairs within each hash group
        for hash_group in by_hash.values() {
            if hash_group.len() < 2 {
                continue;
            }
            for i in 0..hash_group.len() {
                for j in (i + 1)..hash_group.len() {
                    matches.push((hash_group[i], hash_group[j], 100u8));
                }
            }
        }
    }
    matches
}

// ── Algorithm 2: Filename fuzzy (Sørensen-Dice) ────────────────────────────

fn get_words(name: &str) -> Vec<String> {
    // Strip file extension
    let stem = match name.rfind('.') {
        Some(pos) if pos > 0 => &name[..pos],
        _ => name,
    };
    let mut result = String::with_capacity(stem.len());
    for ch in stem.chars() {
        match ch {
            '-' | '_' | '(' | ')' | '[' | ']' | '{' | '}' => result.push(' '),
            '\'' | '.' | ',' => {}
            c => result.push(c),
        }
    }
    result
        .to_lowercase()
        .split_whitespace()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_owned())
        .collect()
}

fn dice_score(a: &[String], b: &[String], weighted: bool) -> u8 {
    if a.is_empty() || b.is_empty() {
        return 0;
    }
    // Build frequency maps
    let mut count_a: HashMap<&str, usize> = HashMap::new();
    let mut count_b: HashMap<&str, usize> = HashMap::new();
    for w in a {
        *count_a.entry(w.as_str()).or_default() += 1;
    }
    for w in b {
        *count_b.entry(w.as_str()).or_default() += 1;
    }

    let intersection: usize = count_a
        .iter()
        .map(|(&w, &ca)| {
            let cb = count_b.get(w).copied().unwrap_or(0);
            let overlap = ca.min(cb);
            if weighted { overlap * w.len() } else { overlap }
        })
        .sum();

    let total_a: usize = if weighted {
        a.iter().map(|w| w.len()).sum()
    } else {
        a.len()
    };
    let total_b: usize = if weighted {
        b.iter().map(|w| w.len()).sum()
    } else {
        b.len()
    };

    let total = total_a + total_b;
    if total == 0 {
        return 0;
    }
    ((2 * intersection * 100) / total).min(100) as u8
}

fn build_word_dict(files: &[DupeFileV2]) -> HashMap<String, Vec<usize>> {
    let mut dict: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, f) in files.iter().enumerate() {
        for word in get_words(&f.name) {
            dict.entry(word).or_default().push(idx);
        }
    }
    dict
}

pub(crate) fn scan_filename(
    files: &[DupeFileV2],
    min_pct: u8,
    weighted: bool,
    mix_kinds: bool,
) -> Vec<(usize, usize, u8)> {
    let dict = build_word_dict(files);
    let words_cache: Vec<Vec<String>> = files.iter().map(|f| get_words(&f.name)).collect();

    // Collect candidate pairs (share ≥1 word)
    let mut candidate_pairs: HashSet<(usize, usize)> = HashSet::new();
    for indices in dict.values() {
        if indices.len() < 2 {
            continue;
        }
        for i in 0..indices.len() {
            for j in (i + 1)..indices.len() {
                let a = indices[i].min(indices[j]);
                let b = indices[i].max(indices[j]);
                candidate_pairs.insert((a, b));
            }
        }
    }

    let mut matches = Vec::new();
    for (a, b) in candidate_pairs {
        // Optionally skip pairs with different extensions
        if !mix_kinds {
            let ext_a = files[a].path.extension().and_then(|e| e.to_str()).unwrap_or("");
            let ext_b = files[b].path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !ext_a.eq_ignore_ascii_case(ext_b) {
                continue;
            }
        }
        let score = dice_score(&words_cache[a], &words_cache[b], weighted);
        if score >= min_pct {
            matches.push((a, b, score));
        }
    }
    matches
}

// ── Algorithm 3: Audio tag matching (ID3v2 hand-parser) ────────────────────

const AUDIO_EXTS: &[&str] = &["mp3", "flac", "ogg", "m4a", "aac", "wav", "wma", "opus"];

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn syncsafe_to_u32(bytes: &[u8; 4]) -> u32 {
    ((bytes[0] as u32) << 21)
        | ((bytes[1] as u32) << 14)
        | ((bytes[2] as u32) << 7)
        | (bytes[3] as u32)
}

fn read_id3v2(path: &Path) -> HashMap<String, String> {
    let mut tags: HashMap<String, String> = HashMap::new();
    let mut f = match File::open(path) {
        Ok(f) => f,
        Err(_) => return tags,
    };

    let mut header = [0u8; 10];
    if f.read_exact(&mut header).is_err() {
        return tags;
    }
    if &header[0..3] != b"ID3" {
        // Try ID3v1 fallback (last 128 bytes)
        if let Ok(len) = f.seek(SeekFrom::End(-128)) {
            let _ = len;
            let mut v1 = [0u8; 128];
            if f.read_exact(&mut v1).is_ok() && &v1[0..3] == b"TAG" {
                let decode = |s: &[u8]| {
                    let s = s.iter().take_while(|&&b| b != 0).cloned().collect::<Vec<u8>>();
                    String::from_utf8_lossy(&s).trim().to_string()
                };
                tags.insert("title".into(), decode(&v1[3..33]));
                tags.insert("artist".into(), decode(&v1[33..63]));
                tags.insert("album".into(), decode(&v1[63..93]));
                tags.insert("year".into(), decode(&v1[93..97]));
                // Genre: byte 127 is genre index — skip for text matching
            }
        }
        return tags;
    }

    let size = syncsafe_to_u32(header[6..10].try_into().unwrap_or(&[0; 4]));
    let version = header[3];

    // Read all frames
    let mut pos: u32 = 0;
    while pos + 10 <= size {
        let mut frame_id = [0u8; 4];
        if f.read_exact(&mut frame_id).is_err() {
            break;
        }
        if frame_id[0] == 0 {
            break; // padding
        }

        let frame_size = if version >= 4 {
            let mut sb = [0u8; 4];
            if f.read_exact(&mut sb).is_err() { break; }
            syncsafe_to_u32(&sb)
        } else {
            let mut sb = [0u8; 4];
            if f.read_exact(&mut sb).is_err() { break; }
            u32::from_be_bytes(sb)
        };
        let mut flags = [0u8; 2];
        if f.read_exact(&mut flags).is_err() { break; }

        pos += 10 + frame_size;

        if frame_size == 0 || frame_size > 1024 * 1024 {
            // Skip oversized or zero frames safely
            let _ = f.seek(SeekFrom::Current(frame_size as i64));
            continue;
        }

        let mut data = vec![0u8; frame_size as usize];
        if f.read_exact(&mut data).is_err() {
            break;
        }

        let id_str = match std::str::from_utf8(&frame_id) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let tag_key = match id_str {
            "TIT2" => "title",
            "TPE1" => "artist",
            "TALB" => "album",
            "TCON" => "genre",
            "TRCK" => "track",
            "TYER" | "TDRC" => "year",
            _ => continue,
        };

        // Text encoding byte at data[0]: 0=latin1, 1=utf16, 3=utf8
        if data.is_empty() { continue; }
        let encoding = data[0];
        let text_bytes = &data[1..];
        let text = match encoding {
            1 => {
                // UTF-16 with BOM
                if text_bytes.len() < 2 { continue; }
                let is_le = text_bytes[0] == 0xFF && text_bytes[1] == 0xFE;
                let start = if text_bytes[0] == 0xFF || text_bytes[0] == 0xFE { 2 } else { 0 };
                let words: Vec<u16> = text_bytes[start..]
                    .chunks(2)
                    .filter(|c| c.len() == 2)
                    .map(|c| if is_le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
                    .take_while(|&w| w != 0)
                    .collect();
                String::from_utf16_lossy(&words).trim().to_string()
            }
            3 => {
                // UTF-8
                let end = text_bytes.iter().position(|&b| b == 0).unwrap_or(text_bytes.len());
                String::from_utf8_lossy(&text_bytes[..end]).trim().to_string()
            }
            _ => {
                // Latin-1
                let end = text_bytes.iter().position(|&b| b == 0).unwrap_or(text_bytes.len());
                text_bytes[..end].iter().map(|&b| b as char).collect::<String>().trim().to_string()
            }
        };

        if !text.is_empty() {
            tags.insert(tag_key.to_string(), text);
        }
    }

    tags
}

fn compare_fields(fields_a: &[Vec<String>], fields_b: &[Vec<String>]) -> u8 {
    fields_a
        .iter()
        .zip(fields_b.iter())
        .map(|(a, b)| dice_score(a, b, false))
        .min()
        .unwrap_or(0)
}

pub(crate) fn scan_audio(
    files: &[DupeFileV2],
    active_tags: &[&str],
    min_pct: u8,
) -> Vec<(usize, usize, u8)> {
    if active_tags.is_empty() {
        return Vec::new();
    }

    // Filter to audio files only
    let audio_indices: Vec<usize> = files
        .iter()
        .enumerate()
        .filter(|(_, f)| is_audio(&f.path))
        .map(|(i, _)| i)
        .collect();

    if audio_indices.len() < 2 {
        return Vec::new();
    }

    // Read tags for each audio file; build per-file Vec<Vec<String>> (one per active tag)
    let tag_words: Vec<Vec<Vec<String>>> = audio_indices
        .iter()
        .map(|&idx| {
            let tags = read_id3v2(&files[idx].path);
            active_tags
                .iter()
                .map(|&t| {
                    tags.get(t)
                        .map(|v| get_words(v))
                        .unwrap_or_default()
                })
                .collect()
        })
        .collect();

    // Pre-filter: build word dict from first active tag to find candidates
    let mut first_word_dict: HashMap<String, Vec<usize>> = HashMap::new();
    for (pos, words_per_tag) in tag_words.iter().enumerate() {
        if let Some(first) = words_per_tag.first() {
            for w in first {
                first_word_dict.entry(w.clone()).or_default().push(pos);
            }
        }
    }

    let mut candidate_pairs: HashSet<(usize, usize)> = HashSet::new();
    for indices in first_word_dict.values() {
        for i in 0..indices.len() {
            for j in (i + 1)..indices.len() {
                let a = indices[i].min(indices[j]);
                let b = indices[i].max(indices[j]);
                candidate_pairs.insert((a, b));
            }
        }
    }

    let mut matches = Vec::new();
    for (pos_a, pos_b) in candidate_pairs {
        let score = compare_fields(&tag_words[pos_a], &tag_words[pos_b]);
        if score >= min_pct {
            matches.push((audio_indices[pos_a], audio_indices[pos_b], score));
        }
    }
    matches
}

// ── Grouping (dupeguru clique-safe merge) ───────────────────────────────────

pub(crate) fn matches_to_groups(
    mut matches: Vec<(usize, usize, u8)>,
    files: &[DupeFileV2],
    mode: ScanMode,
    ignore_list: &IgnoreList,
) -> Vec<DupeGroupV2> {
    // Sort by score desc so highest-confidence pairs form groups first
    matches.sort_by(|a, b| b.2.cmp(&a.2));

    // Track which group each file index belongs to (index into `groups`)
    let mut file_to_group: HashMap<usize, usize> = HashMap::new();
    // For clique safety: remember all match scores between file pairs
    let mut pair_score: HashMap<(usize, usize), u8> = HashMap::new();
    for &(a, b, s) in &matches {
        let key = (a.min(b), a.max(b));
        pair_score.insert(key, s);
    }

    // groups[i] = list of file indices in that group
    let mut groups: Vec<Vec<usize>> = Vec::new();

    for (a, b, _score) in matches {
        // Skip ignored pairs
        if ignore_list.are_ignored(&files[a].path, &files[b].path) {
            continue;
        }

        let ga = file_to_group.get(&a).copied();
        let gb = file_to_group.get(&b).copied();

        match (ga, gb) {
            (None, None) => {
                let gid = groups.len();
                groups.push(vec![a, b]);
                file_to_group.insert(a, gid);
                file_to_group.insert(b, gid);
            }
            (Some(gid), None) => {
                // Check that b matches every existing member of the group
                let all_match = groups[gid].iter().all(|&m| {
                    if m == a { return true; }
                    let key = (m.min(b), m.max(b));
                    pair_score.get(&key).copied().unwrap_or(0) > 0
                });
                if all_match {
                    groups[gid].push(b);
                    file_to_group.insert(b, gid);
                }
            }
            (None, Some(gid)) => {
                let all_match = groups[gid].iter().all(|&m| {
                    if m == b { return true; }
                    let key = (m.min(a), m.max(a));
                    pair_score.get(&key).copied().unwrap_or(0) > 0
                });
                if all_match {
                    groups[gid].push(a);
                    file_to_group.insert(a, gid);
                }
            }
            (Some(ga), Some(gb)) => {
                if ga == gb {
                    // Already in same group
                } else {
                    // Discard — clique safety: would require all pairs across both groups to match
                }
            }
        }
    }

    // Convert index groups to DupeGroupV2
    let mut result: Vec<DupeGroupV2> = groups
        .into_iter()
        .filter(|g| g.len() >= 2)
        .map(|mut indices| {
            // Reference = largest file
            indices.sort_by(|&a, &b| files[b].size.cmp(&files[a].size));
            let ref_size = files[indices[0]].size;
            let waste = ref_size.saturating_mul((indices.len() - 1) as u64);

            // Find score between ref and first dupe as group score
            let group_score = if mode == ScanMode::Exact {
                100
            } else if indices.len() >= 2 {
                let key = (indices[0].min(indices[1]), indices[0].max(indices[1]));
                pair_score.get(&key).copied().unwrap_or(0)
            } else {
                0
            };

            let file_objs: Vec<DupeFileV2> = indices
                .iter()
                .enumerate()
                .map(|(pos, &idx)| DupeFileV2 {
                    path: files[idx].path.clone(),
                    name: files[idx].name.clone(),
                    size: files[idx].size,
                    modified: files[idx].modified,
                    is_ref: pos == 0,
                })
                .collect();

            DupeGroupV2 { files: file_objs, score: group_score, waste }
        })
        .collect();

    // Sort groups by waste descending
    result.sort_by(|a, b| b.waste.cmp(&a.waste));
    result
}

// ── Re-prioritize ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub(crate) enum ReprioritizeCriterion {
    Largest,
    Smallest,
    Newest,
    Oldest,
    ShortestPath,
    LongestPath,
    AlphaFirst,
    AlphaLast,
}

impl ReprioritizeCriterion {
    pub(crate) fn from_str(s: &str) -> Option<Self> {
        match s {
            "largest"     => Some(Self::Largest),
            "smallest"    => Some(Self::Smallest),
            "newest"      => Some(Self::Newest),
            "oldest"      => Some(Self::Oldest),
            "shortestPath"=> Some(Self::ShortestPath),
            "longestPath" => Some(Self::LongestPath),
            "alphaFirst"  => Some(Self::AlphaFirst),
            "alphaLast"   => Some(Self::AlphaLast),
            _ => None,
        }
    }
}

pub(crate) fn reprioritize(groups: &mut [DupeGroupV2], criterion: ReprioritizeCriterion) {
    for group in groups.iter_mut() {
        group.files.sort_by(|a, b| {
            match criterion {
                ReprioritizeCriterion::Largest     => b.size.cmp(&a.size),
                ReprioritizeCriterion::Smallest    => a.size.cmp(&b.size),
                ReprioritizeCriterion::Newest      => b.modified.cmp(&a.modified),
                ReprioritizeCriterion::Oldest      => a.modified.cmp(&b.modified),
                ReprioritizeCriterion::ShortestPath => a.path.as_os_str().len().cmp(&b.path.as_os_str().len()),
                ReprioritizeCriterion::LongestPath  => b.path.as_os_str().len().cmp(&a.path.as_os_str().len()),
                ReprioritizeCriterion::AlphaFirst  => a.name.cmp(&b.name),
                ReprioritizeCriterion::AlphaLast   => b.name.cmp(&a.name),
            }
        });
        for (pos, f) in group.files.iter_mut().enumerate() {
            f.is_ref = pos == 0;
        }
        // Recompute waste based on new reference (all files same size in exact mode, but not in filename mode)
        let ref_size = group.files.first().map(|f| f.size).unwrap_or(0);
        group.waste = ref_size.saturating_mul((group.files.len() - 1) as u64);
    }
}

// ── Actions ─────────────────────────────────────────────────────────────────

#[cfg(windows)]
fn recycle_file(path: &Path) -> io::Result<()> {
    use std::ffi::OsStr;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;

    // SHFileOperation requires a double-null-terminated wide string
    let mut wide: Vec<u16> = OsStr::new(path).encode_wide().chain(once(0)).chain(once(0)).collect();

    #[repr(C)]
    #[allow(non_snake_case)]
    struct SHFILEOPSTRUCTW {
        hwnd: *mut std::ffi::c_void,
        wFunc: u32,
        pFrom: *const u16,
        pTo: *const u16,
        fFlags: u16,
        fAnyOperationsAborted: i32,
        hNameMappings: *mut std::ffi::c_void,
        lpszProgressTitle: *const u16,
    }

    #[link(name = "shell32")]
    unsafe extern "system" {
        fn SHFileOperationW(lpFileOp: *mut SHFILEOPSTRUCTW) -> i32;
    }

    const FO_DELETE: u32 = 0x0003;
    const FOF_ALLOWUNDO: u16 = 0x0040;
    const FOF_NOCONFIRMATION: u16 = 0x0010;
    const FOF_SILENT: u16 = 0x0004;

    let mut op = SHFILEOPSTRUCTW {
        hwnd: std::ptr::null_mut(),
        wFunc: FO_DELETE,
        pFrom: wide.as_mut_ptr(),
        pTo: std::ptr::null(),
        fFlags: FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT,
        fAnyOperationsAborted: 0,
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: std::ptr::null(),
    };

    let ret = unsafe { SHFileOperationW(&mut op) };
    if ret == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(ret))
    }
}

#[cfg(not(windows))]
fn recycle_file(path: &Path) -> io::Result<()> {
    fs::remove_file(path)
}

pub(crate) fn action_delete(paths: &[PathBuf], permanent: bool) -> Vec<String> {
    let mut errors = Vec::new();
    for path in paths {
        let result = if permanent {
            fs::remove_file(path)
        } else {
            recycle_file(path)
        };
        if let Err(e) = result {
            errors.push(format!("{}: {}", path.display(), e));
        }
    }
    errors
}

pub(crate) fn action_move(src_dst: &[(PathBuf, PathBuf)]) -> Vec<String> {
    let mut errors = Vec::new();
    for (src, dst) in src_dst {
        if let Some(parent) = dst.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                errors.push(format!("{}: {}", dst.display(), e));
                continue;
            }
        }
        // Try atomic rename first; fall back to copy+remove for cross-device
        let result = fs::rename(src, dst).or_else(|_| {
            fs::copy(src, dst).and_then(|_| fs::remove_file(src))
        });
        if let Err(e) = result {
            errors.push(format!("{}: {}", src.display(), e));
        }
    }
    errors
}

pub(crate) fn action_copy(src_dst: &[(PathBuf, PathBuf)]) -> Vec<String> {
    let mut errors = Vec::new();
    for (src, dst) in src_dst {
        if let Some(parent) = dst.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                errors.push(format!("{}: {}", dst.display(), e));
                continue;
            }
        }
        if let Err(e) = fs::copy(src, dst) {
            errors.push(format!("{}: {}", src.display(), e));
        }
    }
    errors
}

// ── Ignore list ─────────────────────────────────────────────────────────────

#[derive(Debug, Default)]
pub(crate) struct IgnoreList {
    /// Symmetric: if (a,b) stored, (b,a) is also stored for O(1) lookup.
    pairs: HashMap<PathBuf, HashSet<PathBuf>>,
}

impl IgnoreList {
    pub(crate) fn add(&mut self, a: &Path, b: &Path) {
        self.pairs.entry(a.to_owned()).or_default().insert(b.to_owned());
        self.pairs.entry(b.to_owned()).or_default().insert(a.to_owned());
    }

    pub(crate) fn are_ignored(&self, a: &Path, b: &Path) -> bool {
        self.pairs.get(a).map_or(false, |s| s.contains(b))
    }

    pub(crate) fn clear(&mut self) {
        self.pairs.clear();
    }

    /// Number of unique pairs (not paths).
    pub(crate) fn pair_count(&self) -> usize {
        self.pairs.values().map(|s| s.len()).sum::<usize>() / 2
    }

    /// Save as JSON array of [path_a, path_b] pairs (canonical a < b ordering).
    pub(crate) fn save(&self, path: &Path) -> io::Result<()> {
        let mut seen: HashSet<(PathBuf, PathBuf)> = HashSet::new();
        let mut out = String::from("[\n");
        let mut first = true;
        for (a, bs) in &self.pairs {
            for b in bs {
                let key = if a <= b {
                    (a.clone(), b.clone())
                } else {
                    (b.clone(), a.clone())
                };
                if seen.insert(key) {
                    if !first { out.push_str(",\n"); }
                    first = false;
                    out.push('[');
                    push_json_string(&mut out, &a.to_string_lossy());
                    out.push(',');
                    push_json_string(&mut out, &b.to_string_lossy());
                    out.push(']');
                }
            }
        }
        out.push_str("\n]\n");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, out)
    }

    /// Load from JSON produced by `save()`.
    pub(crate) fn load(path: &Path) -> io::Result<Self> {
        let raw = fs::read_to_string(path)?;
        let mut list = IgnoreList::default();
        // Minimal hand-parser: each line like ["path_a","path_b"]
        for line in raw.lines() {
            let line = line.trim().trim_start_matches(',');
            if !line.starts_with('[') || line == "[" || line == "]" {
                continue;
            }
            // Extract the two quoted strings
            if let Some((a, b)) = parse_json_pair(line) {
                list.add(Path::new(&a), Path::new(&b));
            }
        }
        Ok(list)
    }
}

/// Parse a line like `["path a","path b"]` into two strings.
fn parse_json_pair(line: &str) -> Option<(String, String)> {
    // Find first quoted string
    let s = line.strip_prefix('[').unwrap_or(line);
    let (first, rest) = parse_json_string(s.trim_start())?;
    let rest = rest.trim_start().strip_prefix(',')?.trim_start();
    let (second, _) = parse_json_string(rest)?;
    Some((first, second))
}

fn parse_json_string(s: &str) -> Option<(String, &str)> {
    let s = s.strip_prefix('"')?;
    let mut result = String::new();
    let mut chars = s.char_indices();
    loop {
        let (i, ch) = chars.next()?;
        if ch == '"' {
            return Some((result, &s[i + 1..]));
        }
        if ch == '\\' {
            let (_, esc) = chars.next()?;
            match esc {
                '"' => result.push('"'),
                '\\' => result.push('\\'),
                'n' => result.push('\n'),
                'r' => result.push('\r'),
                't' => result.push('\t'),
                c => result.push(c),
            }
        } else {
            result.push(ch);
        }
    }
}

// ── JSON serialization ──────────────────────────────────────────────────────

pub(crate) fn groups_to_json(
    groups: &[DupeGroupV2],
    mode: ScanMode,
    errors: &[String],
    ignored_count: usize,
) -> String {
    let mode_str = match mode {
        ScanMode::Exact    => "exact",
        ScanMode::Filename => "filename",
        ScanMode::Audio    => "audio",
    };
    let mut out = String::new();
    out.push_str("{\"mode\":");
    push_json_string(&mut out, mode_str);
    out.push_str(",\"groups\":[");
    for (gi, group) in groups.iter().enumerate() {
        if gi > 0 { out.push(','); }
        out.push_str("{\"score\":");
        out.push_str(&group.score.to_string());
        out.push_str(",\"waste\":");
        out.push_str(&group.waste.to_string());
        out.push_str(",\"files\":[");
        for (fi, f) in group.files.iter().enumerate() {
            if fi > 0 { out.push(','); }
            out.push('{');
            out.push_str("\"path\":");
            push_json_string(&mut out, &f.path.to_string_lossy());
            out.push_str(",\"name\":");
            push_json_string(&mut out, &f.name);
            out.push_str(",\"size\":");
            out.push_str(&f.size.to_string());
            out.push_str(",\"modified\":");
            out.push_str(&f.modified.to_string());
            out.push_str(",\"ref\":");
            out.push_str(if f.is_ref { "true" } else { "false" });
            out.push('}');
        }
        out.push_str("]}");
    }
    out.push_str("],\"errors\":[");
    for (i, e) in errors.iter().enumerate() {
        if i > 0 { out.push(','); }
        push_json_string(&mut out, e);
    }
    out.push_str("],\"ignoredCount\":");
    out.push_str(&ignored_count.to_string());
    out.push('}');
    out
}
