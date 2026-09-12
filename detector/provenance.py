"""Stage 2: does this text derive from our internal corpus?

This is the only part of NDAi that is genuinely novel, so it is the part
the eval harness measures. Everything else is plumbing around it.

Two indexes are built: internal documents and known-public documents from the
same domain. A prompt only counts as leakage if it matches internal content AND
beats the best public match by a margin. Without the public index, "our compound
reduced tumour growth" scores high against any oncology corpus and the detector
flags every researcher who talks about their field.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List

import numpy as np

from . import config
from .embeddings import get_embedder

log = logging.getLogger("ndai.provenance")

SUFFIXES = {".md", ".txt", ".py", ".java", ".js", ".ts", ".sql", ".yaml", ".yml", ".json"}


def chunk_words(text: str, size: int = config.CHUNK_WORDS, stride: int = config.CHUNK_STRIDE):
    words = text.split()
    if not words:
        return
    for start in range(0, max(len(words) - size + stride, 1), stride):
        piece = words[start:start + size]
        if len(piece) < 12 and start > 0:
            break
        yield " ".join(piece)


def split_sentences(text: str) -> List[str]:
    parts = re.split(r"(?<=[.!?;])\s+|\n{2,}", text.strip())
    return [p.strip() for p in parts if len(p.strip()) > 25] or [text.strip()]


@dataclass
class Chunk:
    doc: str
    idx: int
    text: str


@dataclass
class ProvenanceHit:
    score: float
    doc: str
    excerpt: str
    public_score: float
    margin: float
    verbatim: bool


class Index:
    def __init__(self, name: str):
        self.name = name
        self.chunks: List[Chunk] = []
        self.matrix: np.ndarray | None = None

    def build(self, folder: Path) -> None:
        self.chunks = []
        for path in sorted(_walk(folder)):
            text = path.read_text(encoding="utf-8", errors="ignore")
            rel = str(path.relative_to(folder))
            for i, piece in enumerate(chunk_words(text)):
                self.chunks.append(Chunk(rel, i, piece))
        if not self.chunks:
            self.matrix = None
            log.warning("%s index is empty (%s)", self.name, folder)
            return
        self.matrix = get_embedder().encode([c.text for c in self.chunks])
        log.info("%s index: %d chunks from %s", self.name, len(self.chunks), folder)

    def best(self, query_vecs: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Per-query best score and chunk position."""
        if self.matrix is None or query_vecs.size == 0:
            n = query_vecs.shape[0] if query_vecs.size else 0
            return np.zeros(n, dtype=np.float32), np.zeros(n, dtype=np.int64)
        sims = query_vecs @ self.matrix.T
        return sims.max(axis=1), sims.argmax(axis=1)


def _walk(folder: Path) -> Iterable[Path]:
    if not folder.exists():
        return []
    return (p for p in folder.rglob("*") if p.is_file() and p.suffix.lower() in SUFFIXES)


class ProvenanceDetector:
    def __init__(self):
        self.internal = Index("internal")
        self.public = Index("public")

    def build(self) -> None:
        self.internal.build(config.INTERNAL_CORPUS)
        self.public.build(config.PUBLIC_CORPUS)

    def check(self, text: str) -> ProvenanceHit | None:
        """Score the prompt sentence by sentence and keep the worst offender.

        Sentence granularity matters: a 500-word prompt with two leaked lines
        averages down to nothing if you embed the whole thing at once.
        """
        sentences = split_sentences(text)
        vecs = get_embedder().encode(sentences)
        int_scores, int_pos = self.internal.best(vecs)
        pub_scores, _ = self.public.best(vecs)

        margins = int_scores - pub_scores
        eligible = (int_scores >= config.PROVENANCE_HIT) & (margins >= config.PUBLIC_MARGIN)
        if not eligible.any():
            return None

        masked = np.where(eligible, int_scores, -1.0)
        i = int(masked.argmax())
        chunk = self.internal.chunks[int(int_pos[i])]
        return ProvenanceHit(
            score=float(int_scores[i]),
            doc=chunk.doc,
            excerpt=chunk.text[:180],
            public_score=float(pub_scores[i]),
            margin=float(margins[i]),
            verbatim=float(int_scores[i]) >= config.PROVENANCE_STRONG,
        )


_detector: ProvenanceDetector | None = None


def get_detector() -> ProvenanceDetector:
    global _detector
    if _detector is None:
        _detector = ProvenanceDetector()
        _detector.build()
    return _detector
