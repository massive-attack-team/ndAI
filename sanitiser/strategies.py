"""Turn a Finding + a chosen strategy into an Edit.

Ordering discipline: redact() and remove() need no model, so the
deterministic path works end to end before llm.py is even reachable.
"""
from __future__ import annotations

from . import llm, planner
from .contract import Edit, Finding

PLACEHOLDER = "[redacted: internal {label}]"


def _label(finding: Finding) -> str:
    return finding.doc_type.replace("_", " ") if finding.doc_type != "unknown" else "detail"


def redact(finding: Finding) -> Edit:
    return Edit(
        span=finding.span,
        replacement=PLACEHOLDER.format(label=_label(finding)),
        strategy="redact",
        reason=planner.reason_for("redact", finding),
        tier=finding.tier,
        confidence=finding.confidence,
        matched_source=finding.matched_source,
    )


def remove(finding: Finding) -> Edit:
    return Edit(
        span=finding.span,
        replacement="",
        strategy="remove",
        reason=planner.reason_for("remove", finding),
        tier=finding.tier,
        confidence=finding.confidence,
        matched_source=finding.matched_source,
    )


def generalise(finding: Finding) -> Edit:
    """LLM rewrite. Falls back to redaction on any failure - never to the
    original text."""
    rewritten = llm.generalise(finding.span.text, finding.doc_type)
    if rewritten is None:
        return redact(finding)
    if not rewritten.strip():
        return remove(finding)
    return Edit(
        span=finding.span,
        replacement=rewritten,
        strategy="generalise",
        reason=planner.reason_for("generalise", finding),
        tier=finding.tier,
        confidence=finding.confidence,
        matched_source=finding.matched_source,
    )


DISPATCH = {"redact": redact, "generalise": generalise, "remove": remove}


def build_edit(finding: Finding, strategy: str) -> Edit | None:
    """Returns None for 'block' - the caller handles prompt-level blocking."""
    fn = DISPATCH.get(strategy)
    return fn(finding) if fn else None
