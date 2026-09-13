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

from detector.detection import detect
from detector.embeddings import get_embedder
from detector.rewrite import REASONING_MARKERS


def _embed(text: str):
    return get_embedder().encode([text])[0]


def _plan_edits(findings: list[Finding], escalations: int) -> tuple[list[Edit], bool]:
    edits: list[Edit] = []
    hard_block = False
    for f in findings:
        strategy = planner.decide(f, escalations)
        if strategy == "block":
            hard_block = True
            continue
        e = strategies.build_edit(f, strategy)
        if e:
            edits.append(e)
    return edits, hard_block


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
        text, findings, detect, _plan_edits
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
        reason=_block_reason(findings, residual) if action == "block" else "",
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


def _block_reason(findings: list[Finding], residual: int) -> str:
    if residual:
        return (
            f"Rewriting was attempted but {residual} sentence(s) still matched internal "
            "material after two passes. Blocked rather than sent."
        )
    worst = max(f.tier for f in findings)  # 3 = restricted = worst, CONTRACT.md #3
    src = next((f.matched_source for f in findings if f.tier == worst), "internal material")
    return f"Verbatim tier-{worst} match against {src}. Not safe to rewrite."
