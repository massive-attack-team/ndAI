"""Orchestration: secrets -> provenance -> category -> policy -> rewrite."""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from . import audit, categories, policy, provenance, rewrite, secrets_scan
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
    sensitivity = 0
    critical = False
    secret_spans: list[tuple[int, int]] = []

    # Stage 1 - credentials and PII
    for f in secrets_scan.scan(text):
        secret_spans.append(f.span)
        critical = critical or f.critical
        findings.append({
            "kind": "secret", "label": f.label, "preview": f.preview,
            "critical": f.critical, "span": list(f.span),
        })
        sensitivity = max(sensitivity, 3 if f.critical else 2)

    # Stage 2 - company-specific provenance
    hit = provenance.get_detector().check(text)
    if hit:
        findings.append({
            "kind": "provenance", "label": hit.doc, "score": round(hit.score, 3),
            "public_score": round(hit.public_score, 3), "margin": round(hit.margin, 3),
            "verbatim": hit.verbatim, "excerpt": hit.excerpt,
        })
        sensitivity = max(sensitivity, 3 if hit.verbatim else 2)

    # Stage 3 - category, weaker evidence on its own
    cat = categories.get_classifier().classify(text)
    if cat:
        base = categories.SENSITIVITY.get(cat.label, 2)
        findings.append({"kind": "category", "label": cat.label, "score": round(cat.score, 3)})
        sensitivity = max(sensitivity, base if hit else max(1, base - 1))

    decision = engine.evaluate(
        sensitivity=sensitivity, destination_class=dest_class,
        role=role, has_critical_secret=critical,
    )

    rewritten, note = None, ""
    if decision.action == "sanitize":
        result = rewrite.rewrite(text)
        rewritten, note = result.text, result.reason
        if not result.available:
            decision = policy.Decision("block", decision.rule, note or decision.message)

    withheld = len(text) if decision.action == "block" else (
        max(0, len(text) - len(rewritten or "")) if decision.action == "sanitize" else 0
    )
    latency = (time.perf_counter() - started) * 1000

    result = Inspection(
        action=decision.action, rule=decision.rule, message=decision.message,
        sensitivity=sensitivity, risk=_risk(sensitivity, dest_class),
        latency_ms=round(latency, 1), destination_class=dest_class,
        findings=findings, rewritten=rewritten, rewrite_note=note,
        baselines=_baselines(findings),
    )

    if log_event:
        result.event_id = audit.record({
            "user": user, "role": role, "destination": destination,
            "destination_class": dest_class, "action": decision.action,
            "rule": decision.rule, "sensitivity": sensitivity, "risk": result.risk,
            "latency_ms": result.latency_ms, "chars_total": len(text),
            "chars_withheld": withheld, "text_sha256": audit.sha256(text),
            "preview": audit.redact(text, secret_spans), "findings": findings,
        })
    return result


def _baselines(findings: list[dict[str, Any]]) -> dict[str, str]:
    """What a regex DLP and a generic classifier would have said. This is the demo."""
    has_secret = any(f["kind"] == "secret" for f in findings)
    cat = next((f for f in findings if f["kind"] == "category"), None)
    prov = next((f for f in findings if f["kind"] == "provenance"), None)
    return {
        "regex_dlp": "Credential or PII found" if has_secret else "No match",
        "generic_semantic": (
            f"Looks like {cat['label'].replace('_', ' ')}" if cat else "No match"
        ),
        "ndai": (
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
