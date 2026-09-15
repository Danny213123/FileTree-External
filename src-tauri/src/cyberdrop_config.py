"""Config bridge executed with the user's Cyberdrop virtual environment."""
import json
import sys
import yaml
from cyberdrop_dl.config import Config

request = json.load(sys.stdin)
try:
    value = yaml.safe_load(request["text"]) or {}
    if not isinstance(value, dict):
        raise ValueError("Config must be a YAML mapping")
    for path, replacement in (request.get("patch") or {}).items():
        parts = path.split(".")
        target = value
        for part in parts[:-1]:
            if not isinstance(target.get(part), dict):
                target[part] = {}
            target = target[part]
        target[parts[-1]] = replacement
    Config.model_validate(value)
    text = yaml.safe_dump(value, sort_keys=False, allow_unicode=True) if request.get("patch") else request["text"]
    print(json.dumps({"text": text, "settings": value}))
except Exception as error:
    # Validation inputs can contain credentials; never echo them into logs.
    if hasattr(error, "errors"):
        message = "; ".join(".".join(map(str, item["loc"])) + ": " + item["type"] for item in error.errors())
    else:
        message = "Invalid YAML/configuration (check indentation and value types)"
    print(json.dumps({"error": message}))
    sys.exit(1)
