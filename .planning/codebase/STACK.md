# Technology Stack

**Analysis Date:** 2026-05-22

## Languages

**Primary:**
- Rust (edition 2024) - All backend logic, HTTP server, filesystem scanning, and Windows desktop GUI (`src/main.rs`)

**Secondary:**
- HTML5 - UI markup (`web/index.html`)
- CSS3 - Styling (`web/styles.css`)
- Vanilla JavaScript (ES2020+) - Frontend UI logic, tree rendering, treemap, export (`web/app.js`)

## Runtime

**Environment:**
- Native binary (no runtime VM) — compiled to a standalone `.exe` for Windows
- Web assets embedded at compile time via `include_str!` macros in `src/main.rs` (lines 17–19)

**Package Manager:**
- Cargo (Rust toolchain, managed by `dtolnay/rust-toolchain@stable` in CI)
- Lockfile: `Cargo.lock` present and committed (version 4 format)

## Frameworks

**Core:**
- No external Rust crates — zero dependencies declared in `Cargo.toml` `[dependencies]` section
- Custom HTTP/1.1 server built on `std::net::TcpListener` / `TcpStream` — no web framework (Actix, Axum, etc.)
- Custom Win32 desktop GUI via raw FFI `extern "system"` bindings — no GUI toolkit (Tauri, egui, etc.)

**Frontend:**
- No JavaScript framework — plain DOM APIs with `fetch`, `AbortController`, `navigator.clipboard`
- No bundler (Webpack, Vite, etc.) — assets served as static strings embedded in the binary

**Testing:**
- Cargo's built-in test runner (`cargo test`)

**Build/Dev:**
- `cargo build --release` — single-step native build, output in `target/release/`
- No build scripts or `build.rs`

## Key Dependencies

**Critical:**
- None — `Cargo.lock` lists only the `filetree 0.1.0` package itself with no transitive dependencies

**Infrastructure:**
- Windows system DLLs linked statically via `#[link(name = "...")]`:
  - `Kernel32` — file size APIs (`GetCompressedFileSizeW`), process/thread primitives
  - `User32` — Win32 window management, message loop, controls
  - `Gdi32` — GDI drawing (fonts, brushes, painting)
  - `Shell32` — `ShellExecuteW`, `SHBrowseForFolderW`, shell context menus
  - `Comctl32` — Common Controls initialization
  - `Dwmapi` — Desktop Window Manager (dark title bar, rounded corners)
  - `Ole32` — COM initialization for IShellFolder / IContextMenu
  - `UxTheme` — Visual style theming

## Configuration

**Environment:**
- No `.env` files detected
- No external configuration files at runtime — all defaults are hardcoded (e.g., default port `7878`, default thread count from `std::thread::available_parallelism`)

**Build:**
- `Cargo.toml` — package manifest (`src/main.rs` is the sole source file)
- `Cargo.lock` — dependency lockfile
- `.gitattributes` — line ending normalization
- `.gitignore` — excludes `/target`, `*.exe`, `*.log`, `*.pdb`

**Subsystem flag:**
- `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` — release builds suppress the console window

## Platform Requirements

**Development:**
- Rust stable toolchain (edition 2024 requires Rust 1.85+)
- Windows OS required for the native desktop mode; `serve` and `scan` CLI modes compile and run on any OS
- `rustfmt` and `clippy` components required (installed by CI)

**Production:**
- Windows 10/11 (Win32 APIs: DWM, Shell, Common Controls v6)
- No installer or packaging tooling configured — distributes as a single `.exe`
- Deployment target: standalone Windows executable

---

*Stack analysis: 2026-05-22*
