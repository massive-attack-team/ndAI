"""The shape shared by every module in this package, and by whoever builds
the diff UI against it.

Frozen deliberately: Edit carries offsets into the ORIGINAL text, and
sanitised text is a pure function of which edits are accepted
(apply_edits). That's what lets a UI toggle one span off and re-render
locally with no round trip back to the model.

Tier convention matches CONTRACT.md #3 and policy.yaml exactly: 0 public,
1 internal, 2 confidential, 3 restricted - ascending severity, 3 is worst.
Don't invert this; detector/detection.py's Finding.sensitivity already
follows it.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Literal

Confidence = Literal["verbatim", "paraphrase", "weak"]
Strategy = Literal["redact", "generalise", "remove", "block"]


@dataclass(frozen=True)
class Span:
    start: int
    end: int
    text: str


@dataclass
class Finding:
    span: Span
    confidence: Confidence
    tier: int                       # 0-3, ascending, 3 = restricted = worst
    doc_type: str
    score: float
    matched_source: str | None = None


@dataclass
class Edit:
    span: Span                      # offsets into the ORIGINAL text
    replacement: str
    strategy: Strategy
    reason: str
    tier: int
    confidence: Confidence
    matched_source: str | None = None
    accepted: bool = True


@dataclass
class SanitisationResult:
    action: str                     # allow | sanitise | block
    original_text: str
    sanitised_text: str
    edits: list[Edit] = field(default_factory=list)
    passes: int = 0
    residual_findings: int = 0
    leak_reduction: float = 0.0
    intent_retention: float = 0.0
    latency_ms: int = 0
    reason: str = ""
    audit_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])

    def to_json(self) -> dict:
        return {
            "action": self.action,
            "sanitised_text": self.sanitised_text,
            "edits": [
                {
                    "span": {"start": e.span.start, "end": e.span.end, "text": e.span.text},
                    "replacement": e.replacement,
                    "strategy": e.strategy,
                    "reason": e.reason,
                    "tier": e.tier,
                    "confidence": e.confidence,
                    "matched_source": e.matched_source,
                    "accepted": e.accepted,
                }
                for e in self.edits
            ],
            "passes": self.passes,
            "residual_findings": self.residual_findings,
            "leak_reduction": self.leak_reduction,
            "intent_retention": self.intent_retention,
            "latency_ms": self.latency_ms,
            "reason": self.reason,
            "audit_id": self.audit_id,
        }


def apply_edits_with_map(text: str, edits: list[Edit]) -> tuple[str, list[Span]]:
    """Apply accepted edits (left to right, by original-text offset) and
    return (new_text, spans the replacements now occupy in new_text).

    The replacement spans are what intent_retention masks in the sanitised
    side of its comparison - see verify.py.
    """
    accepted = sorted((e for e in edits if e.accepted), key=lambda e: e.span.start)
    parts: list[str] = []
    new_len = 0
    cursor = 0
    replaced_spans: list[Span] = []
    for e in accepted:
        prefix = text[cursor:e.span.start]
        parts.append(prefix)
        new_len += len(prefix)
        start_in_new = new_len
        parts.append(e.replacement)
        new_len += len(e.replacement)
        replaced_spans.append(Span(start_in_new, new_len, e.replacement))
        cursor = e.span.end
    parts.append(text[cursor:])
    return "".join(parts), replaced_spans


def apply_edits(text: str, edits: list[Edit]) -> str:
    return apply_edits_with_map(text, edits)[0]
