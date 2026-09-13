"""Person 2's deliverable: text in, DetectionResult out.

Shape is fixed by CONTRACT.md #2 - build against that, not against how the
response/policy side (Person 1) ends up consuming it. This module doesn't
touch pipeline.py or policy.py.

Two sources of findings, per sentence:

1. Provenance (detector/provenance.py) - the text matches an internal corpus
   doc closely enough to beat the best public-corpus match on the same
   sentence. Strongest evidence: type and sensitivity come straight from the
   matched doc's frontmatter, confidence is "verbatim" or "paraphrase".
2. Category (detector/categories.py) - no corpus match, but the sentence
   still reads as one of the three target types on prototype similarity
   alone. Weakest evidence: confidence "weak", no matched_source.

A sentence with a provenance hit skips the category check - provenance is
strictly stronger evidence for the same sentence, no need to double-report it.

`detect_with_near_misses()` also returns sentences that matched an internal doc
but fell short of PUBLIC_MARGIN. They are never findings and response never
sees them; detector/context.py uses them to spot a document going out in
pieces (CONTRACT.md #9).
"""
from __future__ import annotations

from dataclasses import dataclass, field

from . import categories, config, provenance


@dataclass
class Evidence:
    matched_source: str | None
    score: float | None
    public_baseline_score: float | None
    margin: float | None
    excerpt: str
    matched_chunk: int | None = None  # chunk position within matched_source, None for weak


@dataclass
class Finding:
    type: str                    # strategic_plan | financial_plan | research_report
    sensitivity: int             # 0-3, see CONTRACT.md #3
    confidence: str              # verbatim | paraphrase | weak, see CONTRACT.md #4
    span: tuple[int, int]
    evidence: Evidence


@dataclass
class NearMiss:
    """Matched an internal doc, but not by enough over the public corpus to be a finding."""
    doc: str
    chunk: int
    type: str
    sensitivity: int
    span: tuple[int, int]
    score: float
    margin: float


@dataclass
class DetectionResult:
    findings: list[Finding] = field(default_factory=list)
    overall_sensitivity: int = 0
    types_present: list[str] = field(default_factory=list)


def _from_provenance_hits(hits: list[provenance.ProvenanceHit]) -> list[Finding]:
    findings = []
    for hit in hits:
        if hit.type not in categories.TARGET_TYPES:
            # Matched an internal doc outside this feature's 3 types (e.g. an
            # architecture doc, or a doc with no frontmatter at all) - not
            # ours to report here.
            continue
        findings.append(Finding(
            type=hit.type,
            sensitivity=hit.sensitivity if hit.sensitivity is not None else categories.SENSITIVITY.get(hit.type, 2),
            confidence=hit.confidence,
            span=hit.span,
            evidence=Evidence(
                matched_source=hit.doc,
                score=round(hit.score, 3),
                public_baseline_score=round(hit.public_score, 3),
                margin=round(hit.margin, 3),
                excerpt=hit.excerpt,
                matched_chunk=hit.chunk,
            ),
        ))
    return findings


def _weak_findings(text: str, skip_spans: list[tuple[int, int]]) -> list[Finding]:
    """Category-only findings for sentences with no provenance hit."""
    clf = categories.get_classifier()
    findings = []
    for sentence, start, end in provenance.split_sentences_with_spans(text):
        if (start, end) in skip_spans:
            continue
        hit = clf.classify(sentence)
        if hit is None or hit.label not in categories.TARGET_TYPES:
            continue
        findings.append(Finding(
            type=hit.label,
            sensitivity=categories.SENSITIVITY.get(hit.label, 2),
            confidence="weak",
            span=(start, end),
            evidence=Evidence(
                matched_source=None,
                score=round(hit.score, 3),
                public_baseline_score=None,
                margin=None,
                excerpt=sentence[:180],
            ),
        ))
    return findings


def detect(text: str) -> DetectionResult:
    return detect_with_near_misses(text)[0]


def detect_with_near_misses(text: str) -> tuple[DetectionResult, list[NearMiss]]:
    all_hits = provenance.get_detector().check_all(text, margin=config.CONTEXT_MARGIN)
    prov_hits = [h for h in all_hits if h.margin >= config.PUBLIC_MARGIN]
    findings = _from_provenance_hits(prov_hits)
    covered_spans = [f.span for f in findings]
    findings.extend(_weak_findings(text, covered_spans))

    overall = max((f.sensitivity for f in findings), default=0)
    types_present = sorted({f.type for f in findings})
    result = DetectionResult(findings=findings, overall_sensitivity=overall, types_present=types_present)

    near = [
        NearMiss(
            doc=h.doc, chunk=h.chunk, type=h.type,
            sensitivity=h.sensitivity if h.sensitivity is not None else categories.SENSITIVITY.get(h.type, 2),
            span=h.span, score=round(h.score, 3), margin=round(h.margin, 3),
        )
        for h in all_hits
        if h.margin < config.PUBLIC_MARGIN and h.type in categories.TARGET_TYPES
    ]
    return result, near
