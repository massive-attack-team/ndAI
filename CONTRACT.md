# Detection to response contract

This file defines the interface between detection (what kind of sensitive
thing a piece of text is, and how sensitive) and response (what happens to
it, given who is sending it and where it is going). Detection does not need
to know how response uses its output. Response does not need to know how
detection arrived at its judgment. Only the handoff shape below has to stay
stable.

## 1. Scope

Three document types:

- `strategic_plan`
- `financial_plan`
- `research_report`

PII and credentials are handled by a separate stage, `detector/secrets_scan.py`,
and are out of scope for this contract: they are pattern and entropy based,
not part of the type and sensitivity judgment described here.

Detection works the same way for all three types: embed the candidate text,
compare it against a reference corpus, and score the gap between "matches
our internal material" and "matches material that is already public or
known." The reference corpus differs per type (see §3), but the comparison
mechanism does not: one code path, three corpora.

Live web lookup to check research freshness is out of scope. Detection uses
a static corpus only. This is a deliberate, documented limitation; see the
"Research freshness is local-only for now" entry in README.md's Limits
section for the reasoning and the tradeoff if it is revisited later.

## 2. The handoff shape

Detection produces one `DetectionResult` per inspected text. Response
consumes it and nothing else: it does not re-read the original corpus or
re-run embeddings.

```
Finding:
  type: "strategic_plan" | "financial_plan" | "research_report"
  sensitivity: 0 | 1 | 2 | 3          # see tier rubric in §3
  confidence: "verbatim" | "paraphrase" | "weak"   # see §4
  span: [start, end]                  # character offsets into the input text
  evidence:
    matched_source: str | null        # which corpus doc this matched, if any
    score: float                      # raw similarity to the matched source
    public_baseline_score: float | null   # best match against the "known/public" corpus
    margin: float | null              # score - public_baseline_score
    excerpt: str                      # short redacted preview, not raw text

DetectionResult:
  findings: [Finding, ...]            # zero or more; a prompt can trip more than one
  overall_sensitivity: int            # max(f.sensitivity for f in findings), 0 if none
  types_present: [str, ...]           # distinct types across findings
```

Notes:

- **Sentence-level, not prompt-level.** Score each sentence or chunk
  independently and keep every finding above threshold, instead of
  collapsing to one verdict for the whole prompt. A long prompt with one
  leaked line should still trip a finding on that line.
- **A prompt can carry multiple findings.** Response must decide off the
  full `findings` list, not just `overall_sensitivity` in isolation. For
  example, a financial finding at tier 2 plus a strategic finding at tier 3
  should not quietly resolve to "tier 3, one type," which would hide the
  fact that there are two distinct exposures with different
  `matched_source`s.
- **Thresholds decide what counts as a match at all.** They belong in
  `detector/config.py` as named constants (following the existing
  `PROVENANCE_HIT` / `PUBLIC_MARGIN` pattern), not hardcoded inside the
  matching function, so they stay traceable when detection needs retuning
  or response is misfiring on them.

## 3. Type taxonomy and sensitivity rubric

Sensitivity is about the disclosure harm of the specific passage, not the
document type as a whole. A document can contain findings at different
tiers.

| Tier | Strategic plan | Financial plan | Research report |
|---|---|---|---|
| **0** public | Already announced publicly | Published figures / public guidance | Published findings |
| **1** internal | Internal process/roadmap already loosely known company-wide | Internal budget mechanics, no deal attached | Methodology/approach discussion, no results |
| **2** confidential | Confidential internal strategy: not explosive if leaked, but not for outside eyes | Confidential projections/plans not yet public | In-progress findings, not yet written up for publication |
| **3** restricted | Unannounced M&A, pricing, market entry, or competitive move pre-disclosure | Unpublished figures tied to a specific deal, raise, or guidance not yet released | Unpublished results carrying competitive, regulatory, or IP risk if disclosed early |

If a passage does not clearly fit a tier, round down. False negatives here
get caught by whichever other stage flags them (provenance, secrets); false
positives are what gets the tool turned off.

## 4. Confidence bands

Confidence describes how the match was found, not how bad it is. Keep it
separate from sensitivity.

- **`verbatim`**: near-identical text match to a specific internal source
  (score above the "strong" threshold). Strongest evidence, always shown
  with `matched_source`.
- **`paraphrase`**: semantic match to internal material that clears the
  margin over the best public-corpus match (the mechanism in
  `detector/provenance.py`: internal score high, and beats the public score
  by `PUBLIC_MARGIN`). This is the core "paraphrase recall" case the whole
  product is judged on.
- **`weak`**: type signal only (the passage reads as strategic, financial,
  or research material) with no corpus match clearing the margin. Weakest
  evidence: no `matched_source`, and `score`/`public_baseline_score` may be
  null.

Response should treat these as decreasing trust: `verbatim` can justify a
block on its own; `weak` alone should not escalate past a warn regardless
of sensitivity tier, since it is the band most likely to be a false
positive.
