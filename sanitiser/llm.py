"""Local per-sentence rewrite via Ollama.

Design notes that matter for a small model:
  - One sentence per call, never the whole prompt - a 3B model loses the
    plot over long inputs and silently drops clauses.
  - format="json" + a one-key schema - free-form output adds "Sure! Here's
    the rewrite:" a good third of the time.
  - temperature 0.1 - you want boring.
  - Few-shot beats instruction at this size: three examples, one per
    in-scope doc type.
  - Hard timeout, and no fallback to the original text on failure - the
    caller (strategies.generalise) falls back to redact() instead. Never
    fail open.

Points at detector/config.py's OLLAMA_URL/OLLAMA_MODEL - the same instance
detector/rewrite.py uses - so there's one place to change the model, not two
copies that can drift.
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request

from detector import config

TIMEOUT_S = 12

SYSTEM = """You rewrite ONE sentence to remove confidential specifics while keeping the user's request answerable.

Rules:
- Keep the question, instruction or task exactly as asked.
- Replace specific figures, dates, internal names, codenames, metrics, and proprietary methods with generic equivalents.
- Never invent new facts. Never add commentary. Never apologise.
- If the sentence is nothing but a confidential fact with no request in it, return an empty string.

Respond with JSON only: {"rewritten": "..."}"""

FEWSHOT = [
    (
        "Our Series C closed at $4.2M on a $38M post-money with a 1x non-participating preference. Draft an investor update.",
        "We recently closed an early-stage funding round on standard preference terms. Draft an investor update.",
    ),
    (
        "Project Halberd moves cohort retention from 31% to 44% by day 21; summarise the risks.",
        "An internal initiative meaningfully improves three-week cohort retention; summarise the risks.",
    ),
    (
        "Our assay showed the modified enzyme reaches 2.3x turnover at pH 6.4 using the phosphate-buffer protocol. How should I frame this for a paper?",
        "Our assay showed a substantial turnover improvement under modified buffer conditions. How should I frame this for a paper?",
    ),
]


def _messages(sentence: str) -> list[dict]:
    msgs = [{"role": "system", "content": SYSTEM}]
    for src, dst in FEWSHOT:
        msgs.append({"role": "user", "content": src})
        msgs.append({"role": "assistant", "content": json.dumps({"rewritten": dst})})
    msgs.append({"role": "user", "content": sentence})
    return msgs


def _strip_fences(s: str) -> str:
    s = s.strip()
    s = re.sub(r"^```(?:json)?", "", s)
    s = re.sub(r"```$", "", s)
    return s.strip()


def generalise(sentence: str, doc_type: str = "unknown") -> str | None:
    """Return a rewritten sentence, or None if the model failed.

    None means the caller must fall back to redaction. Never return the
    original sentence on failure - that is failing open.
    """
    payload = {
        "model": config.OLLAMA_MODEL,
        "messages": _messages(sentence),
        "format": "json",
        "stream": False,
        "options": {"temperature": 0.1, "num_predict": 200},
    }
    req = urllib.request.Request(
        f"{config.OLLAMA_URL}/api/chat",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            body = json.loads(resp.read())
        raw = body["message"]["content"]
        out = (json.loads(_strip_fences(raw)).get("rewritten") or "").strip()
        return out or None
    except (urllib.error.URLError, TimeoutError, OSError, KeyError, json.JSONDecodeError):
        return None
