"""Compare three systems on the same labelled prompts.

    1. regex_dlp          - credentials and PII only, the industry baseline
    2. generic_semantic   - category classifier with no company knowledge
    3. ndai        - full pipeline including company provenance

Run:  python -m eval.run_eval            (from the repo root)

Report recall by class, not just overall. Overall recall hides the only number
that matters: paraphrase recall against a low false positive rate on
public_domain prompts.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from detector import categories, provenance, secrets_scan  # noqa: E402
from detector.embeddings import get_embedder  # noqa: E402
from eval.dataset import SAMPLES, counts  # noqa: E402

DESTINATION = "chatgpt.com"


def sys_regex(text: str) -> bool:
    return bool(secrets_scan.scan(text))


def sys_generic(text: str) -> bool:
    return categories.get_classifier().classify(text) is not None


def sys_ndai(text: str) -> bool:
    if secrets_scan.scan(text):
        return True
    if provenance.get_detector().check(text) is not None:
        return True
    cat = categories.get_classifier().classify(text)
    return cat is not None and categories.SENSITIVITY.get(cat.label, 0) >= 3


SYSTEMS = {
    "regex_dlp": sys_regex,
    "generic_semantic": sys_generic,
    "ndai": sys_ndai,
}


def main() -> None:
    emb = get_embedder()
    print(f"embedding backend: {emb.backend}")
    if not emb.is_semantic:
        print("!! hashing fallback active. Paraphrase numbers below are meaningless.\n")
    print(f"dataset: {len(SAMPLES)} prompts {counts()}\n")

    rows = []
    for name, fn in SYSTEMS.items():
        for i, s in enumerate(SAMPLES):
            t0 = time.perf_counter()
            flagged = fn(s.text)
            rows.append({
                "sample": i, "system": name, "klass": s.klass, "leak": s.leak,
                "flagged": flagged, "latency_ms": (time.perf_counter() - t0) * 1000,
            })
    df = pd.DataFrame(rows)

    summary = []
    for name in SYSTEMS:
        d = df[df.system == name]
        tp = int(((d.leak) & (d.flagged)).sum())
        fn_ = int(((d.leak) & (~d.flagged)).sum())
        fp = int(((~d.leak) & (d.flagged)).sum())
        tn = int(((~d.leak) & (~d.flagged)).sum())
        recall = tp / (tp + fn_) if tp + fn_ else 0.0
        precision = tp / (tp + fp) if tp + fp else 0.0
        fpr = fp / (fp + tn) if fp + tn else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        hard = d[d.klass == "public_domain"]
        summary.append({
            "system": name, "recall": round(recall, 3), "precision": round(precision, 3),
            "f1": round(f1, 3), "fpr": round(fpr, 3),
            "fpr_hard_negatives": round(hard.flagged.mean(), 3) if len(hard) else None,
            "p50_ms": round(d.latency_ms.median(), 1),
            "p95_ms": round(d.latency_ms.quantile(0.95), 1),
        })

    print("Overall\n" + pd.DataFrame(summary).to_string(index=False))

    print("\nRecall by class (leak classes only)")
    leaks = df[df.leak]
    print(leaks.pivot_table(index="klass", columns="system", values="flagged",
                            aggfunc="mean").round(3).to_string())

    print("\nFalse positive rate by class (non-leak classes only)")
    clean = df[~df.leak]
    print(clean.pivot_table(index="klass", columns="system", values="flagged",
                            aggfunc="mean").round(3).to_string())

    out = Path(__file__).resolve().parent / "results.csv"
    df.to_csv(out, index=False)
    print(f"\nper-prompt results -> {out}")

    misses = df[(df.system == "ndai") & (df.leak) & (~df.flagged)]
    if len(misses):
        print(f"\nNDAi missed {len(misses)}:")
        for i in misses["sample"]:
            print("  -", SAMPLES[i].text[:90])


if __name__ == "__main__":
    main()
