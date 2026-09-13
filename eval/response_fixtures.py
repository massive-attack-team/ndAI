"""Person 2's (Response) validation harness - CONTRACT.md #6.

Hand-written DetectionResult fixtures, not real detection output. The point
is to build and sanity-check the policy decision logic against every
interesting tier x confidence x destination combination without waiting on
Person 1's detection work to be finished or even running.

Run:  python -m eval.response_fixtures            (from the repo root)
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from detector.detection import DetectionResult, Evidence, Finding  # noqa: E402
from detector.policy import get_engine  # noqa: E402


def _finding(type_: str, sensitivity: int, confidence: str, source: str = "fixture.md") -> Finding:
    return Finding(
        type=type_, sensitivity=sensitivity, confidence=confidence, span=(0, 40),
        evidence=Evidence(
            matched_source=source if confidence != "weak" else None,
            score=0.8, public_baseline_score=0.4 if confidence != "weak" else None,
            margin=0.4 if confidence != "weak" else None, excerpt="[fixture excerpt]",
        ),
    )


CASES = [
    # (label, DetectionResult, destination_class, role, expected_action)
    ("empty result -> allow",
     DetectionResult(findings=[], overall_sensitivity=0, types_present=[]),
     "public_consumer", "default", "allow"),

    ("tier3 verbatim financial_plan -> public consumer -> block",
     DetectionResult(findings=[_finding("financial_plan", 3, "verbatim")], overall_sensitivity=3,
                      types_present=["financial_plan"]),
     "public_consumer", "researcher", "block"),

    ("tier3 verbatim financial_plan -> private_local -> allow (stays on network)",
     DetectionResult(findings=[_finding("financial_plan", 3, "verbatim")], overall_sensitivity=3,
                      types_present=["financial_plan"]),
     "private_local", "researcher", "allow"),

    ("tier3 paraphrase strategic_plan -> enterprise_vetted -> sanitize",
     DetectionResult(findings=[_finding("strategic_plan", 3, "paraphrase")], overall_sensitivity=3,
                      types_present=["strategic_plan"]),
     "enterprise_vetted", "engineer", "sanitize"),

    ("tier2 paraphrase research_report -> public_consumer -> sanitize",
     DetectionResult(findings=[_finding("research_report", 2, "paraphrase")], overall_sensitivity=2,
                      types_present=["research_report"]),
     "public_consumer", "researcher", "sanitize"),

    ("tier2 paraphrase research_report -> enterprise_vetted -> warn",
     DetectionResult(findings=[_finding("research_report", 2, "paraphrase")], overall_sensitivity=2,
                      types_present=["research_report"]),
     "enterprise_vetted", "researcher", "warn"),

    ("tier1 weak strategic_plan -> public_consumer -> allow (too weak, too low tier)",
     DetectionResult(findings=[_finding("strategic_plan", 1, "weak")], overall_sensitivity=1,
                      types_present=["strategic_plan"]),
     "public_consumer", "engineer", "allow"),

    ("tier3 weak financial_plan -> public_consumer -> warn, NOT block (confidence caps severity)",
     DetectionResult(findings=[_finding("financial_plan", 3, "weak")], overall_sensitivity=3,
                      types_present=["financial_plan"]),
     "public_consumer", "engineer", "warn"),

    ("contractor + tier2 verbatim -> private_local -> warn (role rule fires regardless of destination)",
     DetectionResult(findings=[_finding("financial_plan", 2, "verbatim")], overall_sensitivity=2,
                      types_present=["financial_plan"]),
     "private_local", "contractor", "warn"),

    ("two findings, worst wins: tier2 paraphrase + tier3 verbatim -> unknown -> block",
     DetectionResult(
         findings=[_finding("financial_plan", 2, "paraphrase"), _finding("research_report", 3, "verbatim")],
         overall_sensitivity=3, types_present=["financial_plan", "research_report"]),
     "unknown", "researcher", "block"),
]


def main() -> None:
    engine = get_engine()
    failures = 0
    for label, result, dest_class, role, expected in CASES:
        decision = engine.evaluate_detection(result, destination_class=dest_class, role=role)
        ok = decision.action == expected
        failures += not ok
        mark = "ok" if ok else "FAIL"
        print(f"[{mark}] {label}")
        print(f"       -> {decision.action} ({decision.rule}): {decision.message}")
        if not ok:
            print(f"       expected {expected}, got {decision.action}")

    print(f"\n{len(CASES) - failures}/{len(CASES)} passed")
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
