//! Bringing a cached scan up to date from the NTFS change journal.
//!
//! A completed scan stores where the volume's journal stood when it started
//! (see `usn.rs`). Reopening that scan replays the records written since, so the
//! work is proportional to what changed rather than to how many files exist —
//! which is what makes a re-scan of an already-scanned drive feel instant.
//!
//! The replay happens in three stages, and each exists for a reason:
//!
//! 1. **Fold.** A single edit produces several journal records (extend, then
//!    truncate, then close). Folding collapses them to one net intent per file
//!    so the database is touched once instead of five times.
//! 2. **Apply.** Intents become row inserts, updates and deletes, matched to
//!    rows by file reference number.
//! 3. **Roll up.** Directory sizes are stored, not derived, so a changed file
//!    has to push its delta up the ancestor chain. That walk is O(depth) per
//!    change, which is why the whole refresh stays cheap.
//!
//! Anything that can't be replayed faithfully returns [`Refresh::Rescan`]. The
//! cache never guesses.

#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};

use crate::usn::{
    Checkpoint, USN_REASON_FILE_CREATE, USN_REASON_FILE_DELETE, USN_REASON_RENAME_NEW_NAME,
    USN_REASON_RENAME_OLD_NAME, UsnChange,
};

/// What a refresh attempt achieved.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Refresh {
    /// Nothing has changed on the volume since the scan.
    Current,
    /// The cache was caught up in place.
    Updated { applied: usize },
    /// There is no way to tell whether the cache is current: no journal on this
    /// volume, no privileges to read it, or a scan taken without a checkpoint.
    ///
    /// Distinct from [`Refresh::Rescan`] on purpose. Absence of evidence isn't
    /// evidence of staleness, and treating it as such would force a full rescan
    /// every single time an unelevated user reopens a drive — throwing away the
    /// cache the app has always served in exactly this situation.
    Unverifiable(String),
    /// Positively known to be un-replayable: we held a mark and the changes
    /// since it are gone. The cache is stale and must be rebuilt.
    Rescan(String),
}

/// The net effect of every journal record that touched one file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Intent {
    Create,
    Update,
    Delete,
}

/// One file's folded change, ready to apply.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Pending {
    pub(crate) frn: u64,
    pub(crate) parent_frn: u64,
    /// Most recent real name. A `RENAME_OLD_NAME` record carries the name being
    /// left behind, so it never becomes the name we store.
    pub(crate) name: String,
    pub(crate) is_dir: bool,
    pub(crate) intent: Intent,
}

/// Collapse an ordered journal replay into at most one intent per file.
///
/// Records must arrive in USN order, which is how the journal returns them.
/// A file created and deleted entirely within the window disappears from the
/// result: it never existed as far as the cached tree is concerned, and
/// emitting a delete for a row that was never inserted would be wasted work.
pub(crate) fn fold_changes(changes: &[UsnChange]) -> Vec<Pending> {
    // Insertion order is preserved so parents are created before their children
    // when a whole new directory tree lands in one window.
    let mut order: Vec<u64> = Vec::new();
    let mut folded: HashMap<u64, Pending> = HashMap::new();
    // Files whose entire lifetime fell inside this window.
    let mut born_and_died: Vec<u64> = Vec::new();

    for change in changes {
        let key = change.record_index();
        let reason = change.reason;
        let renamed_away = reason & USN_REASON_RENAME_OLD_NAME != 0;

        let entry = folded.entry(key).or_insert_with(|| {
            order.push(key);
            Pending {
                frn: key,
                parent_frn: change.parent_record_index(),
                name: change.name.clone(),
                is_dir: change.is_dir(),
                intent: Intent::Update,
            }
        });

        // The old-name record's parent is the old location too, so neither field
        // may be taken from it; the matching new-name record supplies both.
        if !renamed_away {
            entry.parent_frn = change.parent_record_index();
            if !change.name.is_empty() {
                entry.name = change.name.clone();
            }
        }
        entry.is_dir = change.is_dir();

        if reason & USN_REASON_FILE_CREATE != 0 {
            entry.intent = Intent::Create;
        }
        if reason & USN_REASON_FILE_DELETE != 0 {
            if entry.intent == Intent::Create {
                born_and_died.push(key);
            }
            entry.intent = Intent::Delete;
        }
        // A rename on its own still needs the row rewritten, but must not
        // downgrade a pending create into a mere update.
        if reason & USN_REASON_RENAME_NEW_NAME != 0 && entry.intent == Intent::Update {
            entry.intent = Intent::Update;
        }
    }

    for key in born_and_died {
        folded.remove(&key);
    }

    order
        .into_iter()
        .filter_map(|key| folded.remove(&key))
        .collect()
}

// ── Stored checkpoint ───────────────────────────────────────────────────────

/// The refresh state a completed scan wrote into its own database.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct StoredCheckpoint {
    pub(crate) checkpoint: Checkpoint,
    /// MFT reference of the scan root, so changes made directly inside it can
    /// be attached to node 0.
    pub(crate) root_frn: u64,
}

fn metadata_u64(conn: &Connection, key: &str) -> Option<u64> {
    conn.query_row(
        "SELECT value FROM metadata WHERE key=?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .and_then(|text| text.parse().ok())
}

fn metadata_i64(conn: &Connection, key: &str) -> Option<i64> {
    conn.query_row(
        "SELECT value FROM metadata WHERE key=?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .and_then(|text| text.parse().ok())
}

pub(crate) fn read_checkpoint(conn: &Connection) -> StoredCheckpoint {
    StoredCheckpoint {
        checkpoint: Checkpoint {
            volume_serial: metadata_u64(conn, "volumeSerial").unwrap_or(0) as u32,
            journal_id: metadata_u64(conn, "journalId").unwrap_or(0),
            next_usn: metadata_i64(conn, "journalUsn").unwrap_or(0),
        },
        root_frn: metadata_u64(conn, "rootFrn").unwrap_or(0),
    }
}

pub(crate) fn write_checkpoint_usn(conn: &Connection, next_usn: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO metadata(key,value) VALUES('journalUsn',?1)",
        params![next_usn.to_string()],
    )?;
    Ok(())
}

// ── Node lookups ────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct NodeRow {
    id: i64,
    parent_id: Option<i64>,
    is_dir: bool,
    size: u64,
    depth: u32,
}

fn node_by_frn(conn: &Connection, frn: u64) -> Option<NodeRow> {
    conn.query_row(
        "SELECT id,parent_id,is_dir,size,depth FROM nodes WHERE frn=?1 LIMIT 1",
        params![frn as i64],
        |row| {
            Ok(NodeRow {
                id: row.get(0)?,
                parent_id: row.get(1)?,
                is_dir: row.get::<_, i64>(2)? != 0,
                size: row.get::<_, i64>(3)?.max(0) as u64,
                depth: row.get::<_, i64>(4)?.max(0) as u32,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

/// Join a directory path to a child name with exactly one separator, matching
/// how the scan writer interns paths (directories carry their own; files are
/// their parent's plus their name).
fn join_path(parent: &str, name: &str) -> String {
    let mut out = String::with_capacity(parent.len() + 1 + name.len());
    out.push_str(parent);
    if !out.is_empty() && !out.ends_with('\\') && !out.ends_with('/') {
        out.push('\\');
    }
    out.push_str(name);
    out
}

// ── Aggregate roll-up ───────────────────────────────────────────────────────

/// Push a size/count delta from `node_id`'s parent up to the root.
///
/// Directory totals are stored rather than derived, so every ancestor has to
/// learn about a change beneath it. Walking the parent chain costs O(depth) —
/// a dozen rows — which is what keeps a refresh independent of tree size.
fn roll_up(
    conn: &Connection,
    from_parent: Option<i64>,
    size_delta: i64,
    files_delta: i64,
    folders_delta: i64,
) -> rusqlite::Result<()> {
    if size_delta == 0 && files_delta == 0 && folders_delta == 0 {
        return Ok(());
    }
    let mut cursor = from_parent;
    // A corrupt parent chain must not become an infinite loop; no real tree is
    // anywhere near this deep.
    let mut guard = 0;
    while let Some(id) = cursor {
        guard += 1;
        if guard > 4096 {
            break;
        }
        conn.execute(
            "UPDATE nodes SET size=MAX(0,size+?2),allocated=MAX(0,allocated+?2),\
             files=MAX(0,files+?3),folders=MAX(0,folders+?4) WHERE id=?1",
            params![id, size_delta, files_delta, folders_delta],
        )?;
        cursor = conn
            .query_row(
                "SELECT parent_id FROM nodes WHERE id=?1",
                params![id],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()?
            .flatten();
    }
    Ok(())
}

/// Rebuild ancestor maxima from immediate children after a corrected birth date.
/// Uses the parent index and cached child aggregates, not filesystem traversal.
fn recompute_newest_created(conn: &Connection, mut parent: Option<i64>) -> rusqlite::Result<()> {
    for _ in 0..4096 {
        let Some(id) = parent else { break };
        conn.execute("UPDATE nodes SET newest_created_ms=COALESCE((SELECT MAX(newest_created_ms) FROM nodes WHERE parent_id=?1),0) WHERE id=?1", params![id])?;
        parent = conn.query_row("SELECT parent_id FROM nodes WHERE id=?1", params![id], |row| row.get::<_, Option<i64>>(0)).optional()?.flatten();
    }
    Ok(())
}

/// Carry a newly created file's date up to every folder that now contains it.
///
/// This is a maximum rather than a sum, so it only ever moves forwards. Deleting
/// the newest file therefore leaves ancestors reporting the date it was added
/// until the next full scan — recomputing the true maximum would mean walking
/// each ancestor's whole subtree, which is the cost a refresh exists to avoid.
fn bump_newest_created(
    conn: &Connection,
    from_parent: Option<i64>,
    created_ms: i64,
) -> rusqlite::Result<()> {
    if created_ms <= 0 {
        return Ok(());
    }
    let mut cursor = from_parent;
    let mut guard = 0;
    while let Some(id) = cursor {
        guard += 1;
        if guard > 4096 {
            break;
        }
        let updated = conn.execute(
            "UPDATE nodes SET newest_created_ms=?2 WHERE id=?1 AND newest_created_ms<?2",
            params![id, created_ms],
        )?;
        // Once an ancestor already knows a later date, so does everything above
        // it, and the walk can stop.
        if updated == 0 {
            break;
        }
        cursor = conn
            .query_row(
                "SELECT parent_id FROM nodes WHERE id=?1",
                params![id],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()?
            .flatten();
    }
    Ok(())
}

/// Total size and node counts of a subtree, used when a directory is removed.
fn subtree_totals(conn: &Connection, root_id: i64) -> rusqlite::Result<(i64, i64, i64)> {
    conn.query_row(
        "WITH RECURSIVE sub(id) AS (\
           SELECT id FROM nodes WHERE id=?1 \
           UNION ALL \
           SELECT n.id FROM nodes n JOIN sub ON n.parent_id=sub.id\
         ) \
         SELECT COALESCE(SUM(CASE WHEN n.is_dir=0 THEN n.size ELSE 0 END),0),\
                COALESCE(SUM(CASE WHEN n.is_dir=0 THEN 1 ELSE 0 END),0),\
                COALESCE(SUM(CASE WHEN n.is_dir=1 AND n.id<>?1 THEN 1 ELSE 0 END),0) \
         FROM nodes n JOIN sub ON n.id=sub.id",
        params![root_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
}

fn delete_subtree(conn: &Connection, root_id: i64) -> rusqlite::Result<()> {
    conn.execute(
        "WITH RECURSIVE sub(id) AS (\
           SELECT id FROM nodes WHERE id=?1 \
           UNION ALL \
           SELECT n.id FROM nodes n JOIN sub ON n.parent_id=sub.id\
         ) DELETE FROM nodes WHERE id IN (SELECT id FROM sub)",
        params![root_id],
    )?;
    Ok(())
}

// ── Applying folded changes ─────────────────────────────────────────────────

/// Apply one folded change. Returns whether a row was actually touched, so the
/// caller can report a meaningful count rather than the raw record total.
fn apply_one(conn: &Connection, pending: &Pending, root_frn: u64) -> rusqlite::Result<bool> {
    let existing = node_by_frn(conn, pending.frn);

    match pending.intent {
        Intent::Delete => {
            let Some(node) = existing else {
                return Ok(false); // outside the scanned subtree
            };
            let (size, files, folders) = if node.is_dir {
                let (size, files, folders) = subtree_totals(conn, node.id)?;
                (size, files, folders + 1)
            } else {
                (node.size as i64, 1, 0)
            };
            delete_subtree(conn, node.id)?;
            roll_up(conn, node.parent_id, -size, -files, -folders)?;
            Ok(true)
        }

        Intent::Create | Intent::Update => {
            // Where does this live? Either the scan root itself, or a directory
            // already in the tree. Anything else is outside what we scanned.
            let parent = if pending.parent_frn == root_frn && root_frn != 0 {
                Some(NodeRow {
                    id: 0,
                    parent_id: None,
                    is_dir: true,
                    size: 0,
                    depth: 0,
                })
            } else {
                node_by_frn(conn, pending.parent_frn)
            };
            let Some(parent) = parent else {
                return Ok(false);
            };
            let parent_dir: String = conn
                .query_row(
                    "SELECT dir_path FROM nodes WHERE id=?1",
                    params![parent.id],
                    |row| row.get(0),
                )
                .optional()?
                .unwrap_or_default();
            let path = join_path(&parent_dir, &pending.name);

            // The journal says what changed but never how big it is, so the
            // one thing that must be read from disk is the file itself.
            let meta = std::fs::symlink_metadata(&path).ok();
            let new_size = match (&meta, pending.is_dir) {
                (Some(meta), false) => meta.len(),
                _ => 0,
            };
            let stamp = |read: fn(&std::fs::Metadata) -> std::io::Result<SystemTime>| -> i64 {
                meta.as_ref()
                    .and_then(|value| read(value).ok())
                    .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                    .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
                    .unwrap_or(0)
            };
            let created_ms = stamp(std::fs::Metadata::created);
            let modified_ms = stamp(std::fs::Metadata::modified);
            let accessed_ms = stamp(std::fs::Metadata::accessed);
            // Only files date a folder's last addition, matching the rollup the
            // full scan performs.
            let newest_created_ms = if pending.is_dir { 0 } else { created_ms };

            match existing {
                Some(node) => {
                    let delta = new_size as i64 - node.size as i64;
                    conn.execute(
                        "UPDATE nodes SET name=?2,size=?3,allocated=?3,parent_id=?4,\
                         modified_ms=?5,accessed_ms=?6 WHERE id=?1",
                        params![
                            node.id,
                            pending.name,
                            new_size as i64,
                            parent.id,
                            modified_ms,
                            accessed_ms
                        ],
                    )?;
                    roll_up(conn, Some(parent.id), delta, 0, 0)?;
                    // Compression can restore the source birth date after its output
                    // was first observed. Correct both the leaf and ancestor maxima.
                    if !pending.is_dir && created_ms > 0 {
                        let changed = conn.execute("UPDATE nodes SET created_ms=?2,newest_created_ms=?2 WHERE id=?1 AND created_ms<>?2", params![node.id, created_ms])?;
                        if changed > 0 { recompute_newest_created(conn, Some(parent.id))?; }
                    }
                    Ok(true)
                }
                None => {
                    // A file the scan never saw. Give it the next free id rather
                    // than reusing one; ids are dense but not meaningful.
                    let next_id: i64 = conn
                        .query_row("SELECT COALESCE(MAX(id),0)+1 FROM nodes", [], |row| {
                            row.get(0)
                        })?;
                    let extension = if pending.is_dir {
                        String::new()
                    } else {
                        Path::new(&pending.name)
                            .extension()
                            .map(|value| value.to_string_lossy().to_ascii_lowercase())
                            .unwrap_or_default()
                    };
                    conn.execute(
                        "INSERT INTO nodes(id,parent_id,name,dir_path,is_dir,is_link,hidden,readonly,\
                         size,allocated,files,folders,modified_ms,created_ms,accessed_ms,depth,errors,\
                         extension,owner,attributes,frn,newest_created_ms) \
                         VALUES(?1,?2,?3,?4,?5,0,0,0,?6,?6,?7,0,?11,?12,?13,?8,0,?9,'',0,?10,?14)",
                        params![
                            next_id,
                            parent.id,
                            pending.name,
                            if pending.is_dir { path.clone() } else { String::new() },
                            pending.is_dir as i64,
                            new_size as i64,
                            (!pending.is_dir) as i64,
                            parent.depth.saturating_add(1) as i64,
                            extension,
                            pending.frn as i64,
                            modified_ms,
                            created_ms,
                            accessed_ms,
                            newest_created_ms,
                        ],
                    )?;
                    roll_up(
                        conn,
                        Some(parent.id),
                        new_size as i64,
                        (!pending.is_dir) as i64,
                        pending.is_dir as i64,
                    )?;
                    bump_newest_created(conn, Some(parent.id), newest_created_ms)?;
                    Ok(true)
                }
            }
        }
    }
}

/// Apply a whole folded replay inside one transaction, so a failure part-way
/// through can never leave the cached tree half-updated.
pub(crate) fn apply_changes(
    conn: &mut Connection,
    pending: &[Pending],
    root_frn: u64,
) -> rusqlite::Result<usize> {
    let tx = conn.transaction()?;
    let mut applied = 0usize;
    for change in pending {
        if apply_one(&tx, change, root_frn)? {
            applied += 1;
        }
    }
    tx.commit()?;
    Ok(applied)
}

// ── Top-level entry point ───────────────────────────────────────────────────

/// Catch a cached scan up to the volume's current state.
///
/// This is the whole reason reopening an already-scanned drive is fast: the
/// common case reads a handful of journal records and touches a handful of rows
/// instead of re-enumerating millions of files. Every path that can't guarantee
/// a faithful result returns [`Refresh::Rescan`] rather than a partial answer.
pub(crate) fn refresh_scan(db_path: &Path, root: &Path) -> Refresh {
    let Ok(mut conn) = Connection::open(db_path) else {
        return Refresh::Rescan("cache database could not be opened".into());
    };

    let stored = read_checkpoint(&conn);
    if !stored.checkpoint.is_set() {
        // A walker scan, or one taken before the journal was reachable. It has
        // no file reference numbers to match records against.
        return Refresh::Unverifiable("scan has no journal checkpoint".into());
    }
    let Some(letter) = crate::mft::volume_letter(root) else {
        return Refresh::Unverifiable("root is not on a lettered volume".into());
    };

    let replay = match crate::usn::changes_since(letter, &stored.checkpoint) {
        Ok(replay) => replay,
        // Only an expired checkpoint proves we missed changes. Losing access to
        // the journal, or the volume no longer offering one, says nothing about
        // whether the tree moved.
        Err(crate::usn::UsnError::CheckpointExpired) => {
            return Refresh::Rescan("journal checkpoint expired".into());
        }
        Err(error) => return Refresh::Unverifiable(error.to_string()),
    };
    // A prefix of the changes would leave the tree in a state that looks valid
    // but isn't, which is worse than admitting defeat.
    if replay.truncated {
        return Refresh::Rescan("too many changes to replay".into());
    }

    if replay.changes.is_empty() {
        let _ = write_checkpoint_usn(&conn, replay.next_usn);
        return Refresh::Current;
    }

    let pending = fold_changes(&replay.changes);
    let applied = match apply_changes(&mut conn, &pending, stored.root_frn) {
        Ok(applied) => applied,
        Err(error) => return Refresh::Rescan(format!("replay failed: {error}")),
    };
    // Only advance the mark once the rows are committed. If the process dies in
    // between, the next open replays the same window again — applying a change
    // twice is harmless, losing one is not.
    let _ = write_checkpoint_usn(&conn, replay.next_usn);

    if applied == 0 {
        Refresh::Current
    } else {
        Refresh::Updated { applied }
    }
}

/// Live node count after a refresh, for keeping the catalog honest.
pub(crate) fn node_count(db_path: &Path) -> Option<u64> {
    let conn = Connection::open(db_path).ok()?;
    conn.query_row("SELECT COUNT(*) FROM nodes", [], |row| {
        row.get::<_, i64>(0)
    })
    .ok()
    .map(|count| count.max(0) as u64)
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usn::{
        USN_REASON_DATA_EXTEND, USN_REASON_DATA_TRUNCATION,
    };

    const DIR: u32 = 0x10;

    fn change(frn: u64, parent: u64, name: &str, reason: u32, attrs: u32) -> UsnChange {
        UsnChange {
            frn,
            parent_frn: parent,
            usn: frn as i64 * 8,
            timestamp_ms: 0,
            reason,
            attributes: attrs,
            name: name.to_string(),
        }
    }

    // ── Folding ─────────────────────────────────────────────────────────────

    #[test]
    fn folds_repeated_writes_into_one_update() {
        let changes = [
            change(10, 5, "a.txt", USN_REASON_DATA_EXTEND, 0),
            change(10, 5, "a.txt", USN_REASON_DATA_EXTEND, 0),
            change(10, 5, "a.txt", USN_REASON_DATA_TRUNCATION, 0),
        ];
        let folded = fold_changes(&changes);
        assert_eq!(folded.len(), 1, "one file, one row to touch");
        assert_eq!(folded[0].intent, Intent::Update);
    }

    #[test]
    fn a_create_followed_by_writes_stays_a_create() {
        let changes = [
            change(10, 5, "a.txt", USN_REASON_FILE_CREATE, 0),
            change(10, 5, "a.txt", USN_REASON_DATA_EXTEND, 0),
        ];
        let folded = fold_changes(&changes);
        assert_eq!(folded[0].intent, Intent::Create);
    }

    #[test]
    fn a_file_born_and_deleted_inside_the_window_vanishes() {
        let changes = [
            change(10, 5, "tmp", USN_REASON_FILE_CREATE, 0),
            change(10, 5, "tmp", USN_REASON_DATA_EXTEND, 0),
            change(10, 5, "tmp", USN_REASON_FILE_DELETE, 0),
        ];
        assert!(
            fold_changes(&changes).is_empty(),
            "a temp file that never outlived the window was never in the tree"
        );
    }

    #[test]
    fn a_delete_of_a_pre_existing_file_survives_folding() {
        let changes = [
            change(10, 5, "a.txt", USN_REASON_DATA_EXTEND, 0),
            change(10, 5, "a.txt", USN_REASON_FILE_DELETE, 0),
        ];
        let folded = fold_changes(&changes);
        assert_eq!(folded[0].intent, Intent::Delete);
    }

    #[test]
    fn a_rename_keeps_the_new_name_not_the_old() {
        let changes = [
            change(10, 5, "old.txt", USN_REASON_RENAME_OLD_NAME, 0),
            change(10, 5, "new.txt", USN_REASON_RENAME_NEW_NAME, 0),
        ];
        let folded = fold_changes(&changes);
        assert_eq!(folded.len(), 1);
        assert_eq!(folded[0].name, "new.txt");
    }

    #[test]
    fn a_move_between_directories_takes_the_new_parent() {
        let changes = [
            change(10, 5, "a.txt", USN_REASON_RENAME_OLD_NAME, 0),
            change(10, 9, "a.txt", USN_REASON_RENAME_NEW_NAME, 0),
        ];
        let folded = fold_changes(&changes);
        assert_eq!(folded[0].parent_frn, 9, "the destination wins");
    }

    #[test]
    fn folding_preserves_first_touch_order_so_parents_precede_children() {
        let changes = [
            change(20, 5, "dir", USN_REASON_FILE_CREATE, DIR),
            change(21, 20, "child.txt", USN_REASON_FILE_CREATE, 0),
            change(20, 5, "dir", USN_REASON_DATA_EXTEND, DIR),
        ];
        let folded = fold_changes(&changes);
        assert_eq!(folded.len(), 2);
        assert_eq!(folded[0].frn, 20, "the directory is created first");
        assert_eq!(folded[1].frn, 21);
    }

    #[test]
    fn the_reuse_sequence_does_not_split_one_file_into_two() {
        // Same MFT record, sequence number in the high bits.
        let changes = [
            change(0x0001_0000_0000_000A, 5, "a.txt", USN_REASON_DATA_EXTEND, 0),
            change(0x0001_0000_0000_000A, 5, "a.txt", USN_REASON_DATA_EXTEND, 0),
        ];
        let folded = fold_changes(&changes);
        assert_eq!(folded.len(), 1);
        assert_eq!(folded[0].frn, 0xA, "keyed by record index, not raw FRN");
    }

    #[test]
    fn directories_are_recognised_from_the_attribute_bit() {
        let changes = [change(20, 5, "dir", USN_REASON_FILE_CREATE, DIR)];
        assert!(fold_changes(&changes)[0].is_dir);
    }

    // ── Applying, against a real SQLite tree ────────────────────────────────

    /// A three-node tree: root (id 0, frn 5) → docs (id 1, frn 20) →
    /// report.txt (id 2, frn 21, 100 bytes).
    fn seeded_db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(
            "CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);\
             CREATE TABLE nodes(\
               id INTEGER PRIMARY KEY,parent_id INTEGER,name TEXT NOT NULL,dir_path TEXT NOT NULL DEFAULT '',\
               is_dir INTEGER NOT NULL,is_link INTEGER NOT NULL,hidden INTEGER NOT NULL,readonly INTEGER NOT NULL,\
               size INTEGER NOT NULL,allocated INTEGER NOT NULL,files INTEGER NOT NULL,folders INTEGER NOT NULL,\
               modified_ms INTEGER NOT NULL,created_ms INTEGER NOT NULL,accessed_ms INTEGER NOT NULL,\
               depth INTEGER NOT NULL,errors INTEGER NOT NULL,extension TEXT NOT NULL,owner TEXT NOT NULL,\
               attributes INTEGER NOT NULL,frn INTEGER NOT NULL DEFAULT 0,\
               newest_created_ms INTEGER NOT NULL DEFAULT 0);",
        )
        .expect("schema");
        let insert = "INSERT INTO nodes(id,parent_id,name,dir_path,is_dir,is_link,hidden,readonly,\
             size,allocated,files,folders,modified_ms,created_ms,accessed_ms,depth,errors,extension,\
             owner,attributes,frn) VALUES(?1,?2,?3,?4,?5,0,0,0,?6,?6,?7,?8,0,0,0,?9,0,'','',0,?10)";
        // root: 100 bytes, 1 file, 1 folder beneath it
        conn.execute(
            insert,
            params![0i64, None::<i64>, "C:\\", "C:\\", 1i64, 100i64, 1i64, 1i64, 0i64, 5i64],
        )
        .unwrap();
        conn.execute(
            insert,
            params![1i64, Some(0i64), "docs", "C:\\docs", 1i64, 100i64, 1i64, 0i64, 1i64, 20i64],
        )
        .unwrap();
        conn.execute(
            insert,
            params![2i64, Some(1i64), "report.txt", "", 0i64, 100i64, 1i64, 0i64, 2i64, 21i64],
        )
        .unwrap();
        conn
    }

    fn size_of(conn: &Connection, id: i64) -> i64 {
        conn.query_row("SELECT size FROM nodes WHERE id=?1", params![id], |row| {
            row.get(0)
        })
        .unwrap()
    }

    fn files_of(conn: &Connection, id: i64) -> i64 {
        conn.query_row("SELECT files FROM nodes WHERE id=?1", params![id], |row| {
            row.get(0)
        })
        .unwrap()
    }

    #[test]
    fn compression_creation_date_rollup_can_move_backwards() {
        let conn = seeded_db();
        conn.execute("UPDATE nodes SET newest_created_ms=9000", []).unwrap();
        conn.execute("UPDATE nodes SET newest_created_ms=1000 WHERE id=2", []).unwrap();
        recompute_newest_created(&conn, Some(1)).unwrap();
        assert_eq!(newest_created_of(&conn, 1), 1000);
        assert_eq!(newest_created_of(&conn, 0), 1000);
    }

    fn newest_created_of(conn: &Connection, id: i64) -> i64 {
        conn.query_row(
            "SELECT newest_created_ms FROM nodes WHERE id=?1",
            params![id],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn a_new_file_dates_every_folder_above_it() {
        let conn = seeded_db();
        bump_newest_created(&conn, Some(1), 1_700_000_000_000).expect("bumped");
        assert_eq!(newest_created_of(&conn, 1), 1_700_000_000_000, "docs");
        assert_eq!(newest_created_of(&conn, 0), 1_700_000_000_000, "root");
    }

    #[test]
    fn an_older_arrival_never_moves_a_folders_date_backwards() {
        let conn = seeded_db();
        bump_newest_created(&conn, Some(1), 2_000).expect("bumped");
        bump_newest_created(&conn, Some(1), 1_000).expect("bumped");
        assert_eq!(newest_created_of(&conn, 1), 2_000);
    }

    #[test]
    fn an_unknown_creation_date_is_not_rolled_up() {
        let conn = seeded_db();
        bump_newest_created(&conn, Some(1), 0).expect("bumped");
        assert_eq!(newest_created_of(&conn, 1), 0, "zero means unknown, not 1970");
    }

    #[test]
    fn deleting_a_file_shrinks_every_ancestor() {
        let mut conn = seeded_db();
        let pending = [Pending {
            frn: 21,
            parent_frn: 20,
            name: "report.txt".into(),
            is_dir: false,
            intent: Intent::Delete,
        }];
        let applied = apply_changes(&mut conn, &pending, 5).expect("applied");

        assert_eq!(applied, 1);
        assert!(node_by_frn(&conn, 21).is_none(), "the row is gone");
        assert_eq!(size_of(&conn, 1), 0, "docs lost the file's bytes");
        assert_eq!(size_of(&conn, 0), 0, "and so did the root");
        assert_eq!(files_of(&conn, 0), 0, "the root's file count fell too");
    }

    #[test]
    fn deleting_a_directory_removes_its_whole_subtree() {
        let mut conn = seeded_db();
        let pending = [Pending {
            frn: 20,
            parent_frn: 5,
            name: "docs".into(),
            is_dir: true,
            intent: Intent::Delete,
        }];
        apply_changes(&mut conn, &pending, 5).expect("applied");

        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM nodes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 1, "only the scan root survives");
        assert_eq!(size_of(&conn, 0), 0);
        assert_eq!(files_of(&conn, 0), 0, "the nested file stopped counting");
    }

    #[test]
    fn a_change_outside_the_scanned_subtree_is_ignored() {
        let mut conn = seeded_db();
        let pending = [Pending {
            frn: 999,
            parent_frn: 998, // a directory this scan never saw
            name: "elsewhere.txt".into(),
            is_dir: false,
            intent: Intent::Create,
        }];
        let applied = apply_changes(&mut conn, &pending, 5).expect("applied");

        assert_eq!(applied, 0, "nothing to do outside our tree");
        assert_eq!(size_of(&conn, 0), 100, "the root is untouched");
    }

    #[test]
    fn creating_a_file_in_the_scan_root_attaches_it_to_node_zero() {
        let mut conn = seeded_db();
        // parent_frn matches the recorded root_frn, so it resolves to node 0
        // even though no row carries that reference as a child.
        let pending = [Pending {
            frn: 30,
            parent_frn: 5,
            name: "new.txt".into(),
            is_dir: false,
            intent: Intent::Create,
        }];
        let applied = apply_changes(&mut conn, &pending, 5).expect("applied");

        assert_eq!(applied, 1);
        let node = node_by_frn(&conn, 30).expect("inserted");
        assert_eq!(node.parent_id, Some(0));
        assert_eq!(files_of(&conn, 0), 2, "the root gained a file");
    }

    #[test]
    fn a_missing_file_on_disk_lands_as_zero_bytes_rather_than_failing() {
        let mut conn = seeded_db();
        // The path C:\docs\ghost.txt does not exist, so metadata lookup fails.
        let pending = [Pending {
            frn: 31,
            parent_frn: 20,
            name: "ghost.txt".into(),
            is_dir: false,
            intent: Intent::Create,
        }];
        let applied = apply_changes(&mut conn, &pending, 5).expect("applied");

        assert_eq!(applied, 1);
        assert_eq!(size_of(&conn, node_by_frn(&conn, 31).unwrap().id), 0);
        assert_eq!(files_of(&conn, 0), 2, "it still counts as a file");
    }

    #[test]
    fn roll_up_stops_at_the_root_without_looping() {
        let conn = seeded_db();
        roll_up(&conn, Some(1), 50, 0, 0).expect("rolled up");
        assert_eq!(size_of(&conn, 1), 150);
        assert_eq!(size_of(&conn, 0), 150);
    }

    #[test]
    fn roll_up_never_drives_a_total_negative() {
        let conn = seeded_db();
        roll_up(&conn, Some(1), -100_000, 0, 0).expect("rolled up");
        assert_eq!(size_of(&conn, 1), 0, "clamped, not wrapped");
        assert_eq!(size_of(&conn, 0), 0);
    }

    #[test]
    fn subtree_totals_count_files_and_nested_directories() {
        let conn = seeded_db();
        let (size, files, folders) = subtree_totals(&conn, 1).expect("totals");
        assert_eq!(size, 100);
        assert_eq!(files, 1);
        assert_eq!(folders, 0, "docs has no nested directories");
    }

    #[test]
    fn an_empty_replay_touches_nothing() {
        let mut conn = seeded_db();
        assert_eq!(apply_changes(&mut conn, &[], 5).expect("applied"), 0);
        assert_eq!(size_of(&conn, 0), 100);
    }

    #[test]
    fn checkpoint_round_trips_through_metadata() {
        let conn = seeded_db();
        conn.execute_batch(
            "INSERT INTO metadata(key,value) VALUES('volumeSerial','305419896');\
             INSERT INTO metadata(key,value) VALUES('journalId','7');\
             INSERT INTO metadata(key,value) VALUES('journalUsn','8192');\
             INSERT INTO metadata(key,value) VALUES('rootFrn','5');",
        )
        .unwrap();
        let stored = read_checkpoint(&conn);
        assert_eq!(stored.checkpoint.volume_serial, 0x1234_5678);
        assert_eq!(stored.checkpoint.journal_id, 7);
        assert_eq!(stored.checkpoint.next_usn, 8192);
        assert_eq!(stored.root_frn, 5);

        write_checkpoint_usn(&conn, 9999).unwrap();
        assert_eq!(read_checkpoint(&conn).checkpoint.next_usn, 9999);
    }

    #[test]
    fn a_scan_without_a_checkpoint_reads_as_unset() {
        let conn = seeded_db();
        assert!(!read_checkpoint(&conn).checkpoint.is_set());
    }

    /// The unelevated / non-NTFS case must not be mistaken for staleness, or
    /// every reopen would throw away a perfectly good cache.
    #[test]
    fn a_scan_with_no_checkpoint_is_unverifiable_not_stale() {
        let dir = std::env::temp_dir().join(format!("filetree-refresh-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("no-checkpoint.db");
        let _ = std::fs::remove_file(&db_path);
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);\
                 CREATE TABLE nodes(id INTEGER PRIMARY KEY,parent_id INTEGER,name TEXT NOT NULL,\
                 dir_path TEXT NOT NULL DEFAULT '',is_dir INTEGER NOT NULL,is_link INTEGER NOT NULL,\
                 hidden INTEGER NOT NULL,readonly INTEGER NOT NULL,size INTEGER NOT NULL,\
                 allocated INTEGER NOT NULL,files INTEGER NOT NULL,folders INTEGER NOT NULL,\
                 modified_ms INTEGER NOT NULL,created_ms INTEGER NOT NULL,accessed_ms INTEGER NOT NULL,\
                 depth INTEGER NOT NULL,errors INTEGER NOT NULL,extension TEXT NOT NULL,\
                 owner TEXT NOT NULL,attributes INTEGER NOT NULL,frn INTEGER NOT NULL DEFAULT 0);",
            )
            .unwrap();
        }

        let outcome = refresh_scan(&db_path, Path::new("C:\\some\\root"));
        assert!(
            matches!(outcome, Refresh::Unverifiable(_)),
            "expected Unverifiable so the cache is still served, got {outcome:?}"
        );
        let _ = std::fs::remove_file(&db_path);
    }
}
