import unittest
from cyberdrop_runner import progress_snapshot
from cyberdrop_dl.progress.scraping.downloads import DownloadsPanel

class ProgressTests(unittest.TestCase):
    def test_dashboard_tracks_all_cli_panels(self):
        from pathlib import Path
        from cyberdrop_runner import dashboard_snapshot
        from cyberdrop_dl.progress.scraping import ScrapingUI
        ui = ScrapingUI()
        ui.files.stats.queued = 32
        ui.scrape_errors.add("502 Bad Gateway")
        ui.scrape_errors.add("502 Bad Gateway")
        ui.download_errors.add("404 not found")
        ui.scrape.get_queue = lambda: 952
        ui.downloads.get_queue = lambda: 32
        ui.compression_progress.set_pending_count(10856)
        ui.compression_progress.add_result("compressed")
        ui.compression_progress.start_task(1, Path("sample.mp4"), 1000)
        ui.compression_progress.update_task(1, 250)
        with ui.scrape.new("https://example.com/item"):
            value = dashboard_snapshot(ui)
        self.assertEqual(value["fileStats"]["queued"], 32)
        self.assertEqual(value["scrapeErrors"]["errors"][0]["count"], 2)
        self.assertEqual(value["downloadErrors"]["errors"][0]["code"], 404)
        self.assertEqual(value["scrapeQueued"], 952)
        self.assertEqual(value["downloadQueued"], 32)
        self.assertEqual(value["scraping"][0]["url"], "https://example.com/item")
        self.assertEqual(value["compression"]["pending"], 10856)
        self.assertEqual(value["compression"]["files"][0]["completed"], 250)
        self.assertIn("cyberdrop-dl", value["status"]["description"])

    def test_actual_transfer_and_unknown_size(self):
        panel = DownloadsPanel()
        with panel.download_file("sample.mp4", "example.com", 1000) as hook:
            hook.advance(250)
            value = progress_snapshot(panel)
            self.assertEqual(value["active"], 1)
            self.assertEqual(value["files"][0]["completed"], 250)
            self.assertEqual(value["files"][0]["size"], 1000)
            self.assertEqual(value["bytes"], 250)
        self.assertEqual(progress_snapshot(panel)["active"], 0)
        with panel.download_file("unknown.mp4", "example.com", None):
            self.assertIsNone(progress_snapshot(panel)["files"][0]["size"])

    def test_hls_reports_segments_and_bytes_separately(self):
        panel = DownloadsPanel()
        with panel.download_hls("stream.mp4", "example.com", 10):
            with panel.download_hls_seg() as hook:
                hook.advance(2048)
            row = progress_snapshot(panel)["files"][0]
            self.assertTrue(row["hls"])
            self.assertEqual(row["completed"], 1)
            self.assertEqual(row["size"], 10)
            self.assertEqual(row["bytes_downloaded"], 2048)

if __name__ == "__main__": unittest.main()
