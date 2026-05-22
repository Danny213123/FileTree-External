# External Integrations

**Analysis Date:** 2026-05-22

## APIs & External Services

None. FileTree has no network calls to any external service. The application operates entirely locally:
- The Rust backend (`src/main.rs`) communicates only with the local filesystem and Windows OS APIs.
- The JavaScript frontend (`web/app.js`) communicates only with the embedded local HTTP server at `http://127.0.0.1:<port>` via `fetch`.

## Data Storage

**Databases:**
- None. No database, ORM, or persistent data store is used.
- Scan results are held in memory (`AppState.last_scan: Mutex<Option<Arc<ScanResult>>>`) for the lifetime of the process.

**File Storage:**
- Local filesystem only. The `scan` CLI mode can write results to a user-specified file via `--out FILE`, using `std::fs::write`. No cloud or networked storage is used.

**Caching:**
- None. Each scan re-reads the filesystem from scratch.

## Authentication & Identity

**Auth Provider:**
- None. The embedded HTTP server binds only to `127.0.0.1` (loopback), so it is not exposed to the network and requires no authentication.

## Monitoring & Observability

**Error Tracking:**
- None. Errors are written to `stderr` via `eprintln!` and surfaced in the UI via the scan errors panel (`/api/scan` response field `scanErrors`).

**Logs:**
- `eprintln!` to stderr for server-level errors (failed connections, failed requests).
- No structured logging library.

## CI/CD & Deployment

**Hosting:**
- Not applicable — distributed as a standalone Windows `.exe`.

**CI Pipeline:**
- GitHub Actions, defined in `.github/workflows/ci.yml`
- Triggers: every push and every pull request
- Runner: `windows-latest`
- Steps: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, `cargo build --release`
- Uses `actions/checkout@v4` and `dtolnay/rust-toolchain@stable`

## Environment Configuration

**Required env vars:**
- None. The application requires no environment variables at runtime.

**Secrets location:**
- None. No secrets, API keys, or credentials of any kind are present or required.

## Webhooks & Callbacks

**Incoming:**
- None.

**Outgoing:**
- None.

## Internal HTTP API (Local Only)

The application exposes a local-only REST-style HTTP API served by the built-in Rust TCP server. These are not external integrations but are documented here for completeness:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | GET | Serve `index.html` |
| `/styles.css` | GET | Serve embedded CSS |
| `/app.js` | GET | Serve embedded JS |
| `/api/config` | GET | Return `initialPath` and `defaultThreads` |
| `/api/drives` | GET | Return available drive root paths |
| `/api/scan` | GET | Run filesystem scan, return JSON tree |
| `/api/export.csv` | GET | Export last scan as CSV download |
| `/api/export.json` | GET | Export last scan as JSON download |
| `/api/duplicates` | GET | Compute exact-hash duplicate groups |
| `/api/open` | GET | Open a path with `ShellExecuteW` |
| `/api/reveal` | GET | Reveal a path in Windows Explorer |
| `/api/properties` | GET | Show Windows shell Properties dialog |
| `/api/delete` | GET | Delete a file or directory |

All endpoints are handled in `src/main.rs` within `handle_client` / `handle_api`.

---

*Integration audit: 2026-05-22*
