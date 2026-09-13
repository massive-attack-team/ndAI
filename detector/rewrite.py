"""Local model access for the block path.

The rewrite itself (per-span edits, verified by re-running detect()) lives
in sanitiser/service.py. This module only backs the health check
(pipeline.warm_up()) and the block-path answer, both of which talk to the
same local Ollama instance.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

from . import config


def health() -> bool:
    try:
        with urllib.request.urlopen(f"{config.OLLAMA_URL}/api/tags", timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False


def answer_locally(prompt: str) -> str:
    """Block path: run the untouched prompt against the local model so the
    user still gets an answer without anything crossing the trust boundary.
    Makes block a destination rather than a dead end."""
    payload = {
        "model": config.OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.2, "num_predict": 600},
    }
    req = urllib.request.Request(
        f"{config.OLLAMA_URL}/api/generate",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read())
        return (body.get("response") or "").strip() or "Local model returned nothing."
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return f"Local model unavailable: {exc}"
