"""Stage 1: cheap pattern and entropy checks.

Runs first and short-circuits. A hardcoded credential is never a judgement call,
so it never needs the expensive stages.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import List

RULES = [
    ("AWS access key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b")),
    ("Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("OpenAI key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")),
    ("Anthropic key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}\b")),
    ("Private key block", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    ("Connection string", re.compile(r"\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?)://[^\s:@]+:[^\s:@]+@\S+")),
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")),
    ("Email address", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    ("Credit card", re.compile(r"\b(?:\d[ -]*?){13,16}\b")),
    ("AU TFN", re.compile(r"\b\d{3}\s?\d{3}\s?\d{3}\b")),
]

# key = "value" where value looks random
ASSIGNMENT = re.compile(
    r"""(?i)\b(api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key)\b\s*[:=]\s*["']?([^\s"',;]{12,})""",
)

LOW_RISK = {"Email address", "AU TFN", "Credit card"}  # PII, not infrastructure access


@dataclass
class SecretFinding:
    label: str
    span: tuple[int, int]
    preview: str
    critical: bool


def shannon_entropy(s: str) -> float:
    if not s:
        return 0.0
    counts = {c: s.count(c) for c in set(s)}
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in counts.values())


def _mask(s: str) -> str:
    if len(s) <= 8:
        return "*" * len(s)
    return f"{s[:4]}{'*' * (len(s) - 8)}{s[-4:]}"


def scan(text: str) -> List[SecretFinding]:
    found: List[SecretFinding] = []
    seen: set[tuple[int, int]] = set()

    for label, rx in RULES:
        for m in rx.finditer(text):
            if m.span() in seen:
                continue
            seen.add(m.span())
            found.append(SecretFinding(label, m.span(), _mask(m.group(0)), label not in LOW_RISK))

    for m in ASSIGNMENT.finditer(text):
        value = m.group(2)
        if shannon_entropy(value) < 3.0:
            continue  # "password = changeme" in a doc is not a live credential
        if m.span() in seen:
            continue
        seen.add(m.span())
        found.append(SecretFinding(f"High-entropy {m.group(1).lower()}", m.span(), _mask(value), True))

    return found
