#!/usr/bin/env python3
"""
nano_banana.py — generate or edit an image with Gemini's image models
("nano banana") and write the result straight to a file.

Stdlib only. Credentials come from ClawDoc's settings.json (Settings → Gemini
tab in the app) — this script never takes a key on the command line so it
doesn't end up in shell history.

    python3 ~/.claude/skills/nano-banana/nano_banana.py "<prompt>" --out path/to/file.png
    python3 ~/.claude/skills/nano-banana/nano_banana.py "put the logo on the mug" \
        --ref logo.png --ref mug.png --out composite.png
"""

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request

SKILL_DIR = os.path.dirname(os.path.abspath(os.path.realpath(__file__)))

DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
DEFAULT_MODEL = "gemini-3.1-flash-image-preview"

EXT_MIME = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".gif": "image/gif",
}


def _clawdoc_settings_path():
    """Where ClawDoc keeps settings.json — same resolution as the crm skill's
    _clawdoc_settings(): a dev checkout two levels up from this symlinked
    skill dir, else the packaged app's per-platform userData dir."""
    repo = os.path.join(os.path.dirname(os.path.dirname(SKILL_DIR)), "settings.json")
    if os.path.exists(repo):
        return repo
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/ClawDoc/settings.json")
    if os.name == "nt":
        return os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"),
                             "ClawDoc", "settings.json")
    return os.path.expanduser("~/.config/ClawDoc/settings.json")


def _gemini_config():
    path = _clawdoc_settings_path()
    try:
        with open(path) as fh:
            settings = json.load(fh)
    except FileNotFoundError:
        sys.exit(f"ClawDoc settings not found at {path}. Open ClawDoc once to create it.")
    except Exception as e:
        sys.exit(f"couldn't read {path}: {e}")
    g = settings.get("gemini") or {}
    api_key = g.get("apiKey") or ""
    if not api_key:
        sys.exit("No Gemini API key configured. Open ClawDoc → Settings → Gemini and add one.")
    base_url = g.get("baseUrl") or DEFAULT_BASE_URL
    image_model = g.get("imageModel") or DEFAULT_MODEL
    return api_key, base_url.rstrip("/"), image_model


def _mime_for(path):
    return EXT_MIME.get(os.path.splitext(path)[1].lower(), "application/octet-stream")


def generate(api_key, base_url, model, prompt, ref_paths):
    parts = []
    for rp in ref_paths:
        with open(rp, "rb") as fh:
            data = base64.b64encode(fh.read()).decode("ascii")
        parts.append({"inlineData": {"mimeType": _mime_for(rp), "data": data}})
    parts.append({"text": prompt})

    payload = json.dumps({
        "contents": [{"parts": parts}],
        "generationConfig": {"responseModalities": ["IMAGE", "TEXT"]},
    }).encode("utf-8")

    url = f"{base_url}/models/{model}:generateContent?key={api_key}"
    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"}, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        try:
            msg = json.loads(detail)["error"]["message"]
        except Exception:
            msg = detail or str(e)
        sys.exit(f"Gemini API error: {msg}")
    except urllib.error.URLError as e:
        sys.exit(f"couldn't reach Gemini: {e}")

    block = (body.get("promptFeedback") or {}).get("blockReason")
    if block:
        sys.exit(f"Gemini blocked the request: {block}")

    candidates = body.get("candidates") or []
    if not candidates:
        sys.exit("Gemini returned no candidates")

    out_parts = (candidates[0].get("content") or {}).get("parts") or []
    img = next((p for p in out_parts if (p.get("inlineData") or {}).get("data")), None)
    text = "\n".join(p["text"] for p in out_parts if p.get("text")).strip()

    if not img:
        reason = candidates[0].get("finishReason", "no image returned")
        extra = f": {text}" if text else ""
        sys.exit(f"Gemini returned no image ({reason}){extra}")

    return base64.b64decode(img["inlineData"]["data"]), img["inlineData"].get("mimeType", "image/png"), text


def main():
    ap = argparse.ArgumentParser(description="Generate or edit an image with Gemini (nano banana).")
    ap.add_argument("prompt", help="what to generate — see SKILL.md for how to write this well")
    ap.add_argument("--out", required=True, help="output file path; extension should match the format (.png)")
    ap.add_argument("--ref", action="append", default=[], metavar="PATH",
                     help="reference image to compose/edit (repeatable, in order)")
    ap.add_argument("--model", default=None, help="override the configured image model")
    args = ap.parse_args()

    for rp in args.ref:
        if not os.path.exists(rp):
            sys.exit(f"reference image not found: {rp}")

    api_key, base_url, default_model = _gemini_config()
    model = args.model or default_model

    data, mime, text = generate(api_key, base_url, model, args.prompt, args.ref)

    out = os.path.expanduser(args.out)
    out_dir = os.path.dirname(os.path.abspath(out))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(out, "wb") as fh:
        fh.write(data)

    print(f"wrote {out} ({len(data)} bytes, {mime})")
    if text:
        print(f"model note: {text}")


if __name__ == "__main__":
    main()
