import contextlib
import asyncio
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from cyberdrop_workspace import operate, SIDELOAD_DEFAULTS
from cyberdrop_runner import install_completion_hook


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name) / "base"
        self.root = Path(self.temp.name) / "central"
        self.base.mkdir()
        (self.base / "config.yaml").write_text("download_folder: E:/Downloads\n", encoding="utf-8")
        (self.base / "cache.json").write_text('{"sample":123}', encoding="utf-8")
        self.environment = patch.dict(os.environ, {"APPDATA": self.temp.name})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def call(self, action="init", **kwargs):
        return operate(dict(root=str(self.root), base=str(self.base), action=action, **kwargs))

    def test_cache_and_database_are_copied_once(self):
        source = Path(self.temp.name) / "cyberdrop-dl"
        source.mkdir()
        with contextlib.closing(sqlite3.connect(source / "cyberdrop.db")) as db:
            db.execute("create table example(value integer)")
            db.execute("insert into example values(42)")
            db.commit()
        self.call()
        self.assertEqual((self.root / "cache.json").read_text(), '{"sample":123}')
        with contextlib.closing(sqlite3.connect(self.root / "cyberdrop.db")) as db:
            self.assertEqual(db.execute("select value from example").fetchone()[0], 42)
        (self.root / "cache.json").write_text('{"new":456}')
        self.call()
        self.assertEqual((self.root / "cache.json").read_text(), '{"new":456}')

    def test_same_name_imports_have_unique_ids(self):
        first = self.call("create", label="URLs.txt", text="one")
        second = self.call("create", label="URLs.txt", text="two")
        self.assertRegex(first["name"], r"^URLs-[A-Z0-9]{5}$")
        self.assertNotEqual(first["name"], second["name"])

    def test_edit_does_not_mutate_loaded_snapshot_and_restore_keeps_history(self):
        first = self.call("create", text="original", label="URLs.txt")
        name = first["name"]
        original_revision = first["revisions"][0]
        self.call("stage", name=name)
        updated = self.call("save", name=name, text="edited")
        self.assertEqual(updated["activeText"], "original")
        self.assertEqual(len(updated["revisions"]), 2)
        restored = self.call("restore", name=name, revision=original_revision)
        self.assertEqual(restored["text"], "original")
        self.assertEqual(len(restored["revisions"]), 3)
        with self.assertRaises(ValueError):
            self.call("save", name="URLs.txt", text="bypass")

    def test_rename_preserves_history_and_loaded_snapshot(self):
        first = self.call("create", text="original", label="URLs.txt")
        name = first["name"]
        self.call("stage", name=name)
        renamed = self.call("rename", name=name, label="My list")
        self.assertTrue((self.root / "workstations" / name / "My list.txt").is_file())
        self.assertEqual(renamed["revisions"], first["revisions"])
        self.call("save", name=name, text="new")
        self.assertEqual(self.call("load", name=name)["text"], "new")
        self.assertEqual(self.call("load", name=name)["activeText"], "original")
        self.assertEqual(self.call("stage", name=name)["activeText"], "new")
        with self.assertRaises(ValueError):
            self.call("rename", name=name, label="../escape")

    def test_all_compression_modes_persist(self):
        for mode in ["off", "cyberdrop", "filetree"]:
            self.assertEqual(self.call("mode", mode=mode)["compressionMode"], mode)

    def test_sideload_settings_survive_mode_changes_and_are_validated(self):
        defaults = dict(SIDELOAD_DEFAULTS)
        self.assertEqual(self.call()["sideload"], defaults)
        self.assertEqual(self.call("sideload", settings={"preset": "high"})["sideload"], {**defaults, "preset": "high"})
        self.call("mode", mode="filetree")
        self.assertEqual(self.call("sideload", settings={"originalAction": "recycle", "codec": "h265", "customQuality": 30})["sideload"],
                         {**defaults, "preset": "high", "originalAction": "recycle", "codec": "h265", "customQuality": 30})
        self.assertEqual(self.call("sideload", settings={"originalAction": "delete"})["sideload"]["originalAction"], "delete")
        for bad in ({"originalAction": "trash"}, {"unknown": "x"}, "high", {"concurrency": 3}, {"concurrency": True},
                    {"tagFilename": 1}, {"customQuality": 50}, {"minSizeBytes": 7}, {"encoder": "x264"}):
            with self.assertRaises(ValueError):
                self.call("sideload", settings=bad)


class CompletionHookTests(unittest.TestCase):
    def test_only_finalized_downloads_are_handed_off_after_mark_complete(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "finished.mp4"
            path.write_bytes(b"fixture")
            events = []
            class Client:
                async def mark_completed(self, item, domain):
                    events.append("marked")
            class Item:
                downloaded = True
                is_segment = False
            item = Item()
            item.path = path
            install_completion_hook(Client, lambda value: events.append(value))
            asyncio.run(Client().mark_completed(item, "host"))
            self.assertEqual(events, ["marked", str(path.resolve())])
            item.is_segment = True
            asyncio.run(Client().mark_completed(item, "host"))
            item.is_segment = False
            item.downloaded = False
            asyncio.run(Client().mark_completed(item, "host"))
            self.assertEqual(len(events), 4)


if __name__ == "__main__":
    unittest.main()
