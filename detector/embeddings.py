"""Local embedding backends. No network calls at inference time."""
from __future__ import annotations

import logging
import threading
from typing import List

import numpy as np

from . import config

log = logging.getLogger("ndai.embeddings")


class Embedder:
    """Encodes text to L2-normalised vectors so cosine == dot product."""

    def __init__(self, backend: str = config.EMBED_BACKEND):
        self.backend = backend
        self._lock = threading.Lock()
        self._model = None
        self._hasher = None
        if backend == "st":
            self._load_st()
        else:
            self._load_hashing()

    # -- backends ------------------------------------------------------------
    def _load_st(self) -> None:
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError:
            log.warning("sentence-transformers not installed; falling back to hashing")
            self.backend = "hashing"
            return self._load_hashing()
        try:
            self._model = SentenceTransformer(config.ST_MODEL, device="cpu")
        except Exception as exc:  # offline, no weights cached, etc.
            log.warning("could not load %s (%s); falling back to hashing", config.ST_MODEL, exc)
            self.backend = "hashing"
            return self._load_hashing()
        log.info("embeddings: sentence-transformers %s", config.ST_MODEL)

    def _load_hashing(self) -> None:
        from sklearn.feature_extraction.text import HashingVectorizer

        self._hasher = HashingVectorizer(
            analyzer="char_wb", ngram_range=(3, 5), n_features=2**18, norm="l2",
            alternate_sign=False,
        )
        log.warning("embeddings: hashing fallback active - paraphrase detection is OFF")

    # -- api -----------------------------------------------------------------
    @property
    def is_semantic(self) -> bool:
        return self.backend == "st"

    def encode(self, texts: List[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, 1), dtype=np.float32)
        with self._lock:
            if self.backend == "st":
                vecs = self._model.encode(
                    texts, batch_size=32, convert_to_numpy=True, normalize_embeddings=True,
                    show_progress_bar=False,
                )
                return vecs.astype(np.float32)
            return np.asarray(self._hasher.transform(texts).todense(), dtype=np.float32)


_embedder: Embedder | None = None


def get_embedder() -> Embedder:
    global _embedder
    if _embedder is None:
        _embedder = Embedder()
    return _embedder
