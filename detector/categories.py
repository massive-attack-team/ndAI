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

PROTOTYPES: dict[str, list[str]] = {
    "system_architecture": [
        "internal service topology, database schema design and API endpoint layout",
        "how our backend services authenticate and talk to each other in production",
        "infrastructure configuration, deployment topology and internal hostnames",
    ],
    "financial_strategy": [
        "unannounced quarterly revenue forecast and earnings projection",
        "merger and acquisition target, deal valuation and transaction timeline",
        "internal pricing model, margin structure and discount authority",
    ],
    "rnd_result": [
        "unpublished experimental result, assay outcome and dose response finding",
        "efficacy and toxicity data from an ongoing preclinical study",
        "proof technique, derivation or model architecture from unpublished research",
    ],
    "legal_position": [
        "draft contract terms, settlement position and litigation risk assessment",
        "patent application content prior to filing",
        "internal legal advice about our exposure in a dispute",
    ],
    "product_roadmap": [
        "unreleased product roadmap, launch date and feature commitments",
        "internal prioritisation of upcoming releases not yet announced",
    ],
    "internal_prompt_logic": [
        "internal scoring rubric or decision rules used by an automated system",
        "system prompt and guardrail instructions for an internal assistant",
    ],
}

SENSITIVITY = {
    "system_architecture": 2,
    "financial_strategy": 3,
    "rnd_result": 3,
    "legal_position": 3,
    "product_roadmap": 2,
    "internal_prompt_logic": 2,
}


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
