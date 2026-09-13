"""Check the context stage (CONTRACT.md #9): documents leaked a piece at a time.

Run:  python -m eval.check_context            (from the repo root)

Two parts, each case against its own throwaway database:

1. Fixtures. Hand-written matches go through context.assess() and
   context.record(), and any cumulative finding goes through policy. No model,
   so this always runs.
2. Sequences. Real prompts, in order, through pipeline.inspect(). Only runs on
   the sentence-transformers backend; on the hashing fallback near misses
   mean nothing. Includes a run of harmless prompts that must never add up.

Like check_contract, these are acceptance tests for the demo. Don't tune
thresholds on them.
"""
from __future__ import annotations

import logging
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from detector import audit, config, context  # noqa: E402
from detector.detection import DetectionResult  # noqa: E402
from detector.policy import get_engine  # noqa: E402

MEMO = "financial_plan/acquisition-memo.md"
REORG = "strategic_plan/commercial-reorg.md"
BUDGET = "financial_plan/q4-budget-allocation.md"
RESULTS = "research_report/experiment-results-q3.md"
TOTALS = {MEMO: (6, "financial_plan", 3), REORG: (3, "strategic_plan", 2), BUDGET: (3, "financial_plan", 1)}
DAY = 86400


def _fresh_db() -> None:
    config.DB_PATH = Path(tempfile.mkdtemp()) / "context.db"
    audit.init()
    context.init()


def _match(doc: str, chunk: int, basis: str = "near_miss", span: tuple[int, int] = (0, 40)) -> context.Match:
    _, type_, tier = TOTALS[doc]
    return context.Match(doc, chunk, type_, tier, basis, 0.7, 0.08, span)


class Sender:
    """Plays one prompt through assess -> policy -> record, like the pipeline."""

    def __init__(self):
        _fresh_db()
        self.engine = get_engine()
        self.event = 0

    def send(self, user: str, dest_class: str, matches: list[context.Match],
             action: str = "allow", ago_days: float = 0,
             edited: list[tuple[int, int]] = ()) -> tuple[context.ContextSignal, str]:
        now = time.time() - ago_days * DAY
        team = self.engine.team_of(user)
        signal = context.assess(user=user, team=team, destination_class=dest_class,
                                matches=matches, now=now, chunk_totals=TOTALS)
        if signal.escalations:
            result = DetectionResult(findings=signal.escalations)
            action = self.engine.evaluate_detection(result, destination_class=dest_class, role="default").action
        self.event += 1
        context.record(event_id=self.event, user=user, team=team, destination="fixture",
                       destination_class=dest_class, action=action, matches=matches,
                       signal=signal, edited_spans=edited, now=now)
        return signal, action


def _expect(signal: context.ContextSignal, action: str, *, scope: str | None, want_action: str) -> list[str]:
    escalated = [e for e in signal.exposures if e.escalated]
    problems = []
    if scope is None and escalated:
        problems.append(f"expected no cumulative finding, got {[(e.doc, e.scope) for e in escalated]}")
    if scope is not None and not any(e.scope == scope for e in escalated):
        problems.append(f"expected a {scope}-scope cumulative finding, got {[(e.doc, e.scope) for e in escalated] or 'none'}")
    if action != want_action:
        problems.append(f"expected {want_action}, got {action}")
    return problems


DANA, ALEX, PRIYA, SAM = "dana@kestrelbio.com", "alex@kestrelbio.com", "priya@kestrelbio.com", "sam@kestrelbio.com"


def fixture_cases():
    def pieces_from_one_person(s):
        # Tier 3 pieced together still blocks: "restricted to unknown
        # destination" sits above "pieced together across prompts".
        s.send(DANA, "public_consumer", [_match(MEMO, 0)])
        return _expect(*s.send(DANA, "public_consumer", [_match(MEMO, 4)]), scope="user", want_action="block")

    def pieces_across_a_team(s):
        s.send(DANA, "public_consumer", [_match(MEMO, 0)])
        return _expect(*s.send(ALEX, "public_consumer", [_match(MEMO, 1)]), scope="team", want_action="block")

    def other_teams_do_not_add_up(s):
        s.send(DANA, "public_consumer", [_match(MEMO, 0)])
        return _expect(*s.send(PRIYA, "public_consumer", [_match(MEMO, 1)]), scope=None, want_action="allow")

    def blocked_sends_never_left(s):
        s.send(DANA, "public_consumer", [_match(MEMO, 0)], action="block")
        s.send(DANA, "public_consumer", [_match(MEMO, 2)], action="sanitize", edited=[(0, 40)])
        return _expect(*s.send(DANA, "public_consumer", [_match(MEMO, 4)]), scope=None, want_action="allow")

    def sanitised_prompt_counts_what_it_left_unedited(s):
        # The sanitiser edited the first sentence and sent the second as typed.
        s.send(DANA, "public_consumer", [_match(MEMO, 2, span=(0, 40)), _match(MEMO, 3, span=(41, 90))],
               action="sanitize", edited=[(0, 40)])
        return _expect(*s.send(DANA, "public_consumer", [_match(MEMO, 4)]), scope="user", want_action="block")

    def every_contributing_sentence_gets_a_finding(s):
        s.send(SAM, "public_consumer", [_match(REORG, 0)])
        signal, action = s.send(SAM, "public_consumer",
                                [_match(REORG, 1, span=(0, 40)), _match(REORG, 2, span=(41, 90))])
        spans = sorted(tuple(f.span) for f in signal.escalations)
        problems = _expect(signal, action, scope="user", want_action="sanitize")
        if spans != [(0, 40), (41, 90)]:
            problems.append(f"cumulative findings should cover both sentences, got spans {spans}")
        return problems

    def internal_model_never_counts(s):
        s.send(SAM, "private_local", [_match(MEMO, 0)])
        problems = _expect(*s.send(SAM, "public_consumer", [_match(MEMO, 4)]), scope=None, want_action="allow")
        return problems + _expect(*s.send(SAM, "private_local", [_match(MEMO, 5)]), scope=None, want_action="allow")

    def destination_classes_are_separate(s):
        s.send(DANA, "enterprise_vetted", [_match(MEMO, 0)], action="warn")
        return _expect(*s.send(DANA, "public_consumer", [_match(MEMO, 4)]), scope=None, want_action="allow")

    def resending_the_same_section(s):
        s.send(DANA, "public_consumer", [_match(MEMO, 0)])
        return _expect(*s.send(DANA, "public_consumer", [_match(MEMO, 0)]), scope=None, want_action="allow")

    def request_noise_on_one_chunk(s):
        # CONTRACT.md #8: harmless request sentences all land on commercial-reorg chunk 2.
        for _ in range(4):
            signal, action = s.send(SAM, "enterprise_vetted", [_match(REORG, 2, "paraphrase")], action="warn")
        return _expect(signal, action, scope=None, want_action="warn")

    def two_sections_in_one_prompt(s):
        return _expect(*s.send(DANA, "public_consumer", [_match(MEMO, 0), _match(MEMO, 3)]),
                       scope=None, want_action="allow")

    def old_sends_expire(s):
        s.send(DANA, "public_consumer", [_match(MEMO, 0)], ago_days=config.CONTEXT_WINDOW_DAYS + 1)
        return _expect(*s.send(DANA, "public_consumer", [_match(MEMO, 4)]), scope=None, want_action="allow")

    def vetted_vendor_gets_rewrite_not_block(s):
        s.send(DANA, "enterprise_vetted", [_match(MEMO, 0)], action="warn")
        return _expect(*s.send(DANA, "enterprise_vetted", [_match(MEMO, 4)]), scope="user", want_action="sanitize")

    def tier_two_doc_pieced_together_is_sanitized(s):
        # CONTRACT.md #9 review: tier 2 tries sanitize before block.
        s.send(SAM, "public_consumer", [_match(REORG, 0)])
        return _expect(*s.send(SAM, "public_consumer", [_match(REORG, 1)]), scope="user", want_action="sanitize")

    def tier_one_doc_adds_up_but_is_allowed(s):
        s.send(DANA, "public_consumer", [_match(BUDGET, 0)])
        return _expect(*s.send(DANA, "public_consumer", [_match(BUDGET, 1)]), scope="user", want_action="allow")

    def graph_shows_what_left(s):
        s.send(DANA, "public_consumer", [_match(MEMO, 0)])
        s.send(ALEX, "public_consumer", [_match(MEMO, 1)])       # completes it for the team, blocked
        g = context.graph(teams=s.engine.teams, chunk_totals=TOTALS)
        edges = {(e["source"], e["target"]): e for e in g["edges"]}
        problems = []
        if ("team:finance", f"user:{DANA}") not in edges:
            problems.append("no team:finance -> dana membership edge")
        alex = edges.get((f"user:{ALEX}", f"doc:{MEMO}"))
        if not alex or alex["chunks_left"] != 0 or alex["chunks_held"] != 1 or not alex["escalated"]:
            problems.append(f"alex -> memo edge should be 0 left, 1 held, escalated; got {alex}")
        reached = edges.get((f"doc:{MEMO}", "dest:public_consumer"))
        if not reached or reached["chunks"] != 1:
            problems.append(f"memo -> public_consumer should carry 1 chunk; got {reached}")
        if any("text" in n or "preview" in n for n in g["nodes"]):
            problems.append("graph nodes carry prompt text")
        return problems

    return [pieces_from_one_person, pieces_across_a_team, other_teams_do_not_add_up,
            blocked_sends_never_left, sanitised_prompt_counts_what_it_left_unedited,
            every_contributing_sentence_gets_a_finding, internal_model_never_counts, destination_classes_are_separate,
            resending_the_same_section, request_noise_on_one_chunk, two_sections_in_one_prompt,
            old_sends_expire, vetted_vendor_gets_rewrite_not_block,
            tier_two_doc_pieced_together_is_sanitized, tier_one_doc_adds_up_but_is_allowed,
            graph_shows_what_left]


COHORT4 = "research_report/cohort-four-interim.md"

# Real prompts, in order. `expect` on a step: the source of a cumulative finding
# that step must carry, or None for none at all. An optional fifth element lists
# phrases that must not be in what actually reaches the destination (the
# sanitised text on sanitize, nothing on block, the prompt on allow/warn).
SEQUENCES = [
    ("acquisition memo, one person, two prompts", [
        (DANA, "gemini.google.com", "We are thinking about buying a microfluidics company for just under "
         "four hundred million, mostly cash with some stock.", None),
        (DANA, "gemini.google.com", "The company we want to buy is in a legal fight with an ex-contractor "
         "over cartridge tooling and our lawyers call the exposure moderate.", MEMO),
    ]),
    ("acquisition memo, two people on the finance team", [
        (DANA, "chatgpt.com", "We are thinking about buying a microfluidics company for just under "
         "four hundred million, mostly cash with some stock.", None),
        (ALEX, "chatgpt.com", "Some of the purchase price will sit in escrow until the patent dispute is "
         "settled. What is a normal escrow percentage?", MEMO),
    ]),
    ("q3 results, one researcher", [
        (PRIYA, "chatgpt.com", "Our lead molecule shrank tumours by a bit under half compared with vehicle "
         "in the second group, but we see liver problems past twelve milligrams per kilo.", None),
        (PRIYA, "chatgpt.com", "In the second cohort, KB-2291 reduced tumour volume by 47 percent relative "
         "to vehicle control at day 21.", RESULTS),
    ]),
    ("tier 2 pieced together: every contributing sentence is sanitised", [
        (PRIYA, "chatgpt.com", "We started dosing the fourth group this week on a schedule of three days "
         "on and two days off.", None),
        # Repeats the section already out (scores higher) and adds a new one.
        # Redacting only the strongest sentence would send the day-7 result.
        (PRIYA, "chatgpt.com", "We started dosing the fourth group this week on a schedule of three days "
         "on and two days off. The first blood results show liver enzymes staying flat at day seven "
         "in the intermittent group.", COHORT4,
         ["liver enzymes staying flat", "three days on and two days off"]),
    ]),
    ("harmless prompts to a vetted vendor never add up", [
        (SAM, "platform.openai.com", text, None) for text in (
            "Draft an internal note for the leadership team about the new office opening hours.",
            "Can you help me write a polite reminder to submit expense reports by Friday?",
            "Summarise the key points of a good one-on-one meeting with a new manager.",
            "What should a quarterly business review deck for a lab software company contain?",
            "How do I write a job description for a senior hardware engineer?",
            "What are common escrow terms in technology acquisitions?",
            "Explain how per-seat and usage-based pricing differ for SaaS products.",
            "Write a project update email saying the migration slipped by two weeks.",
            "What makes a good design partner programme for a hardware product?",
            "How should a board evaluate whether to build or buy a capability?",
            "What should the board be asking?",
            "Help me plan how to announce it.",
        )
    ]),
    ("public questions from one person never add up", [
        (DANA, "chatgpt.com", text, None) for text in (
            "What do Series C rounds for lab software companies usually look like in terms of valuation range and board seats?",
            "Why do oncology programmes switch to intermittent dosing when liver toxicity limits the dose?",
            "Why do lab software vendors set up a separate enterprise sales team once they have a few large accounts?",
            "What is a Z-factor and why is 0.5 the usual cutoff for a screening assay?",
        )
    ]),
]


def run_sequences() -> int:
    from detector import pipeline, rewrite
    from sanitiser import llm

    # Keep the check offline and deterministic: no Ollama rewrites, so the
    # sanitiser's generalise falls back to redaction.
    rewrite.health = lambda: False
    rewrite.rewrite = lambda _text: rewrite.RewriteResult(None, False, "rewrite disabled in check")
    llm.generalise = lambda *_args, **_kwargs: None
    state = pipeline.warm_up()
    if not state["semantic"]:
        print("sequences skipped: hashing fallback, near misses are meaningless")
        return 0

    failed = 0
    for name, steps in SEQUENCES:
        _fresh_db()
        problems = []
        for user, dest, text, want, *withheld in steps:
            r = pipeline.inspect(text, destination=dest, user=user, role="default")
            got = [f["label"] for f in r.findings if f["kind"] == "context"]
            sent = {"block": "", "sanitize": r.rewritten or ""}.get(r.action, text)
            for phrase in (withheld[0] if withheld else []):
                if phrase in sent:
                    problems.append(f"{text[:50]!r}: {phrase!r} reached {dest} ({r.action}): {sent!r}")
            if want is None and got:
                problems.append(f"{text[:50]!r}: unexpected cumulative finding on {got} ({r.action})")
            if want is not None and want not in got:
                problems.append(f"{text[:50]!r}: no cumulative finding on {want} ({r.action}, {r.context})")
            else:
                shown = f" -> {r.action}: {r.message}" if got else f" -> {r.action}"
                print(f"       {user.split('@')[0]:5s} {text[:60]!r}{shown}")
        failed += bool(problems)
        print(f"[{'FAIL' if problems else 'ok'}] {name}")
        for p in problems:
            print(f"       {p}")
    print(f"\nsequences {len(SEQUENCES) - failed}/{len(SEQUENCES)} pass")
    return failed


def main() -> int:
    logging.disable(logging.WARNING)
    failed = 0
    cases = fixture_cases()
    for case in cases:
        problems = case(Sender())
        failed += bool(problems)
        print(f"[{'FAIL' if problems else 'ok'}] {case.__name__.replace('_', ' ')}")
        for p in problems:
            print(f"       {p}")
    print(f"\nfixtures {len(cases) - failed}/{len(cases)} pass\n")
    failed += run_sequences()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
