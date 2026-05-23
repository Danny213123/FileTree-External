use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

use crate::export::{push_id_array, push_json_string};
use crate::model::{
    AgeBucket, DuplicateCandidate, ExtensionStat, NodeRecord, ScanError, ScanResult,
};

pub(crate) fn exact_duplicates_json(result: &ScanResult, min_size: u64, limit: usize) -> String {
    let mut by_size: HashMap<u64, Vec<usize>> = HashMap::new();
    for node in &result.nodes {
        if !node.is_dir && node.size >= min_size && node.size > 0 {
            by_size.entry(node.size).or_default().push(node.id);
        }
    }

    let mut groups = Vec::<(u64, u64, Vec<usize>)>::new();
    let mut hash_errors = Vec::<ScanError>::new();
    for (size, ids) in by_size.into_iter().filter(|(_, ids)| ids.len() > 1) {
        let mut by_hash: HashMap<u64, Vec<usize>> = HashMap::new();
        for id in ids {
            match fnv1a_file(Path::new(&result.nodes[id].path)) {
                Ok(hash) => by_hash.entry(hash).or_default().push(id),
                Err(error) => hash_errors.push(ScanError {
                    path: result.nodes[id].path.clone(),
                    message: error.to_string(),
                }),
            }
        }
        for (hash, ids) in by_hash.into_iter().filter(|(_, ids)| ids.len() > 1) {
            groups.push((size, hash, ids));
        }
    }

    groups.sort_by(|left, right| {
        let left_waste = left.0.saturating_mul(left.2.len().saturating_sub(1) as u64);
        let right_waste = right
            .0
            .saturating_mul(right.2.len().saturating_sub(1) as u64);
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
    for (index, error) in hash_errors.iter().take(200).enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push('{');
        output.push_str("\"path\":");
        push_json_string(&mut output, &error.path);
        output.push_str(",\"message\":");
        push_json_string(&mut output, &error.message);
        output.push('}');
    }
    output.push_str("]}");
    output
}

fn fnv1a_file(path: &Path) -> io::Result<u64> {
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

pub(crate) fn top_file_ids(nodes: &[NodeRecord], limit: usize) -> Vec<usize> {
    let mut ids: Vec<usize> = nodes
        .iter()
        .filter(|node| !node.is_dir)
        .map(|node| node.id)
        .collect();
    ids.sort_by(|left, right| nodes[*right].size.cmp(&nodes[*left].size));
    ids.truncate(limit);
    ids
}

pub(crate) fn largest_dir_ids(nodes: &[NodeRecord], limit: usize) -> Vec<usize> {
    let mut ids: Vec<usize> = nodes
        .iter()
        .filter(|node| node.is_dir)
        .map(|node| node.id)
        .collect();
    ids.sort_by(|left, right| nodes[*right].size.cmp(&nodes[*left].size));
    ids.truncate(limit);
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

pub(crate) fn age_stats(nodes: &[NodeRecord], scanned_at_ms: u128) -> Vec<AgeBucket> {
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
