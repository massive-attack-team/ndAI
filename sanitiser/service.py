"""Public entry point for the sanitiser.

    from sanitiser.service import sanitise
    result = sanitise(prompt_text)
    result.to_json()

detector/pipeline.py calls this for the "sanitize" policy decision, passing
its already-computed DetectionResult in so the prompt isn't re-embedded
twice. Standalone callers (eval/sanitiser_eval.py) can omit it and let this
module run detect() itself.
"""
from __future__ import annotations

import time
from typing import Any

from . import planner, strategies, verify
from .adapters import to_findings
from .contract import Edit, Finding, SanitisationResult, apply_edits, apply_edits_with_map

from detector.detection import DetectionResult, Evidence, detect, detect_with_near_misses
from detector.detection import Finding as DetectionFinding
from detector.embeddings import get_embedder
from detector.rewrite import REASONING_MARKERS


def _embed(text: str):
    return get_embedder().encode([text])[0]


# Harsher wins when two findings land on the same sentence, e.g. a paraphrase
# finding and a cumulative one. Two edits on one span would apply twice.
SEVERITY = {"generalise": 0, "redact": 1, "remove": 2}


def _plan_edits(findings: list[Finding], escalations: int) -> tuple[list[Edit], bool]:
    by_span: dict[tuple[int, int], Edit] = {}
    hard_block = False
    for f in findings:
        strategy = planner.decide(f, escalations)
        if strategy == "block":
            hard_block = True
            continue
        key = (f.span.start, f.span.end)
        if key in by_span and SEVERITY[by_span[key].strategy] >= SEVERITY[strategy]:
            continue
        e = strategies.build_edit(f, strategy)
        if e:
            by_span[key] = e
    return sorted(by_span.values(), key=lambda e: e.span.start), hard_block


def _detector_for(findings: list[Finding]):
    """What the verify loop re-runs on each candidate.

    A cumulative finding (CONTRACT.md #9) is built from near misses: sentences
    that match an internal document but not strongly enough for detect() to
    report. Re-running detect() alone would call any such rewrite clean. So
    for documents with a cumulative finding, a near miss left in the candidate
    counts as a residual finding too.
    """
    docs = {f.matched_source for f in findings if f.confidence == "cumulative" and f.matched_source}
    if not docs:
        return detect

    def detect_including_near_misses(candidate: str) -> DetectionResult:
        result, near_misses = detect_with_near_misses(candidate)
        extra = [
            DetectionFinding(
                type=n.type, sensitivity=n.sensitivity, confidence="cumulative", span=n.span,
                evidence=Evidence(
                    matched_source=n.doc, score=n.score,
                    public_baseline_score=round(n.score - n.margin, 3), margin=n.margin,
                    excerpt="", matched_chunk=n.chunk,
                ),
            )
            for n in near_misses
            if n.doc in docs
        ]
        return DetectionResult(findings=result.findings + extra)

    return detect_including_near_misses


def sanitise(text: str, detection_result: Any = None) -> SanitisationResult:
    t0 = time.perf_counter()
    findings = to_findings(text, detection_result if detection_result is not None else detect(text))

    if not findings:
        return SanitisationResult(
            action="allow",
            original_text=text,
            sanitised_text=text,
            latency_ms=int((time.perf_counter() - t0) * 1000),
        )

    # Ported from detector/rewrite.py's _unsafe_to_rewrite (shared constant,
    # not a copy that can drift). Some prompts have no safe edit at any span:
    # the sensitive content is the thing being reasoned about ("verify this
    # proof", "why does this fail"), not background the task can survive
    # losing. No per-span strategy fixes that, so don't try - block outright
    # and say why, same message the old whole-prompt rewriter gave.
    if any(marker in text.lower() for marker in REASONING_MARKERS):
        return SanitisationResult(
            action="block",
            original_text=text,
            sanitised_text=text,
            latency_ms=int((time.perf_counter() - t0) * 1000),
            reason=(
                "The confidential content is the thing you want reasoned about, so no "
                "rewrite preserves the task. Use the internal model."
            ),
        )

    candidate, edits, passes, residual, before, after = verify.run_loop(
        text, findings, _detector_for(findings), _plan_edits
    )
    strategies_used = [planner.decide(f, 0) for f in findings]
    action = planner.prompt_action(strategies_used, residual)

    _, replaced_spans = apply_edits_with_map(text, edits)
    retention = verify.intent_retention(
        text, candidate, [f.span for f in findings], replaced_spans, _embed
    )

    return SanitisationResult(
        action=action,
        original_text=text,
        sanitised_text=text if action == "block" else candidate,
        edits=edits,
        passes=passes,
        residual_findings=residual,
        leak_reduction=verify.leak_reduction(before, after),
        intent_retention=retention,
        latency_ms=int((time.perf_counter() - t0) * 1000),
        reason=_block_reason(findings, passes, residual) if action == "block" else "",
    )


def reapply(original: str, edits_json: list[dict]) -> str:
    """UI toggled accept/reject on some spans - recompute without re-running
    the model. Cheap enough to call on every checkbox click."""
    from .contract import Span

    edits = [
        Edit(
            span=Span(e["span"]["start"], e["span"]["end"], e["span"]["text"]),
            replacement=e["replacement"],
            strategy=e["strategy"],
            reason=e["reason"],
            tier=e["tier"],
            confidence=e["confidence"],
            matched_source=e.get("matched_source"),
            accepted=e.get("accepted", True),
        )
        for e in edits_json
    ]
    return apply_edits(original, edits)


def _block_reason(findings: list[Finding], passes: int, residual: int) -> str:
    if passes and residual:
        return (
            f"Rewriting was attempted but {residual} sentence(s) still matched internal "
            "material after two passes. Blocked rather than sent."
        )
    worst = max(f.tier for f in findings)  # 3 = restricted = worst, CONTRACT.md #3
    src = next((f.matched_source for f in findings if f.tier == worst), "internal material")
    return f"Verbatim tier-{worst} match against {src}. Not safe to rewrite."
