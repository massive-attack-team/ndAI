"""Closed-loop verification and metrics.

We do not trust our own rewriter. Every sanitised prompt is fed back through
the same embedding detector that flagged it. Because detection is
similarity-and-margin based rather than keyword based, a lazy paraphrase
still scores above threshold - so the loop catches rewrites that only look
different. Two passes, then fail closed to block.

This proves the rewrite cleared OUR detector - exactly as good as the
detector is, no better. Say that when pressed.
"""
from __future__ import annotations

from typing import Callable

import numpy as np

from .adapters import max_score, to_findings
from .contract import Edit, Finding, Span, apply_edits_with_map

MAX_PASSES = 2
MASK_TOKEN = " [X] "


def _cos(a, b) -> float:
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    denom = (np.linalg.norm(a) * np.linalg.norm(b)) or 1e-9
    return float(np.dot(a, b) / denom)


def _mask(text: str, spans: list[Span]) -> str:
    out = text
    for s in sorted(spans, key=lambda s: s.start, reverse=True):
        out = out[: s.start] + MASK_TOKEN + out[s.end :]
    return out


def intent_retention(
    original: str,
    sanitised: str,
    flagged: list[Span],
    replaced: list[Span],
    embed: Callable[[str], "np.ndarray"],
) -> float:
    """Did the user's actual request survive?

    Both sides get their sensitive regions replaced by the same mask token,
    so the comparison measures the surrounding scaffolding - the question,
    the framing, the task - rather than rewarding a rewrite for staying
    similar to the secret. A naive cos(original, sanitised) would be
    confounded: you WANT that number to fall. This one you want to stay high.
    """
    a = embed(_mask(original, flagged))
    b = embed(_mask(sanitised, replaced))
    return max(0.0, _cos(a, b))


def leak_reduction(before: float, after: float) -> float:
    if before <= 0:
        return 0.0
    return max(0.0, (before - after) / before)


def run_loop(
    original: str,
    findings: list[Finding],
    detect: Callable[[str], object],
    plan_edits: Callable[[list[Finding], int], tuple[list[Edit], bool]],
) -> tuple[str, list[Edit], int, int, float, float]:
    """Returns (candidate, edits, passes, residual_count, score_before, score_after)."""
    score_before = max_score(findings)
    edits, hard_block = plan_edits(findings, 0)
    if hard_block:
        return original, edits, 0, len(findings), score_before, score_before

    candidate, _ = apply_edits_with_map(original, edits)
    passes = 1
    residual = to_findings(candidate, detect(candidate))

    while residual and passes <= MAX_PASSES:
        # Escalate only the findings that survived, mapped back to originals
        # by shared source doc.
        survivors = _map_back(findings, residual)
        extra, hard_block = plan_edits(survivors, passes)
        if hard_block:
            break
        edits = _merge(edits, extra)
        candidate, _ = apply_edits_with_map(original, edits)
        passes += 1
        residual = to_findings(candidate, detect(candidate))

    return (
        candidate,
        edits,
        passes,
        len(residual),
        score_before,
        max_score(residual),
    )


def _map_back(originals: list[Finding], residual: list[Finding]) -> list[Finding]:
    """Residual findings live in candidate-space. For escalation we need the
    original spans. Match by shared matched_source; if a residual hit has no
    ancestor (e.g. it's weak/no matched_source), escalate every original
    finding rather than under-escalate."""
    sources = {f.matched_source for f in residual if f.matched_source}
    hits = [f for f in originals if f.matched_source in sources]
    return hits or originals


def _merge(base: list[Edit], extra: list[Edit]) -> list[Edit]:
    """Later (escalated) edits win on the same span."""
    by_span = {(e.span.start, e.span.end): e for e in base}
    for e in extra:
        by_span[(e.span.start, e.span.end)] = e
    return sorted(by_span.values(), key=lambda e: e.span.start)
