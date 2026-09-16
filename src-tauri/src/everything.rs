//! Everything (voidtools) search.
//!
//! Everything keeps a live index of every filename on the machine's NTFS
//! volumes, so it answers in milliseconds on drives FileTree has never scanned.
//! It can be reached two ways and this supports both, because which one a
//! person has depends on what they installed: the `es.exe` command-line tool,
//! or Everything's built-in HTTP server.

use crate::tools;
use serde::Serialize;
use serde_json::{Value, json};
use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

/// FILETIME epoch (1601-01-01) to Unix epoch, in 100-nanosecond ticks.
const FILETIME_EPOCH: i64 = 11_644_473_600;
const MAX_BODY: usize = 16 * 1024 * 1024;

#[derive(Serialize, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Hit {
    pub name: String,
    pub path: String,
    /// Bytes, or `None` for a folder and for rows the source left blank.
    pub size: Option<u64>,
    /// Unix seconds.
    pub modified: Option<i64>,
    pub is_dir: bool,
}

fn es_candidates() -> Vec<PathBuf> {
    let mut paths = tools::program_files("Everything\\es.exe");
    paths.extend(tools::program_files("Everything"));
    paths
}

/// Windows FILETIME ticks to Unix seconds, ignoring values outside the epoch.
fn filetime_to_unix(ticks: i64) -> Option<i64> {
    let seconds = ticks / 10_000_000 - FILETIME_EPOCH;
    (seconds > 0).then_some(seconds)
}

/// One CSV record, honouring quotes and doubled quotes inside them.
fn csv_fields(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' if quoted && chars.peek() == Some(&'"') => {
                field.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => fields.push(std::mem::take(&mut field)),
            _ => field.push(ch),
        }
    }
    fields.push(field);
    fields
}

/// Parse `es.exe` output: its CSV form when a header is present, otherwise the
/// plain list of full paths it prints by default.
pub(crate) fn parse_es(output: &str) -> Vec<Hit> {
    let mut lines = output.lines().filter(|line| !line.trim().is_empty());
    let Some(first) = lines.next() else {
        return Vec::new();
    };
    let header: Vec<String> = csv_fields(first)
        .iter()
        .map(|name| name.trim().to_lowercase())
        .collect();
    let column = |want: &str| header.iter().position(|name| name == want);
    let (name_at, path_at, size_at, date_at) = (
        column("filename").or_else(|| column("name")),
        column("path").or_else(|| column("full path")),
        column("size"),
        column("date modified").or_else(|| column("date-modified")),
    );
    if name_at.is_none() && path_at.is_none() {
        // No header: every line is a full path.
        return std::iter::once(first)
            .chain(lines)
            .map(|line| hit_from_path(line.trim(), None, None))
            .collect();
    }
    lines
        .map(|line| {
            let fields = csv_fields(line);
            let at = |index: Option<usize>| index.and_then(|i| fields.get(i)).map(|v| v.trim());
            let size = at(size_at).and_then(|value| value.replace(',', "").parse().ok());
            let modified = at(date_at).and_then(parse_es_date);
            match (at(path_at), at(name_at)) {
                // `-path-column` gives the folder; the filename is its own field.
                (Some(folder), Some(name)) if !folder.is_empty() && !name.is_empty() => {
                    hit_from_path(
                        &format!("{}\\{name}", folder.trim_end_matches('\\')),
                        size,
                        modified,
                    )
                }
                (Some(full), _) => hit_from_path(full, size, modified),
                (_, Some(name)) => hit_from_path(name, size, modified),
                _ => Hit::default(),
            }
        })
        .filter(|hit| !hit.path.is_empty())
        .collect()
}

/// es prints FILETIME ticks with `-date-modified`; newer builds print a date.
fn parse_es_date(value: &str) -> Option<i64> {
    let digits = value.replace(',', "");
    if let Ok(ticks) = digits.parse::<i64>() {
        return filetime_to_unix(ticks);
    }
    None
}

fn hit_from_path(full: &str, size: Option<u64>, modified: Option<i64>) -> Hit {
    let trimmed = full.trim();
    let name = trimmed
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(trimmed)
        .to_string();
    Hit {
        name,
        path: trimmed.to_string(),
        // Everything reports a folder as size 0 through some columns and as
        // nothing through others; only the explicit result type is trusted.
        size,
        modified,
        is_dir: false,
    }
}

/// Parse the HTTP server's JSON, which returns every field as a string.
pub(crate) fn parse_http(body: &str) -> Result<(Vec<Hit>, u64), String> {
    let value: Value = serde_json::from_str(body)
        .map_err(|_| "Everything's HTTP server did not answer with JSON".to_string())?;
    let total = value["totalResults"]
        .as_u64()
        .or_else(|| value["totalResults"].as_str().and_then(|v| v.parse().ok()))
        .unwrap_or_default();
    let number = |field: &Value| -> Option<u64> {
        field
            .as_u64()
            .or_else(|| field.as_str().and_then(|value| value.parse().ok()))
    };
    let hits = value["results"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .map(|row| {
                    let name = row["name"].as_str().unwrap_or_default().to_string();
                    let folder = row["path"].as_str().unwrap_or_default();
                    let is_dir = row["type"].as_str() == Some("folder");
                    Hit {
                        path: if folder.is_empty() {
                            name.clone()
                        } else {
                            format!("{}\\{name}", folder.trim_end_matches('\\'))
                        },
                        name,
                        size: if is_dir { None } else { number(&row["size"]) },
                        modified: number(&row["date_modified"])
                            .and_then(|ticks| filetime_to_unix(ticks as i64)),
                        is_dir,
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    Ok((hits, total))
}

fn percent(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

pub(crate) fn http_url(host: &str, port: u16, query: &str, limit: u32) -> String {
    let host = if host.trim().is_empty() {
        "127.0.0.1"
    } else {
        host.trim()
    };
    format!(
        "http://{host}:{port}/?s={}&j=1&c={limit}&path_column=1&size_column=1&date_modified_column=1",
        percent(query)
    )
}

/// Which ways of reaching Everything are available right now.
#[tauri::command]
pub(crate) async fn everything_status(es_path: String, host: String, port: u16) -> Value {
    let es = tools::locate(&es_path, "es.exe", &es_candidates());
    let http = ureq::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .get(&http_url(&host, port, "filetree-probe", 1))
        .call()
        .is_ok();
    json!({
        "es": es.as_ref().map(|path| path.display().to_string()),
        "http": http,
        "ready": es.is_some() || http,
    })
}

#[tauri::command]
pub(crate) async fn everything_search(
    query: String,
    limit: u32,
    es_path: String,
    host: String,
    port: u16,
    prefer: String,
) -> Result<Value, String> {
    if query.trim().is_empty() {
        return Err("Type something to search for".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let limit = limit.clamp(1, 5_000);
        let es = tools::locate(&es_path, "es.exe", &es_candidates());
        let use_http = prefer == "http" || es.is_none();
        if use_http {
            match search_http(&host, port, &query, limit) {
                Ok(value) => return Ok(value),
                // Falling back keeps a stale "prefer HTTP" setting from
                // breaking search for someone who does have es.exe.
                Err(error) if es.is_none() => return Err(error),
                Err(_) => {}
            }
        }
        let es = es.ok_or(
            "Everything was not reachable. Install its \"es\" command-line tool, or turn on \
             its HTTP server under Tools → Options → HTTP Server.",
        )?;
        let args = [
            "-csv",
            "-size",
            "-date-modified",
            "-path-column",
            "-n",
            &limit.to_string(),
            query.trim(),
        ]
        .map(str::to_string);
        let output = tools::run(&es, &args, &[])?;
        let hits = parse_es(&output);
        Ok(json!({ "results": hits, "total": hits.len(), "source": "es" }))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn search_http(host: &str, port: u16, query: &str, limit: u32) -> Result<Value, String> {
    let response = ureq::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .get(&http_url(host, port, query.trim(), limit))
        .call()
        .map_err(|error| match error {
            ureq::Error::Status(code, _) => {
                format!("Everything's HTTP server answered {code}")
            }
            _ => "Everything's HTTP server did not answer".to_string(),
        })?;
    let mut body = String::new();
    response
        .into_reader()
        .take(MAX_BODY as u64)
        .read_to_string(&mut body)
        .map_err(|error| error.to_string())?;
    let (hits, total) = parse_http(&body)?;
    Ok(json!({ "results": hits, "total": total, "source": "http" }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_csv_es_prints_with_columns() {
        let output = "Filename,Path,Size,Date Modified\r\n\
             \"holiday.mp4\",\"D:\\Media\\Videos\",\"1,048,576\",\"133000000000000000\"\r\n\
             \"notes, final.txt\",\"D:\\Docs\",\"12\",\"\"\r\n";
        let hits = parse_es(output);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].path, "D:\\Media\\Videos\\holiday.mp4");
        assert_eq!(hits[0].size, Some(1_048_576));
        assert_eq!(hits[0].modified, Some(1_655_526_400)); // 2022-06-18
        // A comma inside quotes stays part of the name.
        assert_eq!(hits[1].name, "notes, final.txt");
        assert_eq!(hits[1].modified, None);
    }

    #[test]
    fn reads_the_plain_path_list_es_prints_by_default() {
        let hits = parse_es("D:\\Media\\one.mp4\r\nD:\\Media\\two.mp4\r\n");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[1].name, "two.mp4");
        assert_eq!(hits[1].size, None);
    }

    #[test]
    fn reads_the_http_servers_stringly_json() {
        let body = r#"{"totalResults":"2","results":[
            {"type":"file","name":"holiday.mp4","path":"D:\\Media","size":"1048576","date_modified":"133000000000000000"},
            {"type":"folder","name":"Media","path":"D:\\","size":"0","date_modified":"0"}]}"#;
        let (hits, total) = parse_http(body).unwrap();
        assert_eq!(total, 2);
        assert_eq!(hits[0].path, "D:\\Media\\holiday.mp4");
        assert_eq!(hits[0].size, Some(1_048_576));
        assert!(hits[1].is_dir);
        assert_eq!(hits[1].size, None);
        assert_eq!(hits[1].modified, None);
    }

    #[test]
    fn refuses_a_body_that_is_not_json() {
        assert!(parse_http("<html>Everything</html>").is_err());
    }

    #[test]
    fn builds_the_http_query() {
        assert_eq!(
            http_url("", 80, "two words.mp4", 50),
            "http://127.0.0.1:80/?s=two+words.mp4&j=1&c=50&path_column=1&size_column=1&date_modified_column=1"
        );
    }
}
