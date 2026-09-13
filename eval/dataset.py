"""Labelled prompts for the evaluation.

Seed set only - roughly 40 prompts. Expand to 200+ before you report numbers.

The classes that matter are the last two. Anyone can detect verbatim copies. The
product claim stands or falls on (a) paraphrase recall and (b) not flagging
public_domain, which is the same subject matter written from public sources. A
detector that scores 100 percent recall by flagging every sentence about assays
is useless, and the hard negatives are what expose that.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Sample:
    text: str
    leak: bool          # ground truth: does this disclose internal material
    klass: str          # verbatim | paraphrase | summary | mixed | secret | public_domain | unrelated


SAMPLES: list[Sample] = [
    # --- verbatim -----------------------------------------------------------
    Sample("Kestrel is the assay pipeline that ingests plate reader output, normalises it against control wells, and writes dose-response curves to the compound registry. Explain this to a new hire.", True, "verbatim"),
    Sample("In the second cohort, KB-2291 reduced tumour volume by 47 percent relative to vehicle control at day 21. Help me turn this into a results paragraph.", True, "verbatim"),
    Sample("Recommendation: acquire Helix Assay Systems for a headline figure of 384 million dollars, structured as 60 percent cash and 40 percent stock. Tighten this sentence.", True, "verbatim"),
    Sample("The ingest service trusts filenames from the instrument share to derive the plate barcode. A malformed filename silently attaches results to the wrong compound. Write me a Jira ticket.", True, "verbatim"),
    Sample("Q4. Announce the autoloader publicly and begin general availability pricing at a per-plate rate rather than the current per-seat licence. Make this sound better.", True, "verbatim"),

    # --- paraphrase ---------------------------------------------------------
    Sample("Our screening platform takes readings off the plate reader, corrects them against the control wells, and stores the fitted curves in the compound database. How would you describe that architecture?", True, "paraphrase"),
    Sample("Our lead molecule shrank tumours by a bit under half compared with vehicle in the second group of animals, but we start seeing liver problems once we go past twelve milligrams per kilo. How do I present this?", True, "paraphrase"),
    Sample("We are thinking about buying a microfluidics company for just under four hundred million, mostly cash with some stock, and holding back some of it because of a patent fight. What should the board be asking?", True, "paraphrase"),
    Sample("Three of the eight animals on the top dose had liver enzymes over three times the normal ceiling, and it got worse with dose rather than being random. Is that a dealbreaker?", True, "paraphrase"),
    Sample("One of our services works out which plate a file belongs to by reading the filename, and if the name is wrong the results get filed under the wrong molecule. How do I make that safe?", True, "paraphrase"),
    Sample("Next year we want to stop charging per seat and start charging per plate when the autoloader goes generally available. Draft the internal note.", True, "paraphrase"),
    Sample("We are planning to let outside collaborators hit our compound registry API for the first time, which means customer data leaves our boundary. What should I worry about?", True, "paraphrase"),

    # --- summary ------------------------------------------------------------
    Sample("Summarise: our unpublished animal data shows strong efficacy but a narrow therapeutic window because of dose dependent hepatotoxicity.", True, "summary"),
    Sample("In two sentences: we are acquiring a supplier to remove a hardware dependency that has blocked our high throughput roadmap for two years.", True, "summary"),
    Sample("Rewrite this as a status update: the tenancy rework has slipped twice and it blocks opening our registry API to external collaborators.", True, "summary"),

    # --- mixed public and private -------------------------------------------
    Sample("Everyone knows a Z-factor below 0.5 means a bad assay. In our pipeline we quarantine those plates rather than deleting them. Is quarantining the right call?", True, "mixed"),
    Sample("Four parameter logistic fits are standard. Ours rejects the plate outright when the Z-factor drops below the floor. Should it warn instead?", True, "mixed"),
    Sample("mTLS between services is normal practice. In our case the compound registry also checks a per-caller scope claim before any identity write. Is that belt and braces?", True, "mixed"),

    # --- code ---------------------------------------------------------------
    Sample("def derive_barcode(filename): match = BARCODE_RE.match(filename); return f'KB-{match.group(1)}-P{match.group(2)}'  -- why does this blow up on some files?", True, "paraphrase"),
    Sample("My normalise function computes percent inhibition as 100 * (high - value) / (high - low) using the plate controls and raises on degenerate controls. Can you vectorise it?", True, "paraphrase"),

    # --- secrets ------------------------------------------------------------
    Sample("Here is my env file, why does the connection fail: DATABASE_URL=postgresql://kestrel:8fh39dkw0slq@db.internal:5432/compounds", True, "secret"),
    Sample("This request 401s with AKIAIOSFODNN7EXAMPLE as the key id. What am I doing wrong?", True, "secret"),
    Sample("api_key = 'sk-proj-9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f' is in my config, is that the right way to load it?", True, "secret"),

    # --- hard negatives: same field, public knowledge -----------------------
    Sample("What is a Z-factor and why is 0.5 the usual cutoff for a screening assay?", False, "public_domain"),
    Sample("Explain four parameter logistic curve fitting and how the Hill slope is interpreted.", False, "public_domain"),
    Sample("Is mutual TLS with short lived certificates from an internal CA a reasonable service to service auth pattern?", False, "public_domain"),
    Sample("Why do teams put Kafka between ingestion and processing in an event driven pipeline?", False, "public_domain"),
    Sample("What does ALT elevation above three times the upper limit of normal indicate in a preclinical study?", False, "public_domain"),
    Sample("How is tumour volume reduction relative to vehicle control normally reported in xenograft work?", False, "public_domain"),
    Sample("What are the tradeoffs between per seat and per plate pricing for laboratory software generally?", False, "public_domain"),
    Sample("Our public API returns 429 with a Retry-After header past 120 requests per minute. How should a client back off?", False, "public_domain"),
    Sample("Draft a press release paragraph about closing a Series B, without disclosing terms.", False, "public_domain"),
    Sample("What is the system of record pattern and why does it prevent write conflicts?", False, "public_domain"),
    Sample("How do people usually quarantine failed plates in a screening workflow?", False, "public_domain"),
    Sample("Explain why hepatotoxicity is often dose limiting for small molecule oncology candidates.", False, "public_domain"),

    # --- strategic_plan / financial_plan / research_report (CONTRACT.md) ----
    # Verbatim
    Sample("We are splitting the commercial team into two pods: enterprise accounts running the autoloader, and self-serve registry API customers on the per-seat plan. Tighten this sentence.", True, "verbatim"),
    Sample("Lead investor has proposed a pre-money valuation of 410 million dollars for a 70 million dollar raise, with a board seat and standard pro-rata rights. Clean this up.", True, "verbatim"),
    Sample("Cohort four dosing started this week, testing the intermittent schedule proposed after cohort three: three days on, two days off, versus the continuous dosing used in cohorts one through three. Turn this into an update email.", True, "verbatim"),

    # Paraphrase
    Sample("We're planning to split the sales team into two groups - one for big accounts using our hardware, one for smaller customers on the API plan - after a competitor built out a dedicated enterprise sales team. How should I present this internally?", True, "paraphrase"),
    Sample("Our lead investor wants to value us at just over four hundred million before the money for a raise of around seventy million, plus a board seat and the usual follow-on rights. Is that a normal structure for this stage?", True, "paraphrase"),
    Sample("We just started a new animal group testing an on-off dosing pattern instead of continuous dosing, following up on what we saw in the previous group. Too early to say if it's working. How do I write this up for the team?", True, "paraphrase"),
    Sample("Two other term sheets are still on the table, so we're pushing back on the lead investor's request to convert our preference to participating above a 3x return. What questions should the board be asking?", True, "paraphrase"),

    # Summary
    Sample("Summarise: engineering budget for the quarter splits roughly 60/40 between platform and hardware work, tracking close to last quarter's split.", True, "summary"),
    Sample("In two sentences: we're restructuring the commercial team into enterprise and self-serve pods in response to a competitor's move, but staff haven't been told yet.", True, "summary"),

    # Mixed public and private
    Sample("Standard oncology protocol draws blood at day 7, 14 and 21 for liver enzymes. We changed it to catch early hepatotoxicity signal the old protocol likely missed. Is that a reasonable change?", True, "mixed"),
    Sample("Board seats and pro-rata rights for the lead investor are standard in a Series C. Ours also has a follow-on commitment from two existing investors we haven't announced. Is that normal to keep quiet?", True, "mixed"),

    # --- hard negatives: same field, public knowledge ------------------------
    Sample("Why do enterprise software vendors often split into separate enterprise and self-serve sales motions once they land a handful of large accounts?", False, "public_domain"),
    Sample("What valuation range and typical board and pro-rata terms are common for Series C rounds in biotech tooling companies right now?", False, "public_domain"),
    Sample("What is a typical intermittent dosing strategy used to manage a narrow therapeutic window in oncology drug development?", False, "public_domain"),
    Sample("What's the standard blood draw schedule for monitoring liver enzymes in a preclinical toxicology study?", False, "public_domain"),
    Sample("What preference structures are common in venture term sheets, and how does participating preferred differ from non-participating?", False, "public_domain"),

    # --- unrelated ----------------------------------------------------------
    Sample("Write a limerick about a cat who refuses to get off the keyboard.", False, "unrelated"),
    Sample("What is the difference between a left join and a full outer join?", False, "unrelated"),
    Sample("Help me plan a three day trip to Tasmania in November.", False, "unrelated"),
    Sample("Explain the bias variance tradeoff to someone who has only done linear regression.", False, "unrelated"),
    Sample("Rewrite this sentence to be less passive: the report was reviewed by the team.", False, "unrelated"),
]


def counts() -> dict[str, int]:
    out: dict[str, int] = {}
    for s in SAMPLES:
        out[s.klass] = out.get(s.klass, 0) + 1
    return out
