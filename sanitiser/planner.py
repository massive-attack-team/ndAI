"""Decide WHAT to do with each finding. No model calls here - pure policy.

Keeping this declarative is the answer to "how do you decide whether to
redact or rewrite?" - a table, not a story. It's also the knob a customer
would actually tune.

Tier convention: 0 public, 1 internal, 2 confidential, 3 restricted -
ascending severity, matching CONTRACT.md #3 and policy.yaml exactly. A
finding only reaches this module after policy.yaml's own rules already
decided the prompt-level action is "sanitize" (see detector/pipeline.py) -
tier-0 findings, and most weak-confidence ones, are filtered out earlier.
"""
from __future__ import annotations

from .contract import Confidence, Finding, Strategy

# (tier, confidence) -> strategy, or "block" to kill the whole prompt.
# tier 3 = restricted = most sensitive.
POLICY: dict[tuple[int, Confidence], str] = {
    (3, "verbatim"):   "block",        # restricted, copied literally - do not negotiate
    (3, "paraphrase"): "redact",
    (3, "weak"):       "generalise",
    (2, "verbatim"):   "redact",       # a discrete confidential fact: cut it
    (2, "paraphrase"): "generalise",
    (2, "weak"):       "generalise",
    (1, "verbatim"):   "generalise",   # internal - mildest tier that reaches here
    (1, "paraphrase"): "generalise",
    (1, "weak"):       "generalise",
}

# Applied when a pass fails verification: try something blunter.
ESCALATION: dict[str, str] = {
    "generalise": "redact",
    "redact": "remove",
    "remove": "block",
}

REASONS = {
    "redact":     "Matched internal {doc_type} ({source}) — specific removed",
    "generalise": "Matched internal {doc_type} ({source}) — rewritten at a general level",
    "remove":     "Rewriting still matched internal {doc_type} — sentence dropped",
}


def decide(finding: Finding, escalations: int = 0) -> str:
    base = POLICY.get((finding.tier, finding.confidence), "generalise")
    for _ in range(escalations):
        base = ESCALATION.get(base, "block")
    return base


def reason_for(strategy: str, finding: Finding) -> str:
    source = finding.matched_source or "category classifier"
    template = REASONS.get(strategy, "Flagged as sensitive")
    return template.format(doc_type=finding.doc_type.replace("_", " "), source=source)


def prompt_action(strategies: list[str], residual: int) -> str:
    """Aggregate per-finding decisions into one prompt-level action."""
    if "block" in strategies:
        return "block"
    if residual > 0:
        return "block"      # still leaking after max passes - fail closed
    if strategies:
        return "sanitise"
    return "allow"
