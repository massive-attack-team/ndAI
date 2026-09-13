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
import yaml

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


def split_sentences_with_spans(text: str) -> list[tuple[str, int, int]]:
    """Sentences plus their character offsets into `text`, for per-finding spans."""
    spans = []
    cursor = 0
    for sentence in split_sentences(text):
        idx = text.find(sentence, cursor)
        if idx == -1:
            idx = cursor
        spans.append((sentence, idx, idx + len(sentence)))
        cursor = idx + len(sentence)
    return spans


def parse_frontmatter(raw: str) -> tuple[dict, str]:
    """Strip a leading `---\\n key: value \\n---` block and return (meta, body).

    Corpus docs use this to declare their `type` and `tier` so the type
    taxonomy and sensitivity rubric (see CONTRACT.md) live with the document,
    not hardcoded in the detector. Docs without frontmatter (e.g. the public
    corpus) just return an empty meta dict.
    """
    if not raw.startswith("---\n"):
        return {}, raw
    end = raw.find("\n---", 4)
    if end == -1:
        return {}, raw
    try:
        meta = yaml.safe_load(raw[4:end]) or {}
    except yaml.YAMLError:
        meta = {}
    body = raw[end + 4:].lstrip("\n")
    return meta if isinstance(meta, dict) else {}, body


@dataclass
class Chunk:
    doc: str
    idx: int
    text: str
    chunk_type: str | None = None   # strategic_plan | financial_plan | research_report, from frontmatter
    tier: int | None = None         # 0-3 sensitivity, from frontmatter


@dataclass
class ProvenanceHit:
    score: float
    doc: str
    excerpt: str
    public_score: float
    margin: float
    verbatim: bool
    type: str | None = None
    sensitivity: int | None = None
    confidence: str = "paraphrase"   # "verbatim" | "paraphrase", see CONTRACT.md #4
    span: tuple[int, int] = (0, 0)


class Index:
    def __init__(self, name: str):
        self.name = name
        self.chunks: List[Chunk] = []
        self.matrix: np.ndarray | None = None

    def build(self, folder: Path) -> None:
        self.chunks = []
        for path in sorted(_walk(folder)):
            raw = path.read_text(encoding="utf-8", errors="ignore")
            meta, text = parse_frontmatter(raw)
            rel = str(path.relative_to(folder))
            chunk_type = meta.get("type")
            tier = meta.get("tier")
            for i, piece in enumerate(chunk_words(text)):
                self.chunks.append(Chunk(rel, i, piece, chunk_type=chunk_type, tier=tier))
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

    def check_all(self, text: str) -> list[ProvenanceHit]:
        """Score every sentence independently and return every eligible hit.

        Sentence granularity matters: a 500-word prompt with two leaked lines
        averages down to nothing if you embed the whole thing at once. Unlike
        `check()`, this keeps every sentence that clears threshold, not just
        the worst one - a prompt can carry more than one finding (see
        CONTRACT.md #2).
        """
        spans = split_sentences_with_spans(text)
        sentences = [s for s, _, _ in spans]
        vecs = get_embedder().encode(sentences)
        int_scores, int_pos = self.internal.best(vecs)
        pub_scores, _ = self.public.best(vecs)

        margins = int_scores - pub_scores
        # Tried letting a high absolute score (>= PROVENANCE_STRONG) bypass the
        # margin check on the theory that near-identical wording doesn't need
        # public's permission - reverted. On short, topically generic
        # sentences BGE cosine runs hot enough that questions like "what's the
        # standard blood draw schedule for liver enzymes" also clear 0.78
        # against internal docs, and sometimes clear it even higher against
        # public ones (negative margin) - an absolute bypass let those through
        # as false positives. The margin is what's actually discriminating
        # here, verbatim or not; keep it required for every hit.
        eligible = (int_scores >= config.PROVENANCE_HIT) & (margins >= config.PUBLIC_MARGIN)

        hits = []
        for i, ok in enumerate(eligible):
            if not ok:
                continue
            chunk = self.internal.chunks[int(int_pos[i])]
            _, start, end = spans[i]
            verbatim = float(int_scores[i]) >= config.PROVENANCE_STRONG
            hits.append(ProvenanceHit(
                score=float(int_scores[i]),
                doc=chunk.doc,
                excerpt=chunk.text[:180],
                public_score=float(pub_scores[i]),
                margin=float(margins[i]),
                verbatim=verbatim,
                type=chunk.chunk_type,
                sensitivity=chunk.tier,
                confidence="verbatim" if verbatim else "paraphrase",
                span=(start, end),
            ))
        return hits

    def check(self, text: str) -> ProvenanceHit | None:
        """Single worst-offender hit, for callers that only want one verdict."""
        hits = self.check_all(text)
        return max(hits, key=lambda h: h.score) if hits else None


_detector: ProvenanceDetector | None = None


def get_detector() -> ProvenanceDetector:
    global _detector
    if _detector is None:
        _detector = ProvenanceDetector()
        _detector.build()
    return _detector
