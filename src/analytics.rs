use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::dupes::{hash_candidate_groups, HashInput};
use crate::export::{push_id_array, push_json_string};
use crate::model::{
    node_abs_path, AgeBucket, DuplicateCandidate, ExtensionStat, HashCacheEntry, NodeRecord,
    ScanResult, ScanSummary,
};

/// Filter parameters for duplicate search.
pub(crate) struct DupeFilter {
    pub(crate) min_size: u64,
    pub(crate) max_size: Option<u64>,
    /// Comma-separated lowercase extensions (no dot), empty = all
    pub(crate) extensions: Vec<String>,
    /// Substring to match in filename (lowercase), empty = all
    pub(crate) name_pattern: String,
    /// When true, name_pattern must match the whole filename (case-insensitive), not just a substring
    pub(crate) name_exact: bool,
    /// Modified-after threshold in ms since Unix epoch, 0 = no filter
    pub(crate) date_from: u64,
    /// Modified-before threshold in ms since Unix epoch, 0 = no filter
    pub(crate) date_to: u64,
    /// Path prefix for "original" files (keep side). Empty = no directional filter.
    pub(crate) keep_prefix: String,
    /// Path prefix for "duplicate" files (search side). Empty = no directional filter.
    pub(crate) search_prefix: String,
}

/// A scanned file projected into exactly the fields the v1 duplicate serializer
/// emits, with its absolute path already reconstructed. Decoupling the serializer
/// from a single `ScanResult` node buffer lets a multi-root duplicate scan append
/// each source's candidates (see [`collect_dupe_nodes`]) instead of merging every
/// source into one combined buffer and rewriting all of its `id`/`parent`/
/// `children` indices — the `Arc<ScanResult>` sharing pattern used by `dupes-v2`.
pub(crate) struct DupeNode {
    pub(crate) id: usize,
    pub(crate) name: String,
    pub(crate) extension: String,
    /// Absolute path (files don't store their own path; rebuilt from parent + name).
    pub(crate) path: String,
    pub(crate) size: u64,
    pub(crate) modified_ms: u64,
}

/// Project every file in `nodes` (directories skipped — they never appear in
/// duplicate output) into [`DupeNode`]s appended to `out`. `id_offset` is added to
/// each node's id so several scans can be concatenated while keeping ids globally
/// unique. Passing `id_offset = previous_total_node_count` (counting directories
/// too) reproduces, exactly, the ids the old merge-and-re-index path produced, so
/// the streamed JSON is byte-for-byte identical. Iterating `nodes` in index order
/// preserves the candidate ordering the hashing/grouping pipeline depends on.
pub(crate) fn collect_dupe_nodes(nodes: &[NodeRecord], id_offset: usize, out: &mut Vec<DupeNode>) {
    out.reserve(nodes.len());
    for node in nodes {
        if node.is_dir {
            continue;
        }
        out.push(DupeNode {
            id: node.id + id_offset,
            name: node.name.clone(),
            extension: node.extension.clone(),
            path: node_abs_path(nodes, node.id),
            size: node.size,
            modified_ms: node.modified_ms,
        });
    }
}

/// Full-detail duplicate scan. Streams JSON (file paths, names, sizes, dates) to
/// `w` instead of materialising the whole body in one `String` — the response can
/// be large, so it is flushed through a small reused buffer as groups are emitted.
/// The emitted bytes are byte-for-byte identical to the previous in-memory build;
/// only the delivery is incremental.
///
/// Delegates hashing to the single shared pipeline [`hash_candidate_groups`]
/// (size-group → head/tail sample → full FNV hash only for sample-colliding
/// groups, reusing the persistent `(path,size,mtime)→hash` cache) instead of
/// full-hashing every same-size file itself. The rich filtering (extension /
/// name / date / directional keep-vs-search) and the JSON response shape are
/// unchanged.
pub(crate) fn write_duplicates_full_json<W: Write>(
    w: &mut W,
    candidates: &[DupeNode],
    filter: DupeFilter,
    limit: usize,
    cache: &Mutex<HashMap<PathBuf, HashCacheEntry>>,
    cache_path: Option<&Path>,
    threads: usize,
) -> std::io::Result<()> {
    // 1. Apply the rich filters once, keeping the surviving candidates for the
    //    response. (Directories were already dropped by `collect_dupe_nodes`.)
    let mut picked: Vec<&DupeNode> = Vec::new();
    for node in candidates {
        if node.size == 0 || node.size < filter.min_size {
            continue;
        }
        if let Some(max) = filter.max_size {
            if node.size > max {
                continue;
            }
        }
        if !filter.extensions.is_empty() && !filter.extensions.contains(&node.extension.to_lowercase()) {
            continue;
        }
        if !filter.name_pattern.is_empty() {
            let lower = node.name.to_lowercase();
            let matches = if filter.name_exact {
                lower == filter.name_pattern
            } else {
                lower.contains(&filter.name_pattern)
            };
            if !matches {
                continue;
            }
        }
        if filter.date_from > 0 && node.modified_ms < filter.date_from {
            continue;
        }
        if filter.date_to > 0 && node.modified_ms > filter.date_to {
            continue;
        }
        picked.push(node);
    }

    // 2. Hash through the unified pipeline. `inputs[k]` is parallel to
    //    `picked[k]`; emitted group indices are indices into `inputs`.
    let inputs: Vec<HashInput> = picked
        .iter()
        .map(|node| HashInput {
            path: PathBuf::from(&node.path),
            size: node.size,
            mtime: node.modified_ms / 1000,
        })
        .collect();
    let (hash_groups, hash_errors) =
        hash_candidate_groups(&inputs, false, cache, cache_path, None, None, threads);

    // Reconstructed absolute path for input index `k` (used for emission and the
    // directional prefix tests).
    let path_at = |k: usize| inputs[k].path.to_string_lossy().into_owned();

    // 3. Group into (size, hash, idxs), applying the directional keep/search filter.
    let directional = !filter.keep_prefix.is_empty() || !filter.search_prefix.is_empty();
    let mut groups: Vec<(u64, u64, Vec<usize>)> = Vec::new();
    for (hash, idxs) in hash_groups {
        let size = inputs[idxs[0]].size;
        if directional {
            let has_keep = filter.keep_prefix.is_empty()
                || idxs.iter().any(|&k| path_at(k).starts_with(&filter.keep_prefix));
            let has_search = filter.search_prefix.is_empty()
                || idxs.iter().any(|&k| path_at(k).starts_with(&filter.search_prefix));
            if !has_keep || !has_search {
                continue;
            }
        }
        groups.push((size, hash, idxs));
    }

    groups.sort_by(|left, right| {
        let lw = left.0.saturating_mul(left.2.len().saturating_sub(1) as u64);
        let rw = right.0.saturating_mul(right.2.len().saturating_sub(1) as u64);
        rw.cmp(&lw)
    });
    groups.truncate(limit);

    // Flush the buffer to `w` once it grows past this, keeping peak memory at
    // ~one buffer + one group instead of the whole response.
    const FLUSH_THRESHOLD: usize = 64 * 1024;
    let mut output = String::from("{\"groups\":[");
    for (index, (size, hash, idxs)) in groups.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        // For directional mode, count only the search-side files as duplicates.
        let dupe_count = if directional && !filter.search_prefix.is_empty() {
            idxs.iter().filter(|&&k| path_at(k).starts_with(&filter.search_prefix)).count()
        } else {
            idxs.len().saturating_sub(1)
        };
        let waste = size.saturating_mul(dupe_count as u64);
        output.push('{');
        output.push_str("\"size\":"); output.push_str(&size.to_string());
        output.push_str(",\"hash\":"); push_json_string(&mut output, &format!("{hash:016x}"));
        output.push_str(",\"waste\":"); output.push_str(&waste.to_string());
        output.push_str(",\"count\":"); output.push_str(&idxs.len().to_string());
        output.push_str(",\"directional\":"); output.push_str(if directional { "true" } else { "false" });
        output.push_str(",\"files\":[");
        // In directional mode, sort originals first.
        let mut sorted: Vec<usize> = idxs.clone();
        if directional && !filter.keep_prefix.is_empty() {
            sorted.sort_by_key(|&k| if path_at(k).starts_with(&filter.keep_prefix) { 0u8 } else { 1u8 });
        }
        for (fi, &k) in sorted.iter().enumerate() {
            if fi > 0 {
                output.push(',');
            }
            let node = picked[k];
            let path = path_at(k);
            let is_original = if directional && !filter.keep_prefix.is_empty() {
                path.starts_with(&filter.keep_prefix)
            } else {
                fi == 0
            };
            output.push('{');
            output.push_str("\"id\":"); output.push_str(&node.id.to_string());
            output.push_str(",\"name\":"); push_json_string(&mut output, &node.name);
            output.push_str(",\"path\":"); push_json_string(&mut output, &path);
            output.push_str(",\"size\":"); output.push_str(&node.size.to_string());
            output.push_str(",\"modified\":"); output.push_str(&node.modified_ms.to_string());
            output.push_str(",\"original\":"); output.push_str(if is_original { "true" } else { "false" });
            output.push('}');
        }
        output.push_str("]}");
        if output.len() >= FLUSH_THRESHOLD {
            w.write_all(output.as_bytes())?;
            output.clear();
        }
    }
    output.push_str("],\"errors\":[");
    for (ei, err) in hash_errors.iter().take(50).enumerate() {
        if ei > 0 {
            output.push(',');
        }
        push_json_string(&mut output, err);
    }
    output.push_str("]}");
    w.write_all(output.as_bytes())?;
    Ok(())
}

/// Exact (byte-identical) duplicate groups above `min_size`. Delegates hashing
/// to the shared [`hash_candidate_groups`] pipeline (sampling + persistent cache)
/// rather than full-hashing every same-size file. JSON shape is unchanged
/// (`{minSize, groups:[{size,hash,waste,ids}], errors:[{path,message}]}`).
pub(crate) fn exact_duplicates_json(
    result: &ScanResult,
    min_size: u64,
    limit: usize,
    cache: &Mutex<HashMap<PathBuf, HashCacheEntry>>,
    cache_path: Option<&Path>,
    threads: usize,
) -> String {
    let mut candidate_ids: Vec<usize> = Vec::new();
    for node in &result.nodes {
        if !node.is_dir && node.size >= min_size && node.size > 0 {
            candidate_ids.push(node.id);
        }
    }
    let inputs: Vec<HashInput> = candidate_ids
        .iter()
        .map(|&id| HashInput {
            path: PathBuf::from(node_abs_path(&result.nodes, id)),
            size: result.nodes[id].size,
            mtime: result.nodes[id].modified_ms / 1000,
        })
        .collect();
    let (hash_groups, hash_errors) =
        hash_candidate_groups(&inputs, false, cache, cache_path, None, None, threads);

    // Map input indices back to node ids for the response.
    let mut groups: Vec<(u64, u64, Vec<usize>)> = Vec::new();
    for (hash, idxs) in hash_groups {
        let size = inputs[idxs[0]].size;
        let ids: Vec<usize> = idxs.iter().map(|&k| candidate_ids[k]).collect();
        groups.push((size, hash, ids));
    }

    groups.sort_by(|left, right| {
        let left_waste = left.0.saturating_mul(left.2.len().saturating_sub(1) as u64);
        let right_waste = right.0.saturating_mul(right.2.len().saturating_sub(1) as u64);
        right_waste.cmp(&left_waste)
    });
    groups.truncate(limit);

    let mut output = String::from("{\"minSize\":");
    output.push_str(&min_size.to_string());
    output.push_str(",\"groups\":[");
    for (index, (size, hash, ids)) in groups.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        let waste = size.saturating_mul(ids.len().saturating_sub(1) as u64);
        output.push('{');
        output.push_str("\"size\":");
        output.push_str(&size.to_string());
        output.push_str(",\"hash\":");
        push_json_string(&mut output, &format!("{hash:016x}"));
        output.push_str(",\"waste\":");
        output.push_str(&waste.to_string());
        output.push_str(",\"ids\":");
        push_id_array(&mut output, ids);
        output.push('}');
    }
    output.push_str("],\"errors\":[");
    for (index, err) in hash_errors.iter().take(200).enumerate() {
        if index > 0 {
            output.push(',');
        }
        // The pipeline returns "path: message" strings; split once to recover the
        // {path, message} object shape (a Windows path's drive colon is "C:\",
        // never "C: ", so the first ": " is the separator we added).
        let (path, message) = err.split_once(": ").unwrap_or((err.as_str(), ""));
        output.push('{');
        output.push_str("\"path\":");
        push_json_string(&mut output, path);
        output.push_str(",\"message\":");
        push_json_string(&mut output, message);
        output.push('}');
    }
    output.push_str("]}");
    output
}

/// Compute all capped analytics once. Called when a scan finalises (see
/// `finalize_scan_result`) and stored on `ScanResult`, so JSON/NDJSON responses,
/// cache hits, and exports reuse it instead of re-scanning every node per request.
pub(crate) fn scan_summary(nodes: &[NodeRecord], scanned_at_ms: u64) -> ScanSummary {
    ScanSummary {
        top_files: top_file_ids(nodes, 100),
        largest_dirs: largest_dir_ids(nodes, 100),
        extension_stats: extension_stats(nodes, 80),
        age_stats: age_stats(nodes, scanned_at_ms),
        duplicate_candidates: duplicate_candidates(nodes, 100),
    }
}

pub(crate) fn top_file_ids(nodes: &[NodeRecord], limit: usize) -> Vec<usize> {
    let mut ids: Vec<usize> = nodes
        .iter()
        .filter(|node| !node.is_dir)
        .map(|node| node.id)
        .collect();
    // Partition the `limit` largest to the front in O(n), then sort only those
    // (O(limit log limit)) instead of fully sorting every file id (O(n log n)).
    if ids.len() > limit {
        ids.select_nth_unstable_by(limit, |left, right| nodes[*right].size.cmp(&nodes[*left].size));
        ids.truncate(limit);
    }
    ids.sort_by(|left, right| nodes[*right].size.cmp(&nodes[*left].size));
    ids
}

pub(crate) fn largest_dir_ids(nodes: &[NodeRecord], limit: usize) -> Vec<usize> {
    let mut ids: Vec<usize> = nodes
        .iter()
        .filter(|node| node.is_dir)
        .map(|node| node.id)
        .collect();
    if ids.len() > limit {
        ids.select_nth_unstable_by(limit, |left, right| nodes[*right].size.cmp(&nodes[*left].size));
        ids.truncate(limit);
    }
    ids.sort_by(|left, right| nodes[*right].size.cmp(&nodes[*left].size));
    ids
}

pub(crate) fn extension_stats(nodes: &[NodeRecord], limit: usize) -> Vec<ExtensionStat> {
    let mut stats: BTreeMap<String, ExtensionStat> = BTreeMap::new();
    for node in nodes.iter().filter(|node| !node.is_dir) {
        let ext = if node.extension.is_empty() {
            "[none]".to_string()
        } else {
            node.extension.clone()
        };
        let entry = stats.entry(ext.clone()).or_insert(ExtensionStat {
            ext,
            bytes: 0,
            allocated: 0,
            files: 0,
        });
        entry.bytes = entry.bytes.saturating_add(node.size);
        entry.allocated = entry.allocated.saturating_add(node.allocated);
        entry.files = entry.files.saturating_add(1);
    }
    let mut stats: Vec<ExtensionStat> = stats.into_values().collect();
    stats.sort_by_key(|stat| std::cmp::Reverse(stat.bytes));
    stats.truncate(limit);
    stats
}

pub(crate) fn age_stats(nodes: &[NodeRecord], scanned_at_ms: u64) -> Vec<AgeBucket> {
    let mut buckets = vec![
        AgeBucket {
            label: "7 days",
            bytes: 0,
            files: 0,
        },
        AgeBucket {
            label: "30 days",
            bytes: 0,
            files: 0,
        },
        AgeBucket {
            label: "90 days",
            bytes: 0,
            files: 0,
        },
        AgeBucket {
            label: "1 year",
            bytes: 0,
            files: 0,
        },
        AgeBucket {
            label: "older",
            bytes: 0,
            files: 0,
        },
        AgeBucket {
            label: "unknown",
            bytes: 0,
            files: 0,
        },
    ];

    for node in nodes.iter().filter(|node| !node.is_dir) {
        let bucket = if node.modified_ms == 0 || node.modified_ms > scanned_at_ms {
            5
        } else {
            let days = ((scanned_at_ms - node.modified_ms) / 86_400_000) as u64;
            match days {
                0..=7 => 0,
                8..=30 => 1,
                31..=90 => 2,
                91..=365 => 3,
                _ => 4,
            }
        };
        buckets[bucket].bytes = buckets[bucket].bytes.saturating_add(node.size);
        buckets[bucket].files = buckets[bucket].files.saturating_add(1);
    }

    buckets
}

pub(crate) fn duplicate_candidates(nodes: &[NodeRecord], limit: usize) -> Vec<DuplicateCandidate> {
    let mut groups: HashMap<(u64, String), Vec<usize>> = HashMap::new();
    for node in nodes.iter().filter(|node| !node.is_dir && node.size > 0) {
        groups
            .entry((node.size, node.name.to_lowercase()))
            .or_default()
            .push(node.id);
    }

    let mut candidates = Vec::new();
    for ((size, name), ids) in groups.into_iter().filter(|(_, ids)| ids.len() > 1) {
        let waste = size.saturating_mul(ids.len().saturating_sub(1) as u64);
        candidates.push(DuplicateCandidate {
            name,
            size,
            waste,
            ids,
        });
    }
    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.waste));
    candidates.truncate(limit);
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(id: usize, parent: Option<usize>, name: &str, path: &str, is_dir: bool, size: u64) -> NodeRecord {
        NodeRecord {
            id,
            parent,
            name: name.to_string(),
            path: path.to_string(),
            is_dir,
            is_link: false,
            hidden: false,
            readonly: false,
            size,
            allocated: size,
            files: if is_dir { 0 } else { 1 },
            folders: 0,
            modified_ms: 1_000 + id as u64,
            created_ms: 0,
            accessed_ms: 0,
            depth: if parent.is_some() { 1 } else { 0 },
            errors: 0,
            children: Vec::new(),
            extension: if is_dir { String::new() } else { "txt".to_string() },
            owner: String::new(),
            attributes: 0,
        }
    }

    // The legacy `/api/dupes-scan` algorithm: concatenate every source's nodes
    // into one buffer, rewriting each node's id/parent/children by the running
    // offset. Reproduced here so the test can prove the new per-source candidate
    // projection emits the SAME (id, path, name, size, mtime) sequence the old
    // merged buffer fed to the serializer.
    fn legacy_merge(sources: &[Vec<NodeRecord>]) -> Vec<NodeRecord> {
        let mut merged: Vec<NodeRecord> = Vec::new();
        for src in sources {
            let offset = merged.len();
            for node in src {
                let mut node = node.clone();
                node.id += offset;
                if let Some(p) = node.parent {
                    node.parent = Some(p + offset);
                }
                node.children = node.children.iter().map(|c| c + offset).collect();
                merged.push(node);
            }
        }
        merged
    }

    #[test]
    fn collect_dupe_nodes_matches_legacy_merge_projection() {
        // Source A: root dir + a top-level file + a sub-dir + a nested file.
        let source_a = vec![
            mk(0, None, "A", "C:\\A", true, 0),
            mk(1, Some(0), "x.txt", "", false, 10),
            mk(2, Some(0), "sub", "C:\\A\\sub", true, 0),
            mk(3, Some(2), "y.txt", "", false, 20),
        ];
        // Source B: root dir + one file.
        let source_b = vec![
            mk(0, None, "B", "C:\\B", true, 0),
            mk(1, Some(0), "z.txt", "", false, 30),
        ];

        // New path: project each source with a running id offset (full node count,
        // directories included — exactly how the legacy offset advanced).
        let mut new_candidates: Vec<DupeNode> = Vec::new();
        let mut offset = 0usize;
        for src in [&source_a, &source_b] {
            collect_dupe_nodes(src, offset, &mut new_candidates);
            offset += src.len();
        }

        // Legacy path: merge, then take files in buffer order with reconstructed paths.
        let merged = legacy_merge(&[source_a.clone(), source_b.clone()]);
        let legacy: Vec<(usize, String, String, u64, u64)> = merged
            .iter()
            .filter(|n| !n.is_dir)
            .map(|n| {
                (
                    n.id,
                    n.name.clone(),
                    node_abs_path(&merged, n.id),
                    n.size,
                    n.modified_ms,
                )
            })
            .collect();

        let got: Vec<(usize, String, String, u64, u64)> = new_candidates
            .iter()
            .map(|c| (c.id, c.name.clone(), c.path.clone(), c.size, c.modified_ms))
            .collect();

        assert_eq!(
            got, legacy,
            "per-source projection must reproduce the legacy merged ids/paths/order exactly"
        );

        // Spot-check the absolute values so a regression in either path is caught.
        assert_eq!(new_candidates.len(), 3, "directories must be skipped");
        assert_eq!(new_candidates[0].id, 1);
        assert_eq!(new_candidates[0].path, "C:\\A\\x.txt");
        assert_eq!(new_candidates[1].id, 3);
        assert_eq!(new_candidates[1].path, "C:\\A\\sub\\y.txt");
        // Source B's file: legacy id = local id (1) + offset (source A's 4 nodes) = 5.
        assert_eq!(new_candidates[2].id, 5);
        assert_eq!(new_candidates[2].path, "C:\\B\\z.txt");
    }
}
