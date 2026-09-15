"""Run the live Cyberdrop source, optionally reporting finalized downloads."""
import json
import os
import sys
import threading
import atexit


def progress_snapshot(panel):
    rows = list(panel.__json__())
    return {"files": rows[:500], "active": len(rows),
            "bytes": panel.bytes_downloaded,
            "speed": sum(row.get("speed") or 0 for row in rows)}


def dashboard_snapshot(ui):
    from cyberdrop_dl.progress import strip_markup
    value = progress_snapshot(ui.downloads)
    compression = ui.compression_progress
    value.update(
        fileStats=ui.files.__json__(),
        scrapeErrors=ui.scrape_errors.__json__(),
        downloadErrors=ui.download_errors.__json__(),
        scraping=ui.scrape.__json__(),
        scrapeQueued=ui.scrape.get_queue(),
        downloadQueued=ui.downloads.get_queue(),
        status=ui.status.__json__(),
        compression={
            "title": strip_markup(str(compression._panel.title)),
            "pending": compression._pending, "compressed": compression._compressed,
            "skipped": compression._skipped, "failed": compression._failed,
            "total": compression._total,
            "files": [{"id": task.id, "name": strip_markup(task.description),
                       "completed": task.completed, "total": task.total,
                       "speed": task.speed, "eta": task.time_remaining}
                      for task in compression._active_progress.tasks],
        },
    )
    return value


def install_progress_hook(panel_class, emit, snapshot=progress_snapshot):
    original = panel_class.__init__

    def initialize(self, *args, **kwargs):
        original(self, *args, **kwargs)

        def send_snapshot():
            try:
                emit(snapshot(self))
            except Exception:
                # Monitoring must never interrupt a download.
                pass

        atexit.register(send_snapshot)

        def report():
            while True:
                send_snapshot()
                threading.Event().wait(0.5)

        threading.Thread(target=report, daemon=True).start()

    panel_class.__init__ = initialize


def install_completion_hook(client_class, emit):
    original = client_class.mark_completed

    async def completed(self, media_item, domain):
        result = await original(self, media_item, domain)
        if getattr(media_item, "downloaded", False) and not getattr(media_item, "is_segment", False):
            path = getattr(media_item, "path", None)
            if path and path.is_file():
                emit(str(path.resolve()))
        return result

    client_class.mark_completed = completed


if __name__ == "__main__":
    from cyberdrop_dl.progress.scraping import ScrapingUI
    install_progress_hook(ScrapingUI, lambda value: print("\nFILETREE_PROGRESS:" + json.dumps(value), flush=True), dashboard_snapshot)
    if os.environ.get("FILETREE_SIDELOAD") == "1":
        from cyberdrop_dl.clients.downloads import DownloadClient
        install_completion_hook(DownloadClient, lambda path: print("\nFILETREE_COMPLETED:" + json.dumps(path), flush=True))
    from cyberdrop_dl.__main__ import main
    main(sys.argv[1:])
