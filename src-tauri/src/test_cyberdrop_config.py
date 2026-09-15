"""Run with Cyberdrop's Python environment; does not start downloads."""
import json
from pathlib import Path
import subprocess
import sys
import unittest


class ConfigBridgeTests(unittest.TestCase):
    def run_bridge(self, text, patch=None):
        helper = Path(__file__).with_name("cyberdrop_config.py").read_text()
        result = subprocess.run(
            [sys.executable, "-c", helper],
            input=json.dumps({"text": text, "patch": patch}),
            text=True, capture_output=True, encoding="utf-8",
        )
        return result.returncode, json.loads(result.stdout)

    def test_loading_with_null_patch_preserves_config(self):
        text = "download_folder: 'G:\\My Media\\Downloads'\n"
        code, data = self.run_bridge(text)
        self.assertEqual(code, 0)
        self.assertEqual(data["text"], text)

    def test_setup_patch_preserves_other_settings(self):
        code, data = self.run_bridge("download_folder: E:/Downloads\ndeep_scrape: true\n", {"downloads.concurrency": 7})
        self.assertEqual(code, 0)
        self.assertTrue(data["settings"]["deep_scrape"])
        self.assertEqual(data["settings"]["downloads"]["concurrency"], 7)

    def test_invalid_yaml_is_rejected(self):
        code, data = self.run_bridge("invalid: [")
        self.assertNotEqual(code, 0)
        self.assertIn("error", data)


if __name__ == "__main__":
    unittest.main()
