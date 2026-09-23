"""Central Cyberdrop workspace and versioned URL documents. No downloads here."""
import contextlib
import json
import os
from pathlib import Path
import secrets
import shutil
import sqlite3
import string
import sys
import time
import yaml


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".saving")
    temp.write_text(text, encoding="utf-8")
    temp.replace(path)


def read(path):
    if path.stat().st_size > 2 * 1024 * 1024:
        raise ValueError("URL document exceeds 2 MB")
    return path.read_text(encoding="utf-8-sig")


def station(root, name):
    if len(name) != 10 or not name.startswith("URLs-") or any(c not in string.ascii_uppercase + string.digits for c in name[5:]):
        raise ValueError("Invalid workstation ID")
    return root / "workstations" / name


def stamp():
    return time.time_ns()


def metadata(folder):
    return json.loads((folder / "meta.json").read_text(encoding="utf-8"))


def save_meta(folder, meta):
    write(folder / "meta.json", json.dumps(meta, ensure_ascii=False))


def url_path(folder):
    return folder / metadata(folder).get("filename", "URLs.txt")


def rename(folder, label):
    label = label.strip()
    if not label.lower().endswith(".txt"):
        label += ".txt"
    stem = label[:-4]
    reserved = {"CON", "PRN", "AUX", "NUL", *("COM" + str(i) for i in range(1, 10)), *("LPT" + str(i) for i in range(1, 10))}
    if not stem or len(label) > 120 or stem.endswith((" ", ".")) or stem.upper() in reserved or any(ord(c) < 32 or c in '<>:"/\\|?*' for c in label):
        raise ValueError("Choose a valid .txt filename without folders or special characters")
    old = url_path(folder)
    target = folder / label
    if target.exists() and target != old:
        raise ValueError("This filename already exists in the workstation")
    old.replace(target)
    meta = metadata(folder)
    meta.update(filename=label, label=label, edited=stamp())
    save_meta(folder, meta)


def save(folder, text):
    if len(text.encode("utf-8")) > 2 * 1024 * 1024:
        raise ValueError("URL document exceeds 2 MB")
    revision = str(stamp())
    target = url_path(folder)
    if not target.exists() or read(target) != text:
        write(folder / "history" / (revision + ".txt"), text)
        write(target, text)
    meta = metadata(folder)
    meta["edited"] = stamp()
    save_meta(folder, meta)


def create(root, text, label):
    if len(text.encode("utf-8")) > 2 * 1024 * 1024:
        raise ValueError("URL document exceeds 2 MB")
    for _ in range(100):
        name = "URLs-" + "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(5))
        folder = station(root, name)
        try:
            folder.mkdir()
            break
        except FileExistsError:
            continue
    else:
        raise ValueError("Could not allocate a unique workstation")
    save_meta(folder, {"id": name, "label": label or "Untitled", "opened": stamp(), "edited": stamp()})
    save(folder, text)
    return name


def initialize(root, base):
    root.mkdir(parents=True, exist_ok=True)
    for folder in ["workstations", "logs", "runtime"]:
        (root / folder).mkdir(exist_ok=True)
    marker = root / "central-workspace-v2.json"
    if marker.exists():
        return
    cfg = root / "config.yml"
    if not cfg.exists():
        source = base / "config.yaml"
        write(cfg, read(source) if source.exists() else "download_folder: downloads/cyberdrop-dl\ncompression_options:\n  enabled: false\n")
    if not (root / "config.before-central.yml").exists():
        shutil.copy2(cfg, root / "config.before-central.yml")
    values = yaml.safe_load(read(cfg)) or {}
    values.setdefault("logs", {})["folder"] = str(root / "logs")
    write(cfg, yaml.safe_dump(values, sort_keys=False, allow_unicode=True))
    if not (root / "cache.json").exists():
        source = base / "cache.json"
        if source.exists():
            content = source.read_text(encoding="utf-8-sig")
            if content.strip() and not isinstance(json.loads(content), dict):
                raise ValueError("The source cache must contain a JSON object")
            write(root / "cache.json", content)
        else:
            write(root / "cache.json", "{}")
    if not (root / "cyberdrop.db").exists():
        source = Path(os.environ.get("APPDATA", str(root))) / "cyberdrop-dl" / "cyberdrop.db"
        temp = root / "cyberdrop.importing.db"
        with contextlib.closing(sqlite3.connect(temp)) as destination:
            if source.exists():
                # SQLite backup includes committed WAL data, even while the CLI is open.
                with contextlib.closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as connection:
                    connection.backup(destination)
        temp.replace(root / "cyberdrop.db")
    existing = list((root / "workstations").glob("URLs-*/meta.json"))
    if not existing:
        legacy = sorted((root / "lists").glob("*.txt"))
        for path in legacy:
            create(root, read(path), path.name)
        if not legacy:
            create(root, "", "Untitled")
    if not (root / "URLs.txt").exists():
        write(root / "URLs.txt", "")
    if not (root / "preferences.json").exists():
        mode = "cyberdrop" if values.get("compression_options", {}).get("enabled", False) else "off"
        write(root / "preferences.json", json.dumps({"compressionMode": mode}))
    write(marker, json.dumps({"created": stamp(), "base": str(base)}))


# Side-load settings sent with each FileTree compression batch; they mirror the
# Compress page's options. The compression job verifies each copy before it
# disposes of the original, whichever originalAction is chosen.
SIDELOAD_DEFAULTS = {"preset": "balanced", "originalAction": "keep", "tagFilename": True,
                     "codec": "h264", "encoder": "auto", "concurrency": 2, "zipLevel": -1, "minSizeBytes": 0,
                     "customMaxHeight": 1080, "customQuality": 26}
SIDELOAD_CHOICES = {
    "preset": ("max", "more", "balanced", "high", "custom"),
    "originalAction": ("keep", "recycle", "delete"),
    "tagFilename": (True, False),
    "codec": ("h264", "h265", "av1"),
    "encoder": ("auto", "nvenc", "qsv", "vce"),
    "concurrency": (1, 2),
    "zipLevel": tuple(range(-1, 10)),
    "minSizeBytes": tuple(n * 1024 for n in (0, 256, 512, 1024, 2048, 5120, 10240, 25600, 51200, 102400)),
    "customMaxHeight": (0, 480, 720, 1080, 1440),
    "customQuality": tuple(range(16, 41)),
}


def sideload_valid(key, value):
    # type() keeps True from passing as 1 and 1 from passing as True.
    return key in SIDELOAD_CHOICES and type(value) is type(SIDELOAD_DEFAULTS[key]) and value in SIDELOAD_CHOICES[key]


def preferences(root):
    prefs = json.loads((root / "preferences.json").read_text())
    saved = prefs.get("sideload") if isinstance(prefs.get("sideload"), dict) else {}
    prefs["sideload"] = {key: saved[key] if sideload_valid(key, saved.get(key)) else default
                         for key, default in SIDELOAD_DEFAULTS.items()}
    return prefs


def operate(request):
    root = Path(request["root"])
    # "base" is an optional older cyberdrop-dl folder to import config and cache from.
    initialize(root, Path(request["base"]) if request.get("base") else root)
    action = request.get("action", "init")
    name = request.get("name", "")
    if action == "create":
        name = create(root, request.get("text", ""), request.get("label", "Untitled"))
    elif action in ("save", "stage", "restore", "load", "revision", "rename"):
        folder = station(root, name)
        if action == "save":
            save(folder, request["text"])
        elif action == "rename":
            rename(folder, request.get("label", ""))
        elif action in ("restore", "revision"):
            revision = request.get("revision", "")
            if not revision.isdigit():
                raise ValueError("Invalid revision")
            restored = read(folder / "history" / (revision + ".txt"))
            if action == "restore":
                save(folder, restored)
            else:
                return {"text": restored}
        elif action == "stage":
            write(root / "URLs.txt", read(url_path(folder)))
            write(root / "loaded.json", json.dumps({"id": name, "loaded": stamp()}))
        if action == "load":
            meta = metadata(folder)
            meta["opened"] = stamp()
            save_meta(folder, meta)
    elif action == "mode":
        mode = request["mode"]
        if mode not in ("off", "cyberdrop", "filetree"):
            raise ValueError("Invalid compression mode")
        values = yaml.safe_load(read(root / "config.yml")) or {}
        values.setdefault("compression_options", {})["enabled"] = mode == "cyberdrop"
        write(root / "config.yml", yaml.safe_dump(values, sort_keys=False, allow_unicode=True))
        prefs = preferences(root)
        prefs["compressionMode"] = mode
        write(root / "preferences.json", json.dumps(prefs))
    elif action == "sideload":
        settings = request.get("settings")
        if not isinstance(settings, dict) or not all(sideload_valid(key, value) for key, value in settings.items()):
            raise ValueError("Invalid side-load settings")
        prefs = preferences(root)
        prefs["sideload"].update(settings)
        write(root / "preferences.json", json.dumps(prefs))
    elif action != "init":
        raise ValueError("Unknown workspace action")
    stations = [metadata(path.parent) for path in (root / "workstations").glob("URLs-*/meta.json")]
    stations.sort(key=lambda item: max(item["opened"], item["edited"]), reverse=True)
    if not name and stations:
        name = stations[0]["id"]
    folder = station(root, name)
    revisions = sorted((folder / "history").glob("*.txt"), reverse=True)
    loaded = json.loads((root / "loaded.json").read_text()) if (root / "loaded.json").exists() else None
    prefs = preferences(root)
    return {"folder": str(root), "name": name, "text": read(url_path(folder)), "stations": stations,
            "revisions": [path.stem for path in revisions], "loaded": loaded,
            "activeText": read(root / "URLs.txt"), "compressionMode": prefs["compressionMode"], "sideload": prefs["sideload"]}


if __name__ == "__main__":
    try:
        print(json.dumps(operate(json.load(sys.stdin)), ensure_ascii=True))
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
