"""Orchestration: secrets -> detection -> context -> policy -> rewrite.

Detection and response meet through a DetectionResult (CONTRACT.md #2). The
context stage (CONTRACT.md #9) adds `cumulative` findings to it before policy
sees it, and records what was sent after policy decides.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from . import audit, categories, context, detection, policy, provenance, rewrite, secrets_scan
from .embeddings import get_embedder


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
    context: list[dict[str, Any]] = field(default_factory=list)
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
    user = (user or "unknown").lower()
    team = engine.team_of(user)

    findings: list[dict[str, Any]] = []
    sensitivity = 0
    critical = False
    secret_spans: list[tuple[int, int]] = []

    # Stage 1 - credentials and PII, outside DetectionResult (CONTRACT.md #1)
    for f in secrets_scan.scan(text):
        secret_spans.append(f.span)
        critical = critical or f.critical
        findings.append({
            "kind": "secret", "label": f.label, "preview": f.preview,
            "critical": f.critical, "span": list(f.span),
        })
        sensitivity = max(sensitivity, 3 if f.critical else 2)
    secret_decision = engine.evaluate(
        sensitivity=sensitivity, destination_class=dest_class,
        role=role, has_critical_secret=critical,
    ) if findings else None

    # Stage 2 - provenance and category, per sentence
    result, near_misses = detection.detect_with_near_misses(text)

    # Stage 2b - what this person and their team already sent
    matches = context.matches_from(result, near_misses)
    signal = context.assess(user=user, team=team, destination_class=dest_class, matches=matches)
    if signal.escalations:
        combined = result.findings + signal.escalations
        result = detection.DetectionResult(
            findings=combined,
            overall_sensitivity=max(f.sensitivity for f in combined),
            types_present=sorted({f.type for f in combined}),
        )

    for f in result.findings:
        findings.append(_finding_dict(f, signal))
        # A weak finding is a guess about the topic, so it counts one tier lower.
        sensitivity = max(sensitivity, max(1, f.sensitivity - 1) if f.confidence == "weak" else f.sensitivity)

    # Stage 4 - policy. The stricter of the credential and detection decisions wins.
    decision = engine.evaluate_detection(result, destination_class=dest_class, role=role)
    if secret_decision and policy.DECISIONS.index(secret_decision.action) >= policy.DECISIONS.index(decision.action):
        decision = secret_decision
    context_note = signal.note()
    if context_note and decision is not secret_decision and decision.action != "allow":
        decision = policy.Decision(decision.action, decision.rule, f"{decision.message} {context_note}")

    rewritten, note = None, ""
    if decision.action == "sanitize":
        rw = rewrite.rewrite(text)
        rewritten, note = rw.text, rw.reason
        if not rw.available:
            decision = policy.Decision("block", decision.rule, note or decision.message)

    withheld = len(text) if decision.action == "block" else (
        max(0, len(text) - len(rewritten or "")) if decision.action == "sanitize" else 0
    )
    latency = (time.perf_counter() - started) * 1000

    inspection = Inspection(
        action=decision.action, rule=decision.rule, message=decision.message,
        sensitivity=sensitivity, risk=_risk(sensitivity, dest_class),
        latency_ms=round(latency, 1), destination_class=dest_class,
        findings=findings, rewritten=rewritten, rewrite_note=note,
        baselines=_baselines(findings),
        context=[{**e.__dict__, "coverage": round(e.coverage, 2)} for e in signal.exposures],
    )

    if log_event:
        inspection.event_id = audit.record({
            "user": user, "role": role, "destination": destination,
            "destination_class": dest_class, "action": decision.action,
            "rule": decision.rule, "sensitivity": sensitivity, "risk": inspection.risk,
            "latency_ms": inspection.latency_ms, "chars_total": len(text),
            "chars_withheld": withheld, "text_sha256": audit.sha256(text),
            "preview": audit.redact(text, secret_spans), "findings": findings,
        })
        context.record(
            event_id=inspection.event_id, user=user, team=team, destination=destination,
            destination_class=dest_class, action=decision.action, matches=matches, signal=signal,
        )
    return inspection


def _finding_dict(f: detection.Finding, signal: context.ContextSignal) -> dict[str, Any]:
    """The shape the extension and dashboard render. `kind` picks the renderer."""
    e = f.evidence
    base = {"type": f.type, "tier": f.sensitivity, "confidence": f.confidence, "span": list(f.span)}
    if f.confidence == "weak":
        return {"kind": "category", "label": f.type, "score": e.score, **base}
    if f.confidence == "cumulative":
        exposure = next(x for x in signal.exposures if x.escalated and x.doc == e.matched_source)
        return {
            "kind": "context", "label": e.matched_source, "scope": exposure.scope,
            "chunks_out": exposure.chunks_out, "chunk_total": exposure.chunk_total,
            "prompts": exposure.prompts, "coverage": round(exposure.coverage, 2), **base,
        }
    return {
        "kind": "provenance", "label": e.matched_source, "score": e.score,
        "public_score": e.public_baseline_score, "margin": e.margin,
        "verbatim": f.confidence == "verbatim", "excerpt": e.excerpt, **base,
    }


def _baselines(findings: list[dict[str, Any]]) -> dict[str, str]:
    """What a regex DLP and a generic classifier would have said. This is the demo."""
    has_secret = any(f["kind"] == "secret" for f in findings)
    cat = next((f for f in findings if f["kind"] == "category"), None)
    prov = next((f for f in findings if f["kind"] == "provenance"), None)
    ctx = next((f for f in findings if f["kind"] == "context"), None)
    return {
        "regex_dlp": "Credential or PII found" if has_secret else "No match",
        "generic_semantic": (
            f"Looks like {cat['label'].replace('_', ' ')}" if cat else "No match"
        ),
        "ndai": (
            f"{ctx['chunks_out']} of {ctx['chunk_total']} sections of {ctx['label']} sent over time" if ctx else
            f"{prov['score']:.0%} match to {prov['label']}" if prov else
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
