"""Stage 5: minimum-necessary-context rewrite, generated locally.

Two honest limits, stated here so nobody pitches past them:

1. Placeholder substitution is not protection. "[COMPANY] will acquire [TARGET]
   for [AMOUNT]" still tells the model there is a secret acquisition. The rewrite
   has to change what is being asked, not mask the nouns.

2. This only works for tasks where the sensitive content is context. If the
   sensitive content IS the problem to solve - verify this proof step, explain
   this assay result - there is no safe rewrite. The right answer is to route to
   the local model, and the API says so rather than pretending.
"""
from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from dataclasses import dataclass

from . import config

log = logging.getLogger("ndai.rewrite")

SYSTEM = """You rewrite prompts so an employee can get help from an external AI \
without disclosing confidential company information.

Rules:
- Remove every specific figure, name, codename, identifier, date and result.
- Keep the shape of the task: what kind of help the person actually wants.
- Describe the omitted material generically ("an efficacy figure", "an internal \
service name") so the answer is still applicable.
- Never invent replacement values or plausible-looking fake data.
- Output only the rewritten prompt. No preamble, no explanation."""

# Tasks where the sensitive content is the object of reasoning, not background.
REASONING_MARKERS = (
    "is this proof", "verify", "prove", "debug this", "why does this fail",
    "check my derivation", "is this correct", "find the bug", "review this result",
)


@dataclass
class RewriteResult:
    text: str | None
    available: bool
    reason: str


def _unsafe_to_rewrite(original: str) -> bool:
    low = original.lower()
    return any(marker in low for marker in REASONING_MARKERS)


def rewrite(original: str) -> RewriteResult:
    if _unsafe_to_rewrite(original):
        return RewriteResult(
            None, False,
            "The confidential content is the thing you want reasoned about, so no "
            "rewrite preserves the task. Use the internal model.",
        )

    payload = {
        "model": config.OLLAMA_MODEL,
        "system": SYSTEM,
        "prompt": original,
        "stream": False,
        "options": {"temperature": 0.2, "num_predict": 400},
    }
    req = urllib.request.Request(
        f"{config.OLLAMA_URL}/api/generate",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=config.REWRITE_TIMEOUT_S) as resp:
            body = json.loads(resp.read())
        text = (body.get("response") or "").strip()
        if not text:
            return RewriteResult(None, False, "Local model returned nothing.")
        return RewriteResult(text, True, "")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        log.warning("ollama unreachable: %s", exc)
        return RewriteResult(
            None, False,
            "Local rewrite model is not running. Start Ollama, or send nothing.",
        )


def health() -> bool:
    try:
        with urllib.request.urlopen(f"{config.OLLAMA_URL}/api/tags", timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False
