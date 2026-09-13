"""Calibration validation harness - sanity-checks detector/calibration.py's
threshold adjustment against synthetic history, without touching the real
audit log. Mirrors eval/response_fixtures.py's hand-written-fixture pattern.

Run:  python -m eval.calibration_fixtures            (from the repo root)
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from detector import audit, calibration, config  # noqa: E402

TYPE = "research_report"


def _finding(sensitivity: int, confidence: str) -> dict:
    return {"kind": "detection", "type": TYPE, "sensitivity": sensitivity, "confidence": confidence}


CASES = [
    ("below CALIBRATION_MIN_SAMPLES -> margin unchanged",
     [_finding(3, "verbatim")] * 3,
     lambda m: m == config.PUBLIC_MARGIN),

    ("mostly weak, low sensitivity -> stricter (larger) margin",
     [_finding(1, "weak")] * 20,
     lambda m: m > config.PUBLIC_MARGIN),

    ("mostly verbatim, high sensitivity -> looser (smaller) margin",
     [_finding(3, "verbatim")] * 20,
     lambda m: m < config.PUBLIC_MARGIN),

    ("adjustment never exceeds the configured bound",
     [_finding(3, "verbatim")] * 500,
     lambda m: m >= round(config.PUBLIC_MARGIN * (1 - config.CALIBRATION_MAX_ADJUST), 4)),
]


def main() -> None:
    original = audit.detection_findings
    passed = 0
    try:
        for label, findings, check in CASES:
            audit.detection_findings = lambda findings=findings: findings
            margin = calibration.calibrated_margin(TYPE)
            ok = check(margin)
            print(f"[{'ok' if ok else 'FAIL'}] {label} -> margin={margin}")
            passed += ok
    finally:
        audit.detection_findings = original

    print(f"\n{passed}/{len(CASES)} passed")
    if passed != len(CASES):
        sys.exit(1)


if __name__ == "__main__":
    main()
