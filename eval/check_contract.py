"""Check detection against the CONTRACT.md scenarios.

Run:  python -m eval.check_contract            (from the repo root)

eval/contract_scenarios.json holds prompts for the three types in CONTRACT.md.
Each says which sentences detect() must flag - as which type, tier and
confidence, against which source document - and which sentences it must leave
alone. Each also carries a fixture DetectionResult in the CONTRACT.md #2 shape,
so the response side can build against it without running the model.

The fixtures are always validated; detector.detection.detect is checked as soon
as it imports. These are acceptance tests for the demo, not the metric: never
tune thresholds on them.
"""
from __future__ import annotations

import dataclasses
import importlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

SCENARIOS = Path(__file__).resolve().parent / "contract_scenarios.json"
TYPES = ("strategic_plan", "financial_plan", "research_report")
CONFIDENCE = ("verbatim", "paraphrase", "weak")


def describe(f: dict) -> str:
    return f"{f['type']} tier {f['sensitivity']} {f['confidence']} <- {f['evidence']['matched_source']}"


def shape_problems(result: dict, text: str) -> list[str]:
    """Violations of the DetectionResult shape in CONTRACT.md #2."""
    findings = result.get("findings")
    if not isinstance(findings, list):
        return ["findings is missing or not a list"]
    problems = []
    for f in findings:
        start, end = f["span"]
        where = repr(text[start:end][:40])
        if f["type"] not in TYPES:
            problems.append(f"{where}: type {f['type']!r} is not one of {TYPES}")
        if f["sensitivity"] not in (0, 1, 2, 3):
            problems.append(f"{where}: sensitivity {f['sensitivity']!r} is not 0-3")
        if f["confidence"] not in CONFIDENCE:
            problems.append(f"{where}: confidence {f['confidence']!r} is not one of {CONFIDENCE}")
        if not 0 <= start < end <= len(text):
            problems.append(f"span {f['span']} is outside the text")
        e = f["evidence"]
        if f["confidence"] == "weak":
            if e["matched_source"] is not None:
                problems.append(f"{where}: weak finding has a matched_source")
        elif not e["matched_source"]:
            problems.append(f"{where}: {f['confidence']} finding has no matched_source")
        elif abs(e["margin"] - (e["score"] - e["public_baseline_score"])) > 2e-3:
            problems.append(f"{where}: margin is not score - public_baseline_score")
    top = max((f["sensitivity"] for f in findings), default=0)
    if result.get("overall_sensitivity") != top:
        problems.append(f"overall_sensitivity is {result.get('overall_sensitivity')}, max over findings is {top}")
    if result.get("types_present") != sorted({f["type"] for f in findings}):
        problems.append("types_present is not the sorted distinct finding types")
    return problems


def expectation_problems(result: dict, text: str, expect: dict) -> list[str]:
    found = [(text[f["span"][0]:f["span"][1]], f) for f in result["findings"]]
    got = [f"{s[:40]!r} as {describe(f)}" for s, f in found] or "nothing"
    problems = []
    if not expect["findings"] and found:
        problems.append(f"expected no findings, got {got}")
    for want in expect["findings"]:
        hits = [f for sentence, f in found if want["contains"] in sentence]
        wanted = {k: v for k, v in want.items() if k != "contains"}
        if not hits:
            problems.append(f"nothing flagged on {want['contains']!r} (want {wanted}); got {got}")
        elif not any(
            f["type"] == want["type"]
            and want.get("sensitivity") in (None, f["sensitivity"])
            and want.get("confidence") in (None, f["confidence"])
            and want.get("matched_source") in (None, f["evidence"]["matched_source"])
            for f in hits
        ):
            problems.append(f"{want['contains']!r} flagged as {[describe(f) for f in hits]}, want {wanted}")
    for phrase in expect.get("no_findings_on", []):
        if any(phrase in sentence for sentence, _ in found):
            problems.append(f"flagged {phrase!r}, which carries no internal content")
    return problems


def _detect():
    """detect() if it exists, None if not. Real import errors still raise."""
    try:
        module = importlib.import_module("detector.detection")
    except ModuleNotFoundError as exc:
        if exc.name == "detector.detection":
            return None
        raise
    return getattr(module, "detect", None)


def _as_dict(result) -> dict:
    raw = result if isinstance(result, dict) else dataclasses.asdict(result)
    for f in raw["findings"]:
        f["span"] = list(f["span"])
    return raw


def check(result: dict, scenario: dict) -> list[str]:
    problems = shape_problems(result, scenario["text"])
    if isinstance(result.get("findings"), list):
        problems += expectation_problems(result, scenario["text"], scenario["expect"])
    return problems


def main() -> int:
    data = json.loads(SCENARIOS.read_text(encoding="utf-8"))
    detect = _detect()
    sides = {"fixtures": lambda s: s["detection"]}
    if detect:
        sides["detection"] = lambda s: _as_dict(detect(s["text"]))

    failed = 0
    for side, produce in sides.items():
        passed = 0
        for s in data["scenarios"]:
            problems = check(produce(s), s)
            passed += not problems
            for p in problems:
                print(f"  FAIL {side:9s} {s['name']}: {p}")
        failed += len(data["scenarios"]) - passed
        print(f"{side:9s} {passed}/{len(data['scenarios'])} scenarios pass")
    if detect is None:
        print("detection not implemented yet (detector.detection.detect)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
