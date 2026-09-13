"""Populate the audit log with a few real scenarios, including a cumulative
(pieced-together-across-prompts) one, for a warm demo state.

Run once before the demo:  python demo_seed.py
"""
from __future__ import annotations

from detector import audit, context, pipeline

SCENARIOS = [
    # public_domain -> allow. Same field, no internal match.
    ("What is a Z-factor and why is 0.5 the usual cutoff for a screening assay?",
     "chatgpt.com", "priya@kestrelbio.com", "researcher"),

    # live credential -> block, regardless of destination.
    ("Here is my env file, why does the connection fail: "
     "DATABASE_URL=postgresql://kestrel:8fh39dkw0slq@db.internal:5432/compounds",
     "claude.ai", "sam@kestrelbio.com", "engineer"),

    # financial_plan, tier 3 paraphrase -> vetted vendor -> sanitize.
    ("We are thinking about buying a microfluidics company for just under four hundred "
     "million, mostly cash with some stock, and holding back some of it because of a "
     "patent fight. What should the board be asking?",
     "platform.openai.com", "dana@kestrelbio.com", "default"),

    # strategic_plan, tier 3 paraphrase -> consumer AI -> block.
    ("Next year we want to stop charging per seat and start charging per plate when the "
     "autoloader goes generally available. Draft the internal note.",
     "chatgpt.com", "sam@kestrelbio.com", "engineer"),

    # research_report, tier 3 verbatim -> consumer AI -> block.
    ("Hepatotoxicity appears above 12 mg/kg. Three of eight animals in the high dose arm "
     "showed ALT elevation beyond three times the upper limit of normal, and the effect "
     "was dose dependent rather than idiosyncratic.",
     "gemini.google.com", "priya@kestrelbio.com", "researcher"),

    # research_report, tier 2 verbatim -> vetted vendor -> warn.
    ("Cohort four dosing started this week, testing the intermittent schedule proposed "
     "after cohort three: three days on, two days off, versus the continuous dosing used "
     "in cohorts one through three.",
     "console.anthropic.com", "priya@kestrelbio.com", "researcher"),

    # strategic_plan, tier 2 verbatim -> private/internal model -> allow, stays on network.
    ("We are splitting the commercial team into two pods: enterprise accounts running the "
     "autoloader, and self-serve registry API customers on the per-seat plan. Tighten this.",
     "localhost", "dana@kestrelbio.com", "default"),

    # Context stage: a separate copy of the acquisition memo, pieced together
    # a fragment at a time. Each piece alone is a near miss (too reworded to
    # clear PUBLIC_MARGIN on its own) - allow. The pieces add up: first across
    # two prompts from one person, then a second person on the same finance
    # team completes it further. Both land on public_consumer, so the third
    # prompt should trip "pieced together across prompts" -> sanitize (or
    # block, if the rewrite model isn't reachable).
    ("We are thinking about buying a microfluidics company for just under four hundred million, "
     "mostly cash with some stock. What should the board be asking?",
     "gemini.google.com", "dana@kestrelbio.com", "default"),
    ("The company we want to buy is in a legal fight with an ex-contractor over cartridge tooling "
     "and our lawyers call the exposure moderate. How worried should we be?",
     "gemini.google.com", "dana@kestrelbio.com", "default"),
    ("Some of the purchase price will sit in escrow until the patent dispute is settled. What is a "
     "normal escrow percentage?",
     "chatgpt.com", "alex@kestrelbio.com", "default"),

    # A lone near miss on a different document (research_report) - too small
    # and too reworded to be a finding, and with nothing else to add up
    # against, should stay allow.
    ("In the second cohort, KB-2291 reduced tumour volume by 47 percent relative to vehicle control "
     "at day 21.",
     "chatgpt.com", "priya@kestrelbio.com", "researcher"),
]


def main() -> None:
    audit.init()
    context.init()
    state = pipeline.warm_up()
    print(f"backend={state['embed_backend']} semantic={state['semantic']} "
          f"rewrite={state['rewrite_model_up']}\n")
    for text, dest, user, role in SCENARIOS:
        r = pipeline.inspect(text, destination=dest, user=user, role=role)
        print(f"{r.action:9s} {dest:22s} {r.latency_ms:6.1f}ms  {r.rule}")
        print(f"          {r.baselines['ndai']}")
    print("\n" + str(audit.stats()))


if __name__ == "__main__":
    main()
