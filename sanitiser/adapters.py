"""Adapter: detector.detection.DetectionResult -> list[contract.Finding].

This is the only file that knows the shape of detector/detection.py. If that
schema shifts, change it here rather than in every module downstream.

detector/detection.py's Finding (CONTRACT.md #2) is stable, merged code, not
a work-in-progress guess: type, sensitivity (0-3 ascending, 3=restricted=
worst), confidence (verbatim|paraphrase|weak), span (character offsets into
the ORIGINAL input text), evidence.matched_source/score. Offsets already
exist - detect() never needed a patch for this.
"""
from __future__ import annotations

from typing import Any

from .contract import Finding, Span

# category-only ("weak") findings carry no frontmatter tier; matches
# detector/categories.py's own SENSITIVITY fallback for an unmapped type.
DEFAULT_TIER = 2


def to_findings(original: str, detection_result: Any) -> list[Finding]:
    out: list[Finding] = []
    for f in detection_result.findings:
        start, end = f.span
        start = max(0, min(start, len(original)))
        end = max(start, min(end, len(original)))
        span = Span(start, end, original[start:end])
        out.append(Finding(
            span=span,
            confidence=f.confidence,
            tier=f.sensitivity if f.sensitivity is not None else DEFAULT_TIER,
            doc_type=f.type,
            score=float(f.evidence.score or 0.0),
            matched_source=f.evidence.matched_source,
        ))
    return out


def max_score(findings: list[Finding]) -> float:
    return max((f.score for f in findings), default=0.0)
