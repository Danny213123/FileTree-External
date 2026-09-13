use crate::compress_job::{
    self, CompressJob, CompressOptions, CompressionRuntimeState, JobEventSink, JobFilesQuery,
    OriginalAction,
};
use crate::io::LockRecover;
use crate::v2::{CompressionFileRecord, CompressionPageQuery, V2Store};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionScanDirectory {
    pub scan_id: String,
    pub directory_id: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionStartRequest {
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub scan_directories: Vec<CompressionScanDirectory>,
    #[serde(default)]
    pub exclude_paths: Vec<String>,
    #[serde(default = "default_preset")]
    pub preset: String,
    #[serde(default)]
    pub original_action: Option<String>,
    #[serde(default)]
    pub recycle_originals: Option<bool>,
    #[serde(default = "default_true")]
    pub tag_filename: bool,
    #[serde(default)]
    pub concurrency: usize,
    #[serde(default = "default_encoder")]
    pub encoder: String,
    #[serde(default = "default_true")]
    pub use_gpu: bool,
    #[serde(default = "default_codec")]
    pub codec: String,
    #[serde(default = "default_zip_level")]
    pub zip_level: i64,
    #[serde(default)]
    pub min_size_bytes: u64,
    #[serde(default)]
    pub custom_max_height: u32,
    #[serde(default)]
    pub custom_quality: u32,
    #[serde(default)]
    pub output_dir: String,
    #[serde(default)]
    pub queued: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CompressionFilesRequest {
    pub offset: usize,
    pub limit: usize,
    pub search: String,
    pub status: String,
    pub kind: String,
    pub encoder: String,
    pub outcome: String,
    pub disposition: String,
    pub path: String,
    pub attention: bool,
    pub sort: String,
    pub direction: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionStartResult {
    pub job_id: String,
    pub status: String,
    pub total: usize,
    pub skipped_unavailable: usize,
    pub skipped_ineligible: usize,
    pub skipped_missing: usize,
}

pub struct DesktopRuntime {
    state: Arc<CompressionRuntimeState>,
    store: Arc<V2Store>,
    starting_paths: Mutex<HashSet<u64>>,
}

impl DesktopRuntime {
    pub fn new(store: Arc<V2Store>) -> Arc<Self> {
        let state = Arc::new(CompressionRuntimeState::default());
        let invalidation_store = Arc::clone(&store);
        *state.path_changed.lock_recover() = Some(Arc::new(move |path| {
            let _ = invalidation_store.mark_scans_stale_for_path(path);
        }));
        compress_job::start_queue_scheduler(Arc::clone(&state));
        Arc::new(Self {
            state,
            store,
            starting_paths: Mutex::new(HashSet::new()),
        })
    }

    pub fn compression_tools_json(&self) -> String {
        crate::compress_tools::tools_json()
    }

    pub fn start_compression(
        &self,
        mut request: CompressionStartRequest,
    ) -> Result<CompressionStartResult, String> {
        let handbrake_available = crate::compress_tools::detect_handbrake().found;
        let image_available = crate::compress_tools::detect_image().0.found;
        let mut skipped_unavailable = 0usize;
        let mut skipped_ineligible = 0usize;
        let excluded = request.exclude_paths.iter().filter(|path| !path.trim().is_empty())
            .map(|path| compression_path_key(path.trim())).collect::<HashSet<_>>();
        let needs_dedup = request.scan_directories.len() > 1
            || (!request.scan_directories.is_empty() && !request.paths.is_empty());
        let mut seen = needs_dedup.then(HashSet::<String>::new);
        let mut indexed_files = Vec::<(String, u64)>::new();
        let mut push_file = |path: String, size: u64| {
            if seen
                .as_mut()
                .is_some_and(|seen| !seen.insert(compression_path_key(&path)))
            {
                return;
            }
            indexed_files.push((path, size));
        };
        for path in std::mem::take(&mut request.paths) {
            if compression_path_is_excluded(&path, &excluded) { continue; }
            let size = std::fs::metadata(&path)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            match crate::compression_eligibility(
                &path,
                size,
                handbrake_available,
                image_available,
                request.min_size_bytes,
            ) {
                crate::CompressionEligibility::Eligible => push_file(path, size),
                crate::CompressionEligibility::EncoderUnavailable => skipped_unavailable += 1,
                crate::CompressionEligibility::KnownNoGain
                | crate::CompressionEligibility::TooSmall => skipped_ineligible += 1,
            }
        }
        let mut scan_files = Vec::new();
        for directory in &request.scan_directories {
            scan_files.extend(
                self.store
                    .query_all_subtree_files(&directory.scan_id, directory.directory_id)?,
            );
        }
        scan_files.retain(|file| !compression_path_is_excluded(&file.path, &excluded));
        scan_files.retain(|file| {
            match crate::compression_eligibility(
                &file.path,
                file.size,
                handbrake_available,
                image_available,
                request.min_size_bytes,
            ) {
                crate::CompressionEligibility::Eligible => true,
                crate::CompressionEligibility::EncoderUnavailable => {
                    skipped_unavailable += 1;
                    false
                }
                crate::CompressionEligibility::KnownNoGain
                | crate::CompressionEligibility::TooSmall => {
                    skipped_ineligible += 1;
                    false
                }
            }
        });
        let skipped_missing = self
            .store
            .validate_indexed_sources_authorized(&mut scan_files)?;
        for file in scan_files {
            push_file(file.path, file.size);
        }
        drop(push_file);
        if indexed_files.is_empty() {
            return Err(
                if skipped_missing > 0 && skipped_unavailable == 0 && skipped_ineligible == 0 {
                    "No files from this scan still exist".to_string()
                } else {
                    "No selected files can be compressed with the current tools and settings"
                        .to_string()
                },
            );
        }
        let fingerprints = compress_job::indexed_path_fingerprints(&indexed_files);
        {
            let mut starting_paths = self.starting_paths.lock_recover();
            let jobs = self.state.jobs.lock_recover();
            if let Some(conflict) = compress_job::active_path_conflict(&jobs, &fingerprints) {
                return Err(format!(
                    "Files are already active in compression job {}",
                    conflict.job_id
                ));
            }
            if fingerprints
                .iter()
                .any(|fingerprint| starting_paths.contains(fingerprint))
            {
                return Err("Files are already being prepared for compression".to_string());
            }
            starting_paths.extend(fingerprints.iter().copied());
        }
        let original_action = request
            .original_action
            .as_deref()
            .map(OriginalAction::from_str)
            .unwrap_or_else(|| {
                if request.recycle_originals.unwrap_or(true) {
                    OriginalAction::Recycle
                } else {
                    OriginalAction::Keep
                }
            });
        let opts = CompressOptions {
            original_action,
            tag_filename: request.tag_filename,
            concurrency: request.concurrency,
            encoder: request.encoder,
            use_gpu: request.use_gpu,
            codec: request.codec,
            zip_level: request.zip_level,
            min_size_bytes: request.min_size_bytes,
            custom_max_height: request.custom_max_height,
            custom_quality: request.custom_quality,
            output_dir: request.output_dir,
        };
        let job = if request.queued {
            compress_job::create_queued_job_from_indexed_files(
                indexed_files,
                &request.preset,
                &opts,
            )
        } else {
            compress_job::create_job_from_indexed_files(indexed_files, &request.preset, &opts)
        };
        let result = CompressionStartResult {
            job_id: job.id.clone(),
            status: if request.queued { "queued" } else { "running" }.to_string(),
            total: job.total,
            skipped_unavailable,
            skipped_ineligible,
            skipped_missing,
        };
        if let Err(error) = self.bind_persistent_job(&job, &result.status) {
            let mut starting_paths = self.starting_paths.lock_recover();
            for fingerprint in &fingerprints {
                starting_paths.remove(fingerprint);
            }
            return Err(error);
        }
        {
            let mut starting_paths = self.starting_paths.lock_recover();
            self.state
                .jobs
                .lock_recover()
                .insert(job.id.clone(), Arc::clone(&job));
            for fingerprint in &fingerprints {
                starting_paths.remove(fingerprint);
            }
        }
        if !request.queued {
            compress_job::spawn_job(Arc::clone(&self.state), job);
        }
        Ok(result)
    }

    pub fn cancel_compression(&self, id: &str) -> Result<(), String> {
        let job = if let Some(job) = self.live_job(id) {
            job
        } else {
            let job = compress_job::job_from_manifest(id)
                .ok_or_else(|| "Compression job was not found".to_string())?;
            self.bind_persistent_job(&job, "paused")?;
            let mut jobs = self.state.jobs.lock_recover();
            Arc::clone(jobs.entry(id.to_string()).or_insert(job))
        };
        compress_job::cancel_or_finalize_job(&job);
        if compress_job::wait_until_finished(&job, Duration::from_secs(8)) {
            Ok(())
        } else {
            Err("Compression is still stopping because an encoder did not exit cleanly".to_string())
        }
    }

    /// Stop live encoder processes when the desktop shell exits. Queued jobs
    /// have no runner and remain persisted for the next launch.
    pub fn shutdown(&self) {
        let jobs = self
            .state
            .jobs
            .lock_recover()
            .values()
            .filter(|job| {
                job.runner_started.load(Ordering::SeqCst) && !job.finished.load(Ordering::SeqCst)
            })
            .cloned()
            .collect::<Vec<_>>();
        for job in jobs {
            compress_job::cancel_job(&job);
        }
    }

    pub fn pause_compression(&self, id: &str) -> Result<String, String> {
        compress_job::pause_job(&self.live_job(id).ok_or("Unknown job")?)
    }

    pub fn resume_compression(&self, id: &str) -> Result<(), String> {
        let job = if let Some(job) = self.live_job(id) {
            job
        } else {
            let job = compress_job::job_from_manifest(id).ok_or("Unknown job")?;
            self.bind_persistent_job(&job, "running")?;
            self.state
                .jobs
                .lock_recover()
                .insert(id.to_string(), Arc::clone(&job));
            job
        };
        if compress_job::resume_job(&job)? {
            compress_job::spawn_job(Arc::clone(&self.state), job);
        }
        Ok(())
    }

    pub fn set_compression_concurrency(
        &self,
        id: &str,
        concurrency: usize,
    ) -> Result<usize, String> {
        Ok(compress_job::set_job_concurrency(
            &self.live_job(id).ok_or("Unknown job")?,
            concurrency,
        ))
    }

    pub fn prioritize_compression_files(
        &self,
        id: &str,
        indices: &[usize],
    ) -> Result<usize, String> {
        let job = self.live_job(id).ok_or("Unknown job")?;
        let changed = compress_job::prioritize_pending(&job, indices);
        if changed > 0 {
            self.persist_pending_positions(&job);
        }
        Ok(changed)
    }

    pub fn skip_compression_files(&self, id: &str, indices: &[usize]) -> Result<usize, String> {
        let job = self.live_job(id).ok_or("Unknown job")?;
        let changed = compress_job::skip_pending(&job, indices);
        if changed > 0 {
            self.persist_pending_positions(&job);
        }
        Ok(changed)
    }

    pub fn retry_compression_files(
        &self,
        id: &str,
        indices: &[usize],
    ) -> Result<CompressionStartResult, String> {
        let job = compress_job::selective_retry_from_manifest(id, indices)
            .ok_or("No failed or skipped files were selected")?;
        let result = CompressionStartResult {
            job_id: job.id.clone(),
            status: "running".to_string(),
            total: job.total,
            skipped_unavailable: 0,
            skipped_ineligible: 0,
            skipped_missing: 0,
        };
        self.bind_persistent_job(&job, &result.status)?;
        self.state
            .jobs
            .lock_recover()
            .insert(job.id.clone(), Arc::clone(&job));
        compress_job::spawn_job(Arc::clone(&self.state), job);
        Ok(result)
    }

    pub fn reorder_queued_compressions(&self, ids: &[String]) -> usize {
        compress_job::reorder_queued_jobs(&self.state, ids)
    }

    pub fn remove_queued_compression(&self, id: &str) -> Result<(), String> {
        compress_job::remove_queued_job(&self.state, id)?;
        self.store.delete_compression_job(id)
    }

    pub fn list_compressions_json(&self) -> String {
        compress_job::list_jobs_json(&self.state)
    }

    pub fn compression_files_json(
        &self,
        id: &str,
        query: CompressionFilesRequest,
    ) -> Option<String> {
        let legacy = JobFilesQuery {
            offset: query.offset,
            limit: query.limit,
            search: query.search.clone(),
            status: query.status.clone(),
            kind: query.kind.clone(),
            encoder: query.encoder.clone(),
            outcome: query.outcome.clone(),
            disposition: query.disposition.clone(),
            path: query.path.clone(),
            attention: query.attention,
            sort: query.sort.clone(),
            direction: query.direction.clone(),
        };
        let query = CompressionPageQuery {
            offset: query.offset,
            limit: query.limit,
            search: query.search,
            status: query.status,
            kind: query.kind,
            encoder: query.encoder,
            outcome: query.outcome,
            disposition: query.disposition,
            path: query.path,
            attention: query.attention,
            sort: query.sort,
            direction: query.direction,
        };
        match self.store.query_compression_files(id, query) {
            Ok(Some(page)) => serde_json::to_string(&page).ok(),
            Ok(None) | Err(_) => {
                let live = self.live_job(id);
                compress_job::job_files_page_json(live.as_deref(), id, &legacy)
            }
        }
    }

    pub fn compression_telemetry_json(&self, id: &str) -> String {
        compress_job::compress_telemetry_json(&self.state, id)
    }

    pub fn subscribe_compression<F>(&self, id: &str, callback: F) -> Result<(), String>
    where
        F: Fn(String) + Send + 'static,
    {
        let job = self.live_job(id).ok_or("Unknown live job")?;
        compress_job::subscribe_job_events(job, callback);
        Ok(())
    }

    fn live_job(&self, id: &str) -> Option<Arc<CompressJob>> {
        self.state.jobs.lock_recover().get(id).map(Arc::clone)
    }

    fn bind_persistent_job(&self, job: &Arc<CompressJob>, status: &str) -> Result<(), String> {
        let positions = job
            .queue
            .lock_recover()
            .pending
            .iter()
            .enumerate()
            .map(|(position, index)| (*index, position))
            .collect::<HashMap<_, _>>();
        let settings = serde_json::json!({
            "preset": &job.preset,
            "originalAction": job.original_action.as_str(),
            "tagFilename": job.tag_filename,
            "concurrency": job.desired_concurrency.load(Ordering::Relaxed),
            "encoder": &job.encoder,
            "useGpu": job.use_gpu,
            "codec": &job.codec,
            "zipLevel": job.zip_level,
            "minSizeBytes": job.min_size_bytes,
            "customMaxHeight": job.custom_max_height,
            "customQuality": job.custom_quality,
            "outputDir": &job.output_dir,
        });
        self.store.persist_compression_job(
            &job.id,
            status,
            job.total,
            &settings.to_string(),
            job.files.iter().map(|file| {
                compression_file_record(job, file.index, positions.get(&file.index).copied())
            }),
        )?;

        let weak = Arc::downgrade(job);
        let store = Arc::clone(&self.store);
        compress_job::set_job_event_sink(
            job,
            JobEventSink(Arc::new(move |line| {
                let Some(job) = weak.upgrade() else { return };
                let Ok(event) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
                    return;
                };
                let event_type = event
                    .get("type")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                if let Some(index) = event.get("index").and_then(|value| value.as_u64()) {
                    let terminal = matches!(event_type, "file_done" | "error");
                    store.queue_compression_file(
                        compression_file_record(&job, index as usize, None),
                        terminal,
                    );
                }
                if matches!(event_type, "job_state" | "done") {
                    store.queue_compression_job_state(
                        &job.id,
                        &job.status.lock_recover(),
                        job.saved_bytes.load(Ordering::Relaxed),
                    );
                }
            })),
        );
        Ok(())
    }

    fn persist_pending_positions(&self, job: &CompressJob) {
        let pending = job.queue.lock_recover().pending.clone();
        for (position, index) in pending.into_iter().enumerate() {
            self.store
                .queue_compression_file(compression_file_record(job, index, Some(position)), false);
        }
    }
}

fn compression_file_record(
    job: &CompressJob,
    index: usize,
    queue_position: Option<usize>,
) -> CompressionFileRecord {
    let file = &job.files[index];
    let fps_bits = file.fps_bits.load(Ordering::Relaxed);
    CompressionFileRecord {
        job_id: job.id.clone(),
        index,
        path: file.path.clone(),
        kind: file.kind.as_str().to_string(),
        status: file.status.lock_recover().clone(),
        stage: file.stage.lock_recover().clone(),
        pct: file.pct.load(Ordering::Relaxed),
        orig_bytes: file.orig_bytes.load(Ordering::Relaxed),
        new_bytes: file.new_bytes.load(Ordering::Relaxed),
        error: file.error.lock_recover().clone(),
        reason: file.reason.lock_recover().clone(),
        encoder: file.encoder.lock_recover().clone(),
        disposition: file.disposition.lock_recover().clone(),
        out_path: file.out_path.lock_recover().clone(),
        duration_ms: file.duration_ms.load(Ordering::Relaxed),
        fps: (fps_bits != 0).then(|| f64::from_bits(fps_bits)),
        started_at: file.started_at.load(Ordering::Relaxed),
        updated_at: file.updated_at.load(Ordering::Relaxed),
        finished_at: file.finished_at.load(Ordering::Relaxed),
        attempt: file.attempt.load(Ordering::Relaxed),
        tool: file.tool.lock_recover().clone(),
        tool_version: file.tool_version.lock_recover().clone(),
        command: file.command.lock_recover().clone(),
        stderr: file.stderr_excerpt.lock_recover().clone(),
        recycled: file.recycled.load(Ordering::Relaxed),
        queue_position,
    }
}

fn default_true() -> bool {
    true
}
fn default_preset() -> String {
    "balanced".to_string()
}
fn default_encoder() -> String {
    "auto".to_string()
}
fn default_codec() -> String {
    "h264".to_string()
}
fn default_zip_level() -> i64 {
    -1
}

fn compression_path_key(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn compression_path_is_excluded(path: &str, excluded: &HashSet<String>) -> bool {
    let mut key = compression_path_key(path);
    loop {
        if excluded.contains(&key) { return true; }
        match key.rfind('/') {
            Some(index) => key.truncate(index),
            None => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compression_exclusions_cover_descendants_and_exact_files_only() {
        let excluded = HashSet::from([compression_path_key("G:\\A\\"), compression_path_key("G:\\B\\keep.txt")]);
        for path in ["g:/a/file.mp4", "G:/A/AB/deep/file.txt", "G:/A", "g:/b/KEEP.TXT"] {
            assert!(compression_path_is_excluded(path, &excluded), "{path}");
        }
        for path in ["G:/AB/file.mp4", "G:/B/keep.txt.zip", "E:/A/file.mp4", "G:/B/other.txt"] {
            assert!(!compression_path_is_excluded(path, &excluded), "{path}");
        }
    }

    #[test]
    fn compression_request_accepts_scan_directory_without_paths() {
        let request: CompressionStartRequest = serde_json::from_value(serde_json::json!({
            "scanDirectories": [{ "scanId": "scan-123", "directoryId": 42 }]
        }))
        .unwrap();
        assert!(request.paths.is_empty());
        assert_eq!(request.scan_directories.len(), 1);
        assert_eq!(request.scan_directories[0].scan_id, "scan-123");
        assert_eq!(request.scan_directories[0].directory_id, 42);
        assert!(request.exclude_paths.is_empty());
    }

    #[test]
    fn compression_request_accepts_scan_file_exclusions() {
        let request: CompressionStartRequest = serde_json::from_value(serde_json::json!({
            "scanDirectories": [{ "scanId": "scan-123", "directoryId": 42 }],
            "excludePaths": ["C:\\Media\\skip.mp4"]
        }))
        .unwrap();
        assert_eq!(request.exclude_paths, vec!["C:\\Media\\skip.mp4"]);
        assert_eq!(
            compression_path_key("C:\\MEDIA\\skip.mp4\\"),
            "c:/media/skip.mp4"
        );
    }
}
