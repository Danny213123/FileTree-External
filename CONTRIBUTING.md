# Contributing

Thanks for helping improve FileTree.

## Local Setup

Install Rust from `rustup.rs`, then run:

```powershell
cargo fmt --check
cargo test
cargo build --release
```

FileTree's native desktop UI is Windows-focused. Keep core scanner behavior covered by tests where possible, and run the desktop build on Windows before publishing UI changes.

## Versioning

- Update `Cargo.toml` when changing the released version.
- Keep `VERSION` in sync with `Cargo.toml`.
- Add user-visible changes to `CHANGELOG.md`.

## Pull Requests

Keep changes focused, describe the user-visible impact, and include the validation commands you ran.
