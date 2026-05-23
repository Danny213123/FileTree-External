/// Integration tests for the single-instance guard (SET-04).
///
/// These tests spawn the actual binary twice and verify that the second instance
/// exits 0 quickly instead of creating a duplicate window.
///
/// Tests are gated to Windows only because the desktop subcommand requires Win32.
/// They use `CARGO_BIN_EXE_filetree`, which cargo sets during `cargo test` to
/// the path of the compiled binary.
#[cfg(windows)]
mod tests {
    use std::process::Command;
    use std::time::{Duration, Instant};

    /// Helper: spawn primary instance and give it time to acquire the mutex.
    fn spawn_primary() -> std::process::Child {
        let exe = env!("CARGO_BIN_EXE_filetree");
        Command::new(exe)
            .arg("desktop")
            .spawn()
            .expect("failed to spawn primary filetree instance")
    }

    /// The second `filetree desktop` launch must exit 0 within 2 seconds.
    #[test]
    fn second_instance_exits_quickly() {
        let mut primary = spawn_primary();
        // Allow the primary to acquire the mutex before the second instance tries.
        std::thread::sleep(Duration::from_millis(500));

        let exe = env!("CARGO_BIN_EXE_filetree");
        let start = Instant::now();
        let status = Command::new(exe)
            .arg("desktop")
            .status()
            .expect("failed to spawn second filetree instance");
        let elapsed = start.elapsed();

        // Clean up the primary regardless of assertion outcome.
        let _ = primary.kill();
        let _ = primary.wait();

        assert!(
            status.success(),
            "second instance should exit with status 0, got: {status}"
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "second instance should exit within 2 seconds, took: {elapsed:?}"
        );
    }

    /// A second instance launched with an invalid path must still exit 0 (D-06
    /// silent-drop: the primary gets focus but no scan is started).
    #[test]
    fn second_instance_with_invalid_path_still_exits_zero() {
        let mut primary = spawn_primary();
        std::thread::sleep(Duration::from_millis(500));

        let exe = env!("CARGO_BIN_EXE_filetree");
        let start = Instant::now();
        let status = Command::new(exe)
            .args([
                "desktop",
                "--path",
                "Z:\\NoSuchPath\\Definitely\\Does\\Not\\Exist",
            ])
            .status()
            .expect("failed to spawn second filetree instance with invalid path");
        let elapsed = start.elapsed();

        let _ = primary.kill();
        let _ = primary.wait();

        assert!(
            status.success(),
            "second instance with invalid path should exit 0, got: {status}"
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "second instance with invalid path should exit quickly, took: {elapsed:?}"
        );
    }
}
