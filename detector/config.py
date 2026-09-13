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
# (2026-09-13, 56-sample set after adding strategic_plan/financial_plan/
# research_report corpus+samples: recall 0.735, fpr_hard_negatives 0.059 -
# 1 of 17 public-domain hard negatives still flagged, via the standalone
# category classifier, not provenance). Still not stable - re-tune once
# eval/dataset.py grows past 200, per README.
#
# BGE cosine similarities run hot: even unrelated sentences sit around
# 0.5-0.65 against any corpus, so PUBLIC_MARGIN carries most of the
# discriminating power here, not PROVENANCE_HIT on its own. This also means a
# high absolute score alone (even near PROVENANCE_STRONG) doesn't reliably
# mean "ours" on a short, topically generic sentence - don't let anything
# bypass PUBLIC_MARGIN on absolute score alone (see the comment in
# provenance.py's check_all - this was tried and reverted).
PROVENANCE_HIT = 0.62        # cosine above this = derived from internal corpus
PROVENANCE_STRONG = 0.78     # above this = near-verbatim
PUBLIC_MARGIN = 0.105        # internal score must beat best public score by this

CATEGORY_HIT = 0.71

# --- Calibration --------------------------------------------------------
# Per-type nudge on PUBLIC_MARGIN, calibrated from this install's own audit
# history (detector/calibration.py) - "team" = every event this local
# install has ever logged, across every user. Below CALIBRATION_MIN_SAMPLES
# findings for a type, calibration is a no-op and PUBLIC_MARGIN is used
# unchanged - a fresh install behaves exactly like today.
CALIBRATION_MIN_SAMPLES = 15
CALIBRATION_MAX_ADJUST = 0.15          # margin moves at most +/-15% from PUBLIC_MARGIN
CALIBRATION_TARGET_CONFIDENCE = 0.7    # "healthy" share of verbatim/paraphrase vs weak
CALIBRATION_TARGET_SENSITIVE = 0.5     # "healthy" share of findings at tier >= 2

# --- Context graph ----------------------------------------------------------
# detector/context.py remembers which parts of which internal docs each person
# and team has already sent out, so a document leaked a piece at a time gets
# caught on the piece that completes the picture. CONTRACT.md #9.
#
# A near miss clears PROVENANCE_HIT and beats the public corpus by at least
# CONTEXT_MARGIN, but not by PUBLIC_MARGIN. On its own it is not a finding;
# it only counts when it lands on a document the same person or team has
# already been sending out.
CONTEXT_MARGIN = 0.04
CONTEXT_WINDOW_DAYS = 14         # older sends stop counting towards exposure
# A "cumulative" finding needs all three: distinct chunks of one doc sent to
# the same destination class, distinct prompts they came from, and the share
# of the doc's chunks that adds up to. Tuned to the synthetic corpus, where a
# doc is 3-6 chunks. A real corpus with long documents needs a lower
# coverage and a higher chunk count.
CUMULATIVE_MIN_CHUNKS = 2
CUMULATIVE_MIN_PROMPTS = 2
CUMULATIVE_COVERAGE = 0.3

# --- Rewrite ----------------------------------------------------------------
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5:3b-instruct")
REWRITE_TIMEOUT_S = 20

# --- Service ----------------------------------------------------------------
HOST = "127.0.0.1"           # never 0.0.0.0. The detector does not accept remote traffic.
PORT = int(os.getenv("NDAI_PORT", "8000"))
DB_PATH = ROOT / "ndai.db"
POLICY_PATH = ROOT / "policy.yaml"
