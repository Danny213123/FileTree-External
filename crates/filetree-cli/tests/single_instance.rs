/// Integration tests for the single-instance guard (SET-04).
///
/// These tests spawn the actual binary twice and verify that the second instance
/// exits 0 quickly instead of creating a duplicate window.
#[cfg(windows)]
mod tests {
    use std::process::Command;
    use std::time::{Duration, Instant};

    fn spawn_primary() -> std::process::Child {
        let exe = env!("CARGO_BIN_EXE_filetree");
        Command::new(exe)
            .arg("desktop")
            .spawn()
            .expect("failed to spawn primary filetree instance")
    }

    #[test]
    fn second_instance_exits_quickly() {
        let mut primary = spawn_primary();
        std::thread::sleep(Duration::from_millis(500));

        let exe = env!("CARGO_BIN_EXE_filetree");
        let start = Instant::now();
        let status = Command::new(exe)
            .arg("desktop")
            .status()
            .expect("failed to spawn second filetree instance");
        let elapsed = start.elapsed();

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
