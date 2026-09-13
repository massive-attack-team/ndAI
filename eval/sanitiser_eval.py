"""Sanitiser evaluation - Feature 2's numbers, run against the same 56
labelled prompts eval/dataset.py already uses for detection (Feature 1).

Four numbers matter:

  leak_clearance     % of prompts routed to sanitise that clear re-detection
                      within MAX_PASSES. The headline number.
  block_escalation   % that could not be cleared and failed closed to block.
                      High is not a failure - it is the system being honest.
  intent_retention   mean. Below ~0.75 means the rewriter is just redacting,
                      not sanitising - the whole differentiator is gone.
  latency p50/p95     local model on real hardware. Judges will ask.

Only prompts the top-level decision actually routes to sanitise reach this
loop at all - anything Feature 1 misses, this never sees. Report Feature 1's
recall/FPR (eval/run_eval.py) alongside this, never in place of it.

Run:  python -m eval.sanitiser_eval            (from the repo root)

Requires Ollama running for the "generalise" strategy (tiers 1-2). If it's
not running, llm.generalise returns None and strategies.generalise falls
back to redact() automatically - no crash, just blunter edits.
"""
from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from eval.dataset import SAMPLES          # noqa: E402
from sanitiser.service import sanitise    # noqa: E402


def run() -> dict:
    cleared, blocked, retentions, latencies, rows = 0, 0, [], [], []
    considered = 0

    for s in SAMPLES:
        r = sanitise(s.text)
        latencies.append(r.latency_ms)

        if r.action == "allow":
            continue
        considered += 1
        if r.action == "sanitise" and r.residual_findings == 0:
            cleared += 1
            retentions.append(r.intent_retention)
        elif r.action == "block":
            blocked += 1

        rows.append({
            "klass": s.klass, "leak": s.leak,
            "action": r.action, "passes": r.passes,
            "residual": r.residual_findings,
            "leak_reduction": round(r.leak_reduction, 3),
            "intent_retention": round(r.intent_retention, 3),
            "latency_ms": r.latency_ms,
            "original": s.text[:90],
            "sanitised": r.sanitised_text[:90],
        })

    lat = sorted(latencies)
    out = {
        "n_samples": len(SAMPLES),
        "n_flagged": considered,
        "leak_clearance": round(cleared / considered, 3) if considered else 0.0,
        "block_escalation": round(blocked / considered, 3) if considered else 0.0,
        "intent_retention_mean": round(statistics.mean(retentions), 3) if retentions else 0.0,
        "intent_retention_min": round(min(retentions), 3) if retentions else 0.0,
        "latency_p50_ms": lat[len(lat) // 2] if lat else 0,
        "latency_p95_ms": lat[int(len(lat) * 0.95) - 1] if lat else 0,
    }
    print(json.dumps(out, indent=2))
    out_path = Path(__file__).resolve().parent / "sanitiser_results.json"
    with open(out_path, "w") as f:
        json.dump({"summary": out, "rows": rows}, f, indent=2)
    print(f"\nper-prompt results -> {out_path}")
    return out


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
