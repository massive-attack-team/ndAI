"""Orchestration: secrets -> detection -> policy -> rewrite.

Detection (type + sensitivity + confidence per CONTRACT.md) and policy
(what happens given that judgment) were built and tuned independently -
detector/detection.py and detector/policy.py respectively. This module is
the integration point where both sides get wired together with the secrets
scan, which stays a separate stage since it's pattern/entropy-based, not
part of the type+sensitivity judgment.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from . import audit, categories, detection, policy, provenance, rewrite, secrets_scan
from .embeddings import get_embedder
from .policy import DECISIONS
from sanitiser.service import sanitise as run_sanitiser


@dataclass
class Inspection:
    action: str
    rule: str
    message: str
    sensitivity: int
    risk: float
    latency_ms: float
    destination_class: str
    findings: list[dict[str, Any]] = field(default_factory=list)
    rewritten: str | None = None
    rewrite_note: str = ""
    baselines: dict[str, str] = field(default_factory=dict)
    sanitiser: dict[str, Any] = field(default_factory=dict)
    event_id: int | None = None


def _risk(sensitivity: int, destination_class: str) -> float:
    dest_weight = {
        "private_local": 0.15,
        "enterprise_vetted": 0.45,
        "public_consumer": 0.85,
        "unknown": 1.0,
    }.get(destination_class, 1.0)
    return round(min(1.0, (sensitivity / 3) * dest_weight), 2)


def inspect(text: str, *, destination: str, user: str = "unknown",
            role: str = "default", log_event: bool = True) -> Inspection:
    started = time.perf_counter()
    engine = policy.get_engine()
    dest_class = engine.classify_destination(destination)

    findings: list[dict[str, Any]] = []
    critical = False
    secret_spans: list[tuple[int, int]] = []

    # Stage 1 - credentials and PII. Separate from the type+sensitivity
    # judgment below (CONTRACT.md #1): pattern/entropy based, not corpus based.
    for f in secrets_scan.scan(text):
        secret_spans.append(f.span)
        critical = critical or f.critical
        findings.append({
            "kind": "secret", "label": f.label, "preview": f.preview,
            "critical": f.critical, "span": list(f.span),
        })

    # Stage 2 - detection: what kind of sensitive thing is this, and how
    # sensitive (detector/detection.py, CONTRACT.md #2).
    detection_result = detection.detect(text)
    for f in detection_result.findings:
        findings.append({
            "kind": "detection", "type": f.type, "sensitivity": f.sensitivity,
            "confidence": f.confidence, "span": list(f.span),
            "matched_source": f.evidence.matched_source, "score": f.evidence.score,
            "public_baseline_score": f.evidence.public_baseline_score,
            "margin": f.evidence.margin, "excerpt": f.evidence.excerpt,
        })

    secret_sensitivity = 3 if critical else (2 if secret_spans else 0)
    sensitivity = max(secret_sensitivity, detection_result.overall_sensitivity)

    # Stage 3 - policy: what happens to it, given who's sending and where
    # it's going (detector/policy.py, CONTRACT.md #5). Secrets and typed
    # findings are evaluated separately, then the more severe wins - a live
    # credential should block even if nothing else in the prompt does.
    secrets_decision = engine.evaluate(
        sensitivity=secret_sensitivity, destination_class=dest_class,
        role=role, has_critical_secret=critical,
    )
    detection_decision = engine.evaluate_detection(detection_result, destination_class=dest_class, role=role)
    decision = max(
        (secrets_decision, detection_decision),
        key=lambda d: DECISIONS.index(d.action),
    )

    rewritten, note = None, ""
    sanitiser_meta: dict[str, Any] = {}
    if decision.action == "sanitize":
        # Feature 2 (sanitiser/): per-span edits, verified by re-running
        # detect() on the candidate and escalating strategy up to 2 passes,
        # failing closed to block if it still leaks. Pass the DetectionResult
        # we already computed above so the prompt isn't re-embedded twice.
        san = run_sanitiser(text, detection_result)
        sanitiser_meta = {
            "passes": san.passes,
            "residual_findings": san.residual_findings,
            "leak_reduction": san.leak_reduction,
            "intent_retention": san.intent_retention,
            "edits": [
                {
                    "span": [e.span.start, e.span.end], "strategy": e.strategy,
                    "reason": e.reason, "tier": e.tier, "confidence": e.confidence,
                    "matched_source": e.matched_source,
                }
                for e in san.edits
            ],
        }
        if san.action == "block":
            decision = policy.Decision("block", decision.rule, san.reason or decision.message)
        else:
            rewritten, note = san.sanitised_text, san.reason

    withheld = len(text) if decision.action == "block" else (
        max(0, len(text) - len(rewritten or "")) if decision.action == "sanitize" else 0
    )
    latency = (time.perf_counter() - started) * 1000

    inspection = Inspection(
        action=decision.action, rule=decision.rule, message=decision.message,
        sensitivity=sensitivity, risk=_risk(sensitivity, dest_class),
        latency_ms=round(latency, 1), destination_class=dest_class,
        findings=findings, rewritten=rewritten, rewrite_note=note,
        baselines=_baselines(text, findings), sanitiser=sanitiser_meta,
    )

    if log_event:
        inspection.event_id = audit.record({
            "user": user, "role": role, "destination": destination,
            "destination_class": dest_class, "action": decision.action,
            "rule": decision.rule, "sensitivity": sensitivity, "risk": inspection.risk,
            "latency_ms": inspection.latency_ms, "chars_total": len(text),
            "chars_withheld": withheld, "text_sha256": audit.sha256(text),
            "preview": audit.redact(text, secret_spans), "findings": findings,
            "passes": sanitiser_meta.get("passes"),
            "residual_findings": sanitiser_meta.get("residual_findings"),
            "leak_reduction": sanitiser_meta.get("leak_reduction"),
            "intent_retention": sanitiser_meta.get("intent_retention"),
        })
    return inspection


def _baselines(text: str, findings: list[dict[str, Any]]) -> dict[str, str]:
    """What a regex DLP and a generic classifier would have said. This is the demo.

    generic_semantic re-runs the category classifier on the whole prompt,
    independent of whether a stronger provenance match already explains a
    given sentence - it needs to answer "what would topic-only classification
    alone have said," which is a different question from what detect()
    reports (detect() skips category checks on sentences a provenance hit
    already covers, since provenance is strictly stronger evidence there).
    """
    has_secret = any(f["kind"] == "secret" for f in findings)
    cat = categories.get_classifier().classify(text)
    strongest = max(
        (f for f in findings if f["kind"] == "detection" and f["confidence"] != "weak"),
        key=lambda f: (f["sensitivity"], f["score"] or 0),
        default=None,
    )
    return {
        "regex_dlp": "Credential or PII found" if has_secret else "No match",
        "generic_semantic": (
            f"Looks like {cat.label.replace('_', ' ')}" if cat else "No match"
        ),
        "ndai": (
            f"{strongest['score']:.0%} match to {strongest['matched_source']}" if strongest else
            ("Credential found" if has_secret else "No internal provenance")
        ),
    }


def warm_up() -> dict[str, Any]:
    emb = get_embedder()
    provenance.get_detector()
    categories.get_classifier()
    return {
        "embed_backend": emb.backend,
        "semantic": emb.is_semantic,
        "rewrite_model_up": rewrite.health(),
    }
