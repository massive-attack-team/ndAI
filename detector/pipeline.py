"""Orchestration: secrets -> detection -> context -> policy -> rewrite.

Detection (type + sensitivity + confidence per CONTRACT.md #2) and policy
(what happens given that judgment, CONTRACT.md #5) were built and tuned
independently - detector/detection.py and detector/policy.py respectively.
The context stage (CONTRACT.md #9) sits between them: it adds `cumulative`
findings to the DetectionResult before policy sees it, and records what was
sent after policy decides. This module is the integration point where all
three, plus the secrets scan, get wired together.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from . import audit, categories, context, detection, ingest, policy, provenance, rewrite, secrets_scan
from .embeddings import get_embedder
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
    context: list[dict[str, Any]] = field(default_factory=list)
    event_id: int | None = None


@dataclass
class FileInspection:
    filename: str
    action: str
    sensitivity: int
    latency_ms: float
    chunks: list[dict[str, Any]] = field(default_factory=list)


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
    critical = False
    secret_spans: list[tuple[int, int]] = []

    # Stage 1 - credentials and PII, outside DetectionResult (CONTRACT.md #1):
    # pattern/entropy based, not corpus based.
    for f in secrets_scan.scan(text):
        secret_spans.append(f.span)
        critical = critical or f.critical
        findings.append({
            "kind": "secret", "label": f.label, "preview": f.preview,
            "critical": f.critical, "span": list(f.span),
        })
    secret_sensitivity = 3 if critical else (2 if secret_spans else 0)
    secret_decision = engine.evaluate(
        sensitivity=secret_sensitivity, destination_class=dest_class,
        role=role, has_critical_secret=critical,
    ) if findings else None

    # Stage 2 - detection: provenance and category, per sentence
    # (detector/detection.py, CONTRACT.md #2).
    result, near_misses = detection.detect_with_near_misses(text)

    # Stage 2b - context: what this person and their team already sent
    # (detector/context.py, CONTRACT.md #9).
    matches = context.matches_from(result, near_misses)
    signal = context.assess(user=user, team=team, destination_class=dest_class, matches=matches)
    if signal.escalations:
        combined = result.findings + signal.escalations
        result = detection.DetectionResult(
            findings=combined,
            overall_sensitivity=max(f.sensitivity for f in combined),
            types_present=sorted({f.type for f in combined}),
        )

    shown_context: set[str] = set()
    for f in result.findings:
        if f.confidence == "cumulative":
            # One cumulative Finding per contributing sentence, so the
            # sanitiser edits all of them; the user sees one line per document.
            if f.evidence.matched_source in shown_context:
                continue
            shown_context.add(f.evidence.matched_source)
        findings.append(_finding_dict(f, signal))

    # A weak finding is a guess about the topic, so it counts one tier lower
    # for the headline sensitivity/risk score - the policy decision itself
    # still uses the finding's real tier via the "weak signal" rule.
    detection_sensitivity = max(
        (max(1, f.sensitivity - 1) if f.confidence == "weak" else f.sensitivity for f in result.findings),
        default=0,
    )
    sensitivity = max(secret_sensitivity, detection_sensitivity)

    # Stage 4 - policy: what happens to it (detector/policy.py, CONTRACT.md
    # #5). Secrets and typed findings are evaluated separately, then the more
    # severe wins - a live credential should block even if nothing else in
    # the prompt does.
    decision = engine.evaluate_detection(result, destination_class=dest_class, role=role)
    if secret_decision and policy.DECISIONS.index(secret_decision.action) >= policy.DECISIONS.index(decision.action):
        decision = secret_decision
    context_note = signal.note()
    if context_note and decision is not secret_decision and decision.action != "allow":
        decision = policy.Decision(decision.action, decision.rule, f"{decision.message} {context_note}")

    rewritten, note = None, ""
    sanitiser_meta: dict[str, Any] = {}
    edited_spans: list[tuple[int, int]] = []
    if decision.action == "sanitize":
        # Feature 2 (sanitiser/): per-span edits, verified by re-running
        # detect() on the candidate and escalating strategy up to 2 passes,
        # failing closed to block if it still leaks. Pass the DetectionResult
        # we already computed above (`result`, post context-stage escalation
        # merge) so the prompt isn't re-embedded twice.
        san = run_sanitiser(text, result)
        # Full shape (san.to_json()), not a hand-picked subset: the document
        # review UI needs each edit's replacement text and original span.text
        # to build a real before/after diff, not just the metadata - and this
        # shape already matches what /sanitise/reapply expects verbatim, so
        # the frontend can round-trip an edit list back with no translation.
        sanitiser_meta = san.to_json()
        edited_spans = [(e.span.start, e.span.end) for e in san.edits if e.accepted]
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
            "passes": sanitiser_meta.get("passes"),
            "residual_findings": sanitiser_meta.get("residual_findings"),
            "leak_reduction": sanitiser_meta.get("leak_reduction"),
            "intent_retention": sanitiser_meta.get("intent_retention"),
        })
        context.record(
            event_id=inspection.event_id, user=user, team=team, destination=destination,
            destination_class=dest_class, action=decision.action, matches=matches, signal=signal,
            edited_spans=edited_spans,
        )
    return inspection


def _finding_dict(f: detection.Finding, signal: context.ContextSignal) -> dict[str, Any]:
    """The shape the extension renders. `kind` picks the renderer."""
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


def inspect_file(filename: str, data: bytes, *, destination: str, user: str = "unknown",
                  role: str = "default") -> FileInspection:
    """Same judgment as inspect(), applied per row/page of a document instead
    of one pasted prompt. Runs the existing, unmodified inspect() once per
    chunk (see detector/ingest.py) - secrets scan, detection, calibrated
    thresholds, the context stage and the sanitiser all apply exactly as
    they do for text input, with zero duplicated logic. Each chunk is
    logged (log_event=True), so a file scan feeds the same audit and context
    history detector/calibration.py and detector/context.py read from - a
    document leaked one row per file, over several uploads, is exactly the
    piecemeal-leak case the context stage already catches.
    """
    started = time.perf_counter()
    chunks = ingest.extract(filename, data)

    rows: list[dict[str, Any]] = []
    worst: Inspection | None = None
    for chunk in chunks:
        insp = inspect(chunk.text, destination=destination, user=user, role=role, log_event=True)
        rows.append({
            "label": chunk.label, "action": insp.action, "rule": insp.rule,
            "sensitivity": insp.sensitivity, "message": insp.message,
        })
        if worst is None or policy.DECISIONS.index(insp.action) > policy.DECISIONS.index(worst.action):
            worst = insp

    latency = (time.perf_counter() - started) * 1000
    return FileInspection(
        filename=filename,
        action=worst.action if worst else "allow",
        sensitivity=worst.sensitivity if worst else 0,
        latency_ms=round(latency, 1),
        chunks=rows,
    )


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
    prov = next((f for f in findings if f["kind"] == "provenance"), None)
    ctx = next((f for f in findings if f["kind"] == "context"), None)
    return {
        "regex_dlp": "Credential or PII found" if has_secret else "No match",
        "generic_semantic": (
            f"Looks like {cat.label.replace('_', ' ')}" if cat else "No match"
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
