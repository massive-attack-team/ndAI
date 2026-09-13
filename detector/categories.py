"""Stage 3: what kind of sensitive content is this, regardless of provenance?

Prototype embeddings, not a trained classifier. No labels, no training run, and
it degrades honestly: an unrecognised topic scores low rather than guessing.
Provenance answers "is it ours". This answers "what is it".
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List

import numpy as np

from . import config
from .embeddings import get_embedder

# Labels for strategic_plan, financial_plan and research_report match the
# type taxonomy in CONTRACT.md - this classifier is the "weak" confidence
# signal (type-only, no corpus match) described there. system_architecture,
# legal_position and internal_prompt_logic are out of scope for that contract
# but stay here since they're separate, already-working category findings.
PROTOTYPES: dict[str, list[str]] = {
    "system_architecture": [
        "internal service topology, database schema design and API endpoint layout",
        "how our backend services authenticate and talk to each other in production",
        "infrastructure configuration, deployment topology and internal hostnames",
    ],
    "strategic_plan": [
        "unannounced market entry, competitive response or go-to-market plan",
        "unreleased product roadmap, launch date and feature commitments",
        "internal prioritisation of upcoming releases not yet announced",
        "merger or acquisition rationale and target selection, before announcement",
        "internal org design or restructuring not yet communicated to staff",
    ],
    "financial_plan": [
        "unannounced quarterly revenue forecast and earnings projection",
        "merger and acquisition deal valuation, pricing and transaction timeline",
        "internal pricing model, margin structure and discount authority",
        "fundraising terms, valuation and investor allocation ahead of a close",
        "internal budget allocation across teams or cost centres",
    ],
    "research_report": [
        "unpublished experimental result, assay outcome and dose response finding",
        "efficacy and toxicity data from an ongoing preclinical study",
        "proof technique, derivation or model architecture from unpublished research",
        "interim or in-progress study data not yet through final analysis",
    ],
    "legal_position": [
        "draft contract terms, settlement position and litigation risk assessment",
        "patent application content prior to filing",
        "internal legal advice about our exposure in a dispute",
    ],
    "internal_prompt_logic": [
        "internal scoring rubric or decision rules used by an automated system",
        "system prompt and guardrail instructions for an internal assistant",
    ],
}

SENSITIVITY = {
    "system_architecture": 2,
    "strategic_plan": 2,
    "financial_plan": 3,
    "research_report": 3,
    "legal_position": 3,
    "internal_prompt_logic": 2,
}

# The three types this feature (CONTRACT.md) targets - used to filter
# category hits down to in-scope findings.
TARGET_TYPES = ("strategic_plan", "financial_plan", "research_report")


@dataclass
class CategoryHit:
    label: str
    score: float


class CategoryClassifier:
    def __init__(self):
        self.labels: List[str] = []
        self.matrix: np.ndarray | None = None

    def build(self) -> None:
        texts, labels = [], []
        for label, examples in PROTOTYPES.items():
            for ex in examples:
                texts.append(ex)
                labels.append(label)
        self.labels = labels
        self.matrix = get_embedder().encode(texts)

    def classify(self, text: str) -> CategoryHit | None:
        if self.matrix is None:
            self.build()
        vec = get_embedder().encode([text])
        sims = (vec @ self.matrix.T)[0]
        best = int(sims.argmax())
        if float(sims[best]) < config.CATEGORY_HIT:
            return None
        return CategoryHit(self.labels[best], float(sims[best]))


_clf: CategoryClassifier | None = None


def get_classifier() -> CategoryClassifier:
    global _clf
    if _clf is None:
        _clf = CategoryClassifier()
        _clf.build()
    return _clf
