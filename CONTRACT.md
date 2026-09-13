# Detection ↔ Response contract

Two people, two features, built in parallel today. This file is the interface
between them — read it before writing code so neither person blocks on the
other's progress.

- **Person 2 — Detection.** Given raw text, decide what kind of sensitive
  thing it is and how sensitive. Owns `detector/provenance.py`,
  `detector/categories.py`, `corpus/`, and the corpus-building work.
- **Person 1 — Response.** Given a detection judgment plus who's sending and
  where it's going, decide what happens to the prompt. Owns `detector/policy.py`,
  `policy.yaml`, `detector/rewrite.py`.

Detection doesn't need to know how response uses its output. Response doesn't
need to know how detection arrived at its judgment. The only thing that has to
be agreed on up front is the shape of the handoff below — build against that,
not against each other's in-progress code.

---

## 1. Scope for today

Three document types only:

- `strategic_plan`
- `financial_plan`
- `research_report`

(PII/credentials already exist as a separate stage — `detector/secrets_scan.py`
— and are out of scope for this contract; they're pattern/entropy-based, not
part of the type+sensitivity judgment described here.)

Detection mechanism is the same for all three: embed the candidate text,
compare it against a reference corpus, score the gap between "matches our
internal material" and "matches material that's already public/known." The
reference corpus differs per type (see §3), but the comparison mechanism does
not — one code path, three corpora.

**Not in scope today:** live web lookup to check research freshness. Static
corpus only. This is a deliberate, documented limitation — see the
"Research freshness is local-only for now" entry in `README.md`'s Limits
section for the reasoning and the tradeoff if it's revisited later.

---

## 2. The handoff shape

Detection produces one `DetectionResult` per inspected text. Response consumes
it and nothing else — it does not re-read the original corpus or re-run
embeddings.

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

Notes for both people:

- **Sentence-level, not prompt-level.** Score each sentence/chunk independently
  and keep every finding above threshold — don't collapse to one verdict for
  the whole prompt. A long prompt with one leaked line should still trip a
  finding on that line.
- **A prompt can carry multiple findings.** Response must decide off the full
  `findings` list, not just `overall_sensitivity` in isolation — e.g. a
  financial finding at tier 2 plus a strategic finding at tier 3 should not
  quietly resolve to "tier 3, one type," swallowing the fact that there are
  two distinct exposures with different `matched_source`s.
- **Thresholds are Person 2's starting call, visible to Person 1.** Whatever
  cutoff decides "this counts as a match at all" belongs in `detector/config.py`
  as a named constant (following the existing `PROVENANCE_HIT` /
  `PUBLIC_MARGIN` pattern), not hardcoded inside the matching function. If
  Person 1's testing shows the policy is firing on noise or missing obvious
  cases, the fix might be a threshold change, not a policy change — it needs
  to be visible enough that either person can trace it there.

---

## 3. Type taxonomy and sensitivity rubric

Sensitivity is about disclosure harm of the specific passage, not the document
type as a whole — a document can contain findings at different tiers.

| Tier | Strategic plan | Financial plan | Research report |
|---|---|---|---|
| **0** public | Already announced publicly | Published figures / public guidance | Published findings |
| **1** internal | Internal process/roadmap already loosely known company-wide | Internal budget mechanics, no deal attached | Methodology/approach discussion, no results |
| **2** confidential | Confidential internal strategy, not explosive if it leaked but not for outside eyes | Confidential projections/plans not yet public | In-progress findings, not yet written up for publication |
| **3** restricted | Unannounced M&A, pricing, market entry, or competitive move pre-disclosure | Unpublished figures tied to a specific deal, raise, or guidance not yet released | Unpublished results carrying competitive, regulatory, or IP risk if disclosed early |

If a passage doesn't clearly fit a tier, round down — false negatives here get
caught by whichever *other* stage flags them (provenance, secrets); false
positives are the thing that gets the tool turned off.

---

## 4. Confidence bands

Confidence describes *how the match was found*, not how bad it is — keep it
separate from sensitivity.

- **`verbatim`** — near-identical text match to a specific internal source
  (score above the "strong" threshold). Strongest evidence, always shown with
  `matched_source`.
- **`paraphrase`** — semantic match to internal material that clears the
  margin over the best public-corpus match (same mechanism as
  `detector/provenance.py` today: internal score high AND beats public score
  by `PUBLIC_MARGIN`). This is the core "paraphrase recall" case the whole
  product is judged on.
- **`weak`** — type signal only (looks like a strategic/financial/research
  passage) with no corpus match clearing the margin. Weakest evidence — no
  `matched_source`, `score`/`public_baseline_score` may be null.

Response should generally treat these as decreasing trust: `verbatim` can
justify a block on its own, `weak` alone probably shouldn't escalate past a
warn regardless of sensitivity tier, since it's the band most likely to be a
false positive.

---

## 5. What each person needs to deliver

**Person 2 (Detection) is done when:**
- `corpus/internal/` and `corpus/public/` (or a parallel structure) hold
  synthetic examples for all three types, with the public side written as
  genuine same-topic hard negatives, not obviously-different filler.
- Given a text input, produces a `DetectionResult` matching the schema in §2,
  with real (not placeholder) sensitivity/confidence/evidence values.
- Thresholds live in `detector/config.py` as named, commented constants.

**Person 1 (Response) is done when:**
- Given a `DetectionResult` (real or fixture) plus `destination` and `role`,
  returns an action (`allow` / `warn` / `sanitize` / `block`) plus a
  human-readable reason — extending the existing `policy.yaml` /
  `detector/policy.py` pattern to key off `type` and `confidence`, not just
  `sensitivity` and `destination_class` as it does today.
- Can be fully built and tested **before** Person 2's detection is real, using
  hand-written fixture `DetectionResult` objects covering each
  tier × type × confidence combination.

---

## 6. Building independently before integration

Person 1: don't wait on real detection. Write 8-10 fixture `DetectionResult`
objects by hand (one per interesting tier/confidence combination) and build
the policy logic against those. Swapping in Person 2's real output later
should require no changes to the decision logic itself, only to where the
`DetectionResult` comes from.

Person 2: don't worry about how response uses the output. Build and tune
detection in isolation — the measure of done is "does this produce the right
`DetectionResult` for a given input," not "does this produce the right final
action."
