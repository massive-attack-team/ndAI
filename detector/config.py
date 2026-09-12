"""Runtime configuration. Everything defaults to local-only."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# --- Embeddings -------------------------------------------------------------
# "st"      -> sentence-transformers (real semantic matching, needs weights)
# "hashing" -> char n-gram hashing fallback, no download, DEV ONLY.
#              It catches verbatim and light edits. It does NOT catch paraphrase,
#              which is the whole product thesis. Never demo on this backend.
EMBED_BACKEND = os.getenv("NDAI_EMBED", "st")
ST_MODEL = os.getenv("NDAI_ST_MODEL", "BAAI/bge-small-en-v1.5")

# --- Corpus -----------------------------------------------------------------
INTERNAL_CORPUS = ROOT / "corpus" / "internal"
PUBLIC_CORPUS = ROOT / "corpus" / "public"   # hard negatives, indexed as "known public"
CHUNK_WORDS = 60
CHUNK_STRIDE = 30

# --- Thresholds -------------------------------------------------------------
# Tuned on eval/run_eval.py output against the real bge-small-en-v1.5 backend
# (2026-09-12, 40-sample seed set: recall 0.826, fpr 0.0). Re-tune once
# eval/dataset.py grows past 40 samples - these are not stable numbers yet.
#
# BGE cosine similarities run hot: even unrelated sentences sit around
# 0.5-0.65 against any corpus, so PUBLIC_MARGIN carries most of the
# discriminating power here, not PROVENANCE_HIT on its own.
PROVENANCE_HIT = 0.62        # cosine above this = derived from internal corpus
PROVENANCE_STRONG = 0.78     # above this = near-verbatim
PUBLIC_MARGIN = 0.105        # internal score must beat best public score by this

CATEGORY_HIT = 0.71

# --- Rewrite ----------------------------------------------------------------
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5:3b-instruct")
REWRITE_TIMEOUT_S = 20

# --- Service ----------------------------------------------------------------
HOST = "127.0.0.1"           # never 0.0.0.0. The detector does not accept remote traffic.
PORT = int(os.getenv("NDAI_PORT", "8000"))
DB_PATH = ROOT / "ndai.db"
POLICY_PATH = ROOT / "policy.yaml"
