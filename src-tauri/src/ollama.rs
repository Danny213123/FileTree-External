//! Local Ollama access for the AI assistant. The client used to reach Ollama
//! through the removed HTTP server's /api/ai-models and /api/ai-chat routes;
//! these commands talk to Ollama directly and stream its NDJSON reply lines.
//! Going through Rust also avoids the WebView's CSP and Ollama's origin checks.
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::State;
use tauri::ipc::Channel;

/// Cancellation flags for in-flight chat streams, keyed by client request id.
#[derive(Default)]
pub(crate) struct OllamaRequests(Mutex<HashMap<String, Arc<AtomicBool>>>);

/// Ollama's base URL: `OLLAMA_HOST` when set (as Ollama itself reads it),
/// otherwise the default local port.
fn base_url() -> String {
    let host = std::env::var("OLLAMA_HOST")
        .ok()
        .filter(|host| !host.trim().is_empty())
        .unwrap_or_else(|| "127.0.0.1:11434".to_string());
    let host = host
        .trim()
        .trim_end_matches('/')
        .replace("0.0.0.0", "127.0.0.1");
    if host.starts_with("http://") || host.starts_with("https://") {
        host
    } else {
        format!("http://{host}")
    }
}

fn describe(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(code, response) => {
            let detail = response.into_string().unwrap_or_default();
            format!(
                "Ollama HTTP {code}{}",
                if detail.is_empty() {
                    String::new()
                } else {
                    format!(": {detail}")
                }
            )
        }
        other => format!(
            "Could not reach Ollama at {} ({other}). Is Ollama running?",
            base_url()
        ),
    }
}

/// Names of the locally installed models.
#[tauri::command]
pub(crate) async fn ollama_models() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(2))
            .timeout_read(Duration::from_secs(15))
            .build();
        let body: Value = agent
            .get(&format!("{}/api/tags", base_url()))
            .call()
            .map_err(describe)?
            .into_json()
            .map_err(|error| error.to_string())?;
        Ok(body["models"]
            .as_array()
            .map(|models| {
                models
                    .iter()
                    .filter_map(|model| model["name"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default())
    })
    .await
    .map_err(|error| format!("Ollama worker failed: {error}"))?
}

/// Forward a chat request to Ollama's /api/chat and stream each NDJSON line.
#[tauri::command]
pub(crate) async fn ollama_chat(
    requests: State<'_, Arc<OllamaRequests>>,
    request_id: String,
    body: Value,
    on_line: Channel<String>,
) -> Result<(), String> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let registry = Arc::clone(requests.inner());
    registry
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .insert(request_id.clone(), Arc::clone(&cancelled));
    let result = tauri::async_runtime::spawn_blocking(move || {
        // No overall deadline: large models can take minutes to load and answer.
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(3))
            .timeout_read(Duration::from_secs(600))
            .build();
        let response = agent
            .post(&format!("{}/api/chat", base_url()))
            .send_json(body)
            .map_err(describe)?;
        for line in BufReader::new(response.into_reader()).lines() {
            if cancelled.load(Ordering::Relaxed) {
                break;
            }
            let line = line.map_err(|error| error.to_string())?;
            if line.trim().is_empty() {
                continue;
            }
            if on_line.send(line).is_err() {
                break;
            }
        }
        // An empty line marks the end of the stream (Ollama never sends one),
        // so the client knows every earlier line has been delivered.
        let _ = on_line.send(String::new());
        Ok(())
    })
    .await
    .map_err(|error| format!("Ollama worker failed: {error}"));
    if let Ok(mut map) = registry.0.lock() {
        map.remove(&request_id);
    }
    result?
}

/// Stop a chat stream started with the same request id.
#[tauri::command]
pub(crate) fn ollama_cancel(requests: State<'_, Arc<OllamaRequests>>, request_id: String) {
    if let Ok(map) = requests.0.lock()
        && let Some(flag) = map.get(&request_id)
    {
        flag.store(true, Ordering::Relaxed);
    }
}
