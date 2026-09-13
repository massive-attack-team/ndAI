# Detection ↔ Response contract

Two people, two features, built in parallel today. This file is the interface
between them — read it before writing code so neither person blocks on the
other's progress.

- **Person 1 — Detection (Hoang Phuc).** Given raw text, decide what kind of
  sensitive thing it is and how sensitive. Owns `detector/detection.py`,
  `detector/provenance.py`, `detector/categories.py`, `corpus/`, and the
  corpus-building work.
- **Person 2 — Response (Peter).** Given a detection judgment plus who's sending
  and where it's going, decide what happens to the prompt. Owns
  `detector/policy.py`, `policy.yaml`, `detector/rewrite.py`.

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
- **Thresholds are Person 1's starting call, visible to Person 2.** Whatever
  cutoff decides "this counts as a match at all" belongs in `detector/config.py`
  as a named constant (following the existing `PROVENANCE_HIT` /
  `PUBLIC_MARGIN` pattern), not hardcoded inside the matching function. If
  Person 2's testing shows the policy is firing on noise or missing obvious
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

**Person 1 (Detection) is done when:**
- `corpus/internal/` and `corpus/public/` (or a parallel structure) hold
  synthetic examples for all three types, with the public side written as
  genuine same-topic hard negatives, not obviously-different filler.
- Given a text input, produces a `DetectionResult` matching the schema in §2,
  with real (not placeholder) sensitivity/confidence/evidence values.
- Thresholds live in `detector/config.py` as named, commented constants.

**Person 2 (Response) is done when:**
- Given a `DetectionResult` (real or fixture) plus `destination` and `role`,
  returns an action (`allow` / `warn` / `sanitize` / `block`) plus a
  human-readable reason — extending the existing `policy.yaml` /
  `detector/policy.py` pattern to key off `type` and `confidence`, not just
  `sensitivity` and `destination_class` as it does today.
- Can be fully built and tested **before** Person 1's detection is real, using
  hand-written fixture `DetectionResult` objects covering each
  tier × type × confidence combination.

---

## 6. Building independently before integration

Person 2: don't wait on real detection. Write 8-10 fixture `DetectionResult`
objects by hand (one per interesting tier/confidence combination) and build
the policy logic against those. Swapping in Person 1's real output later
should require no changes to the decision logic itself, only to where the
`DetectionResult` comes from.

Person 1: don't worry about how response uses the output. Build and tune
detection in isolation — the measure of done is "does this produce the right
`DetectionResult` for a given input," not "does this produce the right final
action."

---

## 7. Status

Detection (Person 1's side) has a first pass built already — typed corpus,
frontmatter-driven type/tier, `detector/detection.py`'s `detect()` producing
real `DetectionResult` values. Whoever picks up Person 1's
role can pick up from there rather than starting cold; nothing here blocks
Person 2 from starting the fixture-based response work described in §6 right
now.

Checked on 13 Sep against the real `sentence-transformers` backend
(bge-small-en-v1.5):

- **Response:** `python -m eval.response_fixtures` passes 10/10.
- **Detection:** `python -m eval.check_contract` runs the 15 acceptance
  scenarios in `eval/contract_scenarios.json` (11 across the three types and
  tiers, 4 public questions that must come back clean); `detect()` passes 8.
  The tumour and acquisition paraphrases and a word-for-word copy of the
  KB-2291 result fall under `PUBLIC_MARGIN` (margins 0.052, 0.094 and 0.075),
  the market-entry prompt gets no `weak` finding (0.603 against 0.71), and
  request sentences trip false findings (§8).
- **End to end** (`detect()`, then `evaluate_detection()`): three restricted
  leaks in the scenarios are allowed to chatgpt.com and Gemini, and harmless
  prompts that trip false findings are sanitized.

---

## 8. Proposed changes (not yet agreed)

From the 13 Sep checks in §7. Nothing here is in force until both people agree.

- **Request sentences must not match.** Generic asks match the process docs by
  wide margins. "Draft an internal note for the leadership team about the new
  office opening hours." comes back as `strategic_plan` tier 2 against
  `commercial-reorg.md` with margin 0.141, wider than most real leaks. 3 of 6
  harmless workplace prompts tested were flagged this way, and
  `evaluate_detection()` turns each into `sanitize` on chatgpt.com. Detection
  owns the fix.
- **Credentials need their own path into response.** §1 keeps them out of
  `DetectionResult`, and `evaluate_detection()` passes
  `has_critical_secret=False`, so a pasted database password produces no
  findings and is allowed. Proposal: the pipeline runs `secrets_scan.scan()`
  and applies the credential rule before `evaluate_detection()`.
- **`verbatim` means 8 or more consecutive words shared with
  `matched_source`**, ignoring case and punctuation, instead of a cosine
  cut-off. A single sentence is compared with a 60-word chunk, so copies can
  score under 0.78: the FY27 roadmap's Q4 line, copied word for word, scores
  0.772 and is labelled `paraphrase`, while a partly reworded reorg sentence
  scores 0.785 and is labelled `verbatim`. §4 lets `verbatim` justify a block,
  so the label has to be right.
- **`overall_sensitivity` should leave out `weak` findings, or go.**
  `evaluate_detection()` already decides per finding, so only other readers
  (dashboard, audit, risk score) use the field, and today a topic-only research
  or financial finding sets it to 3.
- **Define `excerpt`.** §2 says "short redacted preview, not raw text", but
  `detect()` returns the matched internal passage unredacted, and the prompt
  sentence itself for `weak` findings. Proposal: the matched internal passage
  for `verbatim` and `paraphrase`, empty for `weak`, and never sent to the
  browser or stored in the audit log.
- **Add `semantic: bool` to `DetectionResult`.** On the hashing fallback,
  paraphrase detection is off, and an empty result looks the same as a clean
  one.
- **Architecture and code docs are out of scope.** `detect()` drops matches to
  `architecture-kestrel.md` and `ingest_service.py` because they have no type,
  so the architecture prompts in `demo_seed.py` return no findings. Either give
  those docs a type or move the demo to the three types.
- **A rewrite goes back through `detect()` before it's offered.** Otherwise the
  "safe version" is never checked.
- **Detection is done when the eval says so.** Add to §5: `check_contract`
  passes, and `eval/run_eval.py` reports recall, false positives and source
  attribution per type on a held-out split, re-run whenever the corpus or
  thresholds change. The corpus reorganisation moved eval recall from 0.83 to
  0.65 without anyone noticing.

---

## 9. Context stage (agreed and merged in `b018abe`; fixes below under review)

Detection judges one prompt at a time, so a document that goes out a piece per
prompt never trips it. `detector/context.py` sits between detection and
response. It remembers which chunks of which internal documents already reached
each destination class, per person and per declared team. When the current
prompt completes enough of one document, it adds a `cumulative` finding to the
`DetectionResult` before response sees it.

Both people agreed it after the review below, and it was merged in `b018abe`.
Reverting `policy.yaml`'s `pieced together across prompts` rule turns it off.

**What changes at the handoff (§2)**

- `Evidence` gains `matched_chunk: int | null`: the chunk position inside
  `matched_source`. Null for `weak`.
- `confidence` gains a fourth value, `cumulative`. It is set only by the
  context stage, never by `detect()`. `matched_source` is the document being
  pieced together, `sensitivity` is that document's tier, and `excerpt` is
  empty. There is one `cumulative` finding per sentence of the current prompt
  that landed on that document, each with its own `span`, so the sanitiser
  edits every piece (see "After merge" below).
- `detection.detect_with_near_misses()` returns `(DetectionResult, [NearMiss])`.
  A near miss clears `PROVENANCE_HIT` and beats the public corpus by at least
  `CONTEXT_MARGIN` (0.04) but not by `PUBLIC_MARGIN`. Near misses never reach
  response. `detect()` is unchanged.

**When a `cumulative` finding is added**

For one document and one destination class, counting only content that
actually left (`allow` or `warn`; on `sanitize`, only sentences the sanitiser
left unedited; never `block` or `private_local`) within `CONTEXT_WINDOW_DAYS` (14), all of these must hold. The person is checked
first, then their team:

- the current prompt adds a chunk that hadn't already gone out,
- at least `CUMULATIVE_MIN_CHUNKS` (2) distinct chunks, from
- at least `CUMULATIVE_MIN_PROMPTS` (2) distinct prompts, covering
- at least `CUMULATIVE_COVERAGE` (0.3) of the document's chunks.

These are tuned to the synthetic corpus, where a document is 3-6 chunks. A real
corpus needs a lower coverage and a higher chunk count.

**Response side**

- `policy.yaml` gains `teams:` (declared membership, never inferred) and one
  rule, `pieced together across prompts`: `cumulative`, tier 2 or above, to
  `public_consumer` or `unknown`, is sanitized. It sits below `restricted to
  unknown destination`, so tier 3 to those destinations is blocked. Other
  destinations fall through to the existing tier rules (tier 3 to a vetted
  vendor is sanitized).
- `PolicyEngine.team_of(user)` reads `teams:`.

**Deliberately left out**

- Inferring roles or teams from prompts. The person being judged could train it.
- Using history to decide what counts as confidential. The corpus decides; history only adds up evidence.
- Escalating `weak` findings. They carry no document, so there is nothing to add up.
- Need-to-know or anomaly alerts. NDAi stops accidental disclosure, not insiders.
- Storing prompt text. `context_edges` holds doc, chunk, score, who, where and what policy did.

**Checked on 13 Sep** (bge-small-en-v1.5): `python -m eval.check_context` passes
13/13 fixture cases and 5/5 prompt sequences. The acquisition memo is caught
across two prompts from one person and across two people on the finance team,
and the Q3 results across two prompts. 12 harmless workplace prompts to a vetted
vendor and 4 public questions never add up. Every prompt that got caught was a
near miss: each piece fell under `PUBLIC_MARGIN` on its own. §7's figures are
unchanged: `check_contract` 8/15, `response_fixtures` 10/10.

**Known limits**

- The §8 request-sentence false findings are recorded as edges. They don't add
  up because they all land on the same chunk (`commercial-reorg.md` chunk 2),
  but a real reorg sentence plus one of them would make two chunks. The §8 fix
  also fixes this.
- Near misses include noise, for example "What should the board be asking?" against
  `series-c-terms.md`. The dashboard draws near-miss-only edges lighter so the
  graph doesn't claim more than detection does.
- `demo_seed.py`'s architecture prompt leaves a near-miss edge on
  `roadmap-2027.md` (§8, architecture docs out of scope).

**Peter's review (Response side), 14 Sep — one disagreement, rest agreed**

Went through the five questions above with Peter directly. Recorded here per
the "note, don't edit" rule — §9 stays proposed until you two agree.

1. **Cumulative tier 2+ to `public_consumer`/`unknown`: disagreement.** Peter
   wants a chance at `sanitize` before `block`, not a hardcoded block. His
   reasoning: `rewrite.py` already refuses upfront when the sensitive content
   is the thing being reasoned about rather than background, and
   `pipeline.py` already downgrades `sanitize` → `block` whenever the rewrite
   is refused or Ollama is unreachable - that fallback doesn't care *why* the
   decision was `sanitize`, so it already gives "try to sanitize, block if
   that doesn't hold up" for free. Concrete proposed change: the "pieced
   together across prompts" rule's `then: block` becomes `then: sanitize`.
   Tier 3 is unaffected either way (it blocks on its own rule regardless of
   confidence). Separately flagged as a real gap, not something to build
   today: neither side currently checks whether the *rewritten* text is still
   a useful prompt - the existing refusal logic is upfront (original
   phrasing), not a check on the rewrite's output. Worth a future pass.
2. **Confidence-less rules matching `cumulative` by default: agreed.**
   Opt-out (write a rule only where cumulative needs to differ) over opt-in
   (every rule enumerates confidence) - opt-in would need a full rule set
   duplicated for cumulative or gaps silently fall through to `allow`.
3. **Credential handling: agreed**, matches what Peter wanted from §8.
4. **`demo_seed.py` architecture prompts: already resolved on `main`**,
   independent of this branch - removed in `5aee5a3` when detection's scope
   was confirmed as the 3 contract types only. Rebasing this branch onto
   current `main` will need to reconcile with that (see below), not re-add
   them.
5. **Teams as demo personas: agreed**, no change needed -
   `demo_seed.py` already uses dana/priya/sam, matching `teams:`. Separately:
   real-user testing vs. team self-testing is an open question Peter raised,
   deliberately not decided here - flagged for later, not blocking this
   branch.

**Also found in review, not a §9 design question but blocks a clean merge:**
this branch forked from `b690976`, which is 3 commits behind current `main`
(`db16ced` pipeline integration, `487bfd8` a corpus bug fix + eligibility
revert in `provenance.py` + eval set expansion, `5aee5a3` the demo rebuild
in point 4 above). A trial merge conflicts in `demo_seed.py`,
`detector/provenance.py`, and `detector/pipeline.py` (8 separate hunks -
both branches independently rewrote `inspect()` from the same starting
point). None of it is unfixable, but whoever merges needs to rebase onto
current `main` first and reconcile by hand, not fast-forward. Worth
resolving together rather than either of us guessing at the other's intent
on the parts that don't touch §9 directly (the finding-dict shape in
particular should follow this branch's version - main's version silently
stopped matching what `extension/content.js` expects).

**After merge, 13 Sep (Hoang Phuc): a pieced-together leak got through the
sanitiser. Fixed on `fix/cumulative-sanitise`, not merged, needs Peter and Chi**

On `a1fca75`, a cumulative finding could send part of the document it was
built from. Reproduced twice:

- **Tier 3.** Review point 1 says tier 3 is unaffected, but rules are first
  match and `pieced together across prompts` sat above `restricted to unknown
  destination`, so tier 3 cumulative to consumer AI was sanitized. `8dbc6a5`
  noted this and relied on the sanitiser's verify loop to fail closed. Dana's
  second acquisition-memo prompt (litigation plus escrow) had the escrow
  sentence redacted and the litigation sentence sent to chatgpt.com.
- **Tier 2.** Priya sends cohort four's dosing schedule, then a prompt that
  repeats it and adds the day-7 liver result. The repeated sentence scored
  higher and was redacted. The day-7 result was sent.

Three causes:

1. A cumulative finding carried one span, the strongest sentence, and the
   sanitiser edits exactly the spans it gets.
2. The verify loop re-runs `detect()`, which never reports near misses, so it
   passes any rewrite of a cumulative finding.
3. `context_edges` counted a sanitised prompt as sending nothing, so sentences
   that went out unedited were missing from later totals.

Fixes, one commit each:

- `292934e`: the rule moved below the restricted rule, so tier 3 blocks.
  This is what review point 1 assumed.
- `d57be24`: one cumulative finding per contributing sentence. For documents
  with a cumulative finding, `sanitiser/service.py` counts near misses left in
  the candidate as residual findings, so leftovers escalate and fail closed to
  block. Two findings on one sentence make one edit, not two. A new
  `context_edges.sent` column records per sentence whether it went out
  unedited; older databases are migrated with their old meaning.

After both: `check_context` 16/16 fixtures and 6/6 sequences, including a new
tier 2 sequence that checks what actually reaches the destination.
`response_fixtures` 10/10, `check_contract` 7/15 (unchanged). `sanitiser_eval`
unchanged apart from latency: `leak_clearance` 0.8, `block_escalation` 0.2.

Still open: sanitising can leave a prompt that is only placeholders, for example when
§8's request-sentence false findings get redacted along with real ones. That's
review point 1's "is the rewrite still a useful prompt" gap.
