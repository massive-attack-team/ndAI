"""Team & user history calibration.

"Team" is deliberately simple: every event this one local install has ever
logged (detector/audit.py's SQLite events table), across every `user` value
it has seen. No new networking, no multi-machine sync - the existing local
audit log already IS the team's shared history for this install.

Two numbers come out of that history, per in-scope document type
(CONTRACT.md #3):
  sensitive_rate    share of that type's past findings at tier >= 2
                    (confidential/restricted).
  confidence_rate   share that were verbatim/paraphrase (a confirmed corpus
                    match) rather than weak (topic-only guess, no match).

calibrated_margin() turns those into a small, bounded nudge on
config.PUBLIC_MARGIN: tighter (larger margin required) when a type's
history is mostly weak guesses - the signal there hasn't been reliable, so
demand more separation from public material before calling it a leak -
and looser when a type's history skews heavily sensitive, since leaks in
that type have cost more here and are worth catching more aggressively.
Below CALIBRATION_MIN_SAMPLES findings for a type, this is a no-op: a fresh
install, or a type nobody has triggered much yet, behaves exactly like the
static PUBLIC_MARGIN does today.

user_profile() is the same computation scoped to one user instead of the
whole team. It is advisory only - a display hint about what a person
typically works on - and is never fed into detector/policy.py's role-based
clearance. That value is security-relevant (policy.yaml roles map straight
to clearance tiers), and inferring it from behaviour would let someone
raise their own clearance just by asking about a topic repeatedly.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

from . import audit, categories, config


@dataclass
class TeamStats:
    n: int
    sensitive_rate: float
    confidence_rate: float


def _stats_for(findings: list[dict]) -> TeamStats:
    n = len(findings)
    if n == 0:
        return TeamStats(0, 0.0, 0.0)
    sensitive = sum(1 for f in findings if (f.get("sensitivity") or 0) >= 2)
    confident = sum(1 for f in findings if f.get("confidence") in ("verbatim", "paraphrase"))
    return TeamStats(n, round(sensitive / n, 3), round(confident / n, 3))


def team_stats(doc_type: str) -> TeamStats:
    findings = [f for f in audit.detection_findings() if f.get("type") == doc_type]
    return _stats_for(findings)


def user_stats(user: str) -> dict[str, TeamStats]:
    by_type: dict[str, list[dict]] = {}
    for f in audit.detection_findings():
        if f.get("_user") == user:
            by_type.setdefault(f.get("type"), []).append(f)
    return {t: _stats_for(fs) for t, fs in by_type.items()}


def user_profile(user: str) -> dict:
    stats = user_stats(user)
    total = sum(s.n for s in stats.values())
    shares = {t: round(s.n / total, 3) for t, s in stats.items()} if total else {}
    top_type = max(shares, key=shares.get) if shares else None
    return {"user": user, "n": total, "shares": shares, "top_type": top_type}


def calibrated_margin(doc_type: str | None) -> float:
    if doc_type not in categories.TARGET_TYPES:
        return config.PUBLIC_MARGIN
    stats = team_stats(doc_type)
    if stats.n < config.CALIBRATION_MIN_SAMPLES:
        return config.PUBLIC_MARGIN
    # Low confidence_rate (mostly weak guesses) -> positive gap -> stricter.
    # High sensitive_rate (mostly tier >=2) -> positive gap -> looser.
    conf_gap = config.CALIBRATION_TARGET_CONFIDENCE - stats.confidence_rate
    sens_gap = stats.sensitive_rate - config.CALIBRATION_TARGET_SENSITIVE
    adjustment = conf_gap - sens_gap
    adjustment = max(-config.CALIBRATION_MAX_ADJUST, min(config.CALIBRATION_MAX_ADJUST, adjustment))
    return round(config.PUBLIC_MARGIN * (1 + adjustment), 4)


def margin_by_type() -> dict[str, float]:
    """Computed once per caller (detector/provenance.py calls this once per
    check_all(), not once per sentence) so a multi-sentence prompt doesn't
    re-scan the audit log per sentence."""
    return {t: calibrated_margin(t) for t in categories.TARGET_TYPES}


def calibration_report() -> dict:
    return {
        t: {**asdict(team_stats(t)), "effective_margin": calibrated_margin(t)}
        for t in categories.TARGET_TYPES
    }
