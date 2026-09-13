# NDAi

A local semantic firewall for AI prompts. It checks what an employee is about to
send to an external AI assistant, decides using company-specific knowledge rather
than pattern matching, and either allows it, rewrites it to the minimum necessary
context, or stops it. The check runs on the employee's machine.

**The NDA your AI assistant actually reads.**

---

## What is actually new here

Pattern-based DLP catches credentials and PII. Semantic DLP products catch
categories: "this looks like source code", "this looks financial". Neither
answers the question that matters to a research lab:

> Is this text derived from *our* confidential material?

NDAi answers that with a local provenance index over the company's own
documents, and it does it against a second index of public material in the same
field. That second index is the part most people skip. Without it, a detector
built on an oncology corpus flags every sentence a biologist writes about
oncology, the false positive rate makes the tool unusable, and people turn it off.

Everything else in this repo (policy engine, rewriting, dashboard) is scaffolding
around that one claim, and `eval/` exists to test it.

---

## Setup

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Pull the local rewrite model. Do this before the hackathon wifi does.
ollama pull qwen2.5:3b-instruct

python -m detector.main          # http://127.0.0.1:8000
python demo_seed.py              # populate the audit log

cd dashboard && npm install && npm run dev   # http://localhost:5173
```

Then build the extension and load it:

```bash
cd extension && npm install && npm run build   # TypeScript -> extension/dist/
npm run preview                                # fake chat page: http://localhost:8787/preview/
```

Load `extension/` at `chrome://extensions` with Developer mode on, click the
NDAi toolbar icon, press **Activate NDAi**, and type or paste something from
`corpus/internal/` into ChatGPT. The extension uses an in-browser mock detector
by default (`extension/src/config.ts`); set `DETECTOR_MODE = "live"` to call the
local service instead.

### If you skip `sentence-transformers`

The embedder falls back to character n-gram hashing. It runs, the plumbing works,
and paraphrase detection is **off**. Every surface says so: the service logs a
warning, `/health` returns `semantic: false`, the extension toasts, the dashboard
shows it. Never demo on the fallback.

---

## How a prompt is judged

```
text ─▶ 1. secrets      regex + Shannon entropy      credentials, PII
      ─▶ 2. provenance  cosine vs internal corpus    minus best public match
      ─▶ 3. category    prototype embeddings         what kind of thing is this
      ─▶ 4. policy      policy.yaml, first match     sensitivity x destination x role
      ─▶ 5. rewrite     local Ollama                 only when policy says sanitize
```

Provenance scores **per sentence**, not per prompt. A 500-word prompt with two
leaked lines averages down to nothing if you embed the whole thing at once.

Risk is never a property of the text alone. The same paragraph is fine going to
the internal model, logged going to a vendor under contract, and blocked going to
a personal ChatGPT account. That lives in `policy.yaml` so a security lead can
read it without reading Python.

---

## Limits we state out loud

**Rewriting cannot save a reasoning task.** If the confidential content is
*context* for the task (help me structure this, clean up this draft), a minimum
context rewrite preserves the help. If the confidential content *is* the problem
(verify this proof step, why does this assay result look wrong), no rewrite
preserves the task. `rewrite.py` detects this case and refuses rather than
producing something useless. The honest answer there is the internal model.

**Placeholders are not protection.** "[COMPANY] will acquire [TARGET] for
[AMOUNT]" still discloses that there is a secret acquisition. The rewrite changes
what is being asked, not just the nouns.

**This does not stop a frontier lab from competing with its customers.** That is
a contract and jurisdiction problem. NDAi stops the accidental disclosure:
the pasted `.env`, the draft board memo, the internal schema. Say so in the pitch
before a judge says it for you.

**Interception is shallow on purpose.** Paste and send, not `fetch` monkey
patching. Deeper hooks catch more and break the host page every time it ships a
change, and a tool that breaks ChatGPT gets uninstalled the same week.

**Research freshness is local-only for now.** The public corpus is built in
advance, not fetched live, so a paper published after the corpus was last
refreshed won't be recognized as already-public — a false positive on
genuinely public research. Live web lookup at inspection time would fix that,
but it means the detector calls out to the internet before a decision is made:
the opposite of "nothing leaves this machine until you approve it," and a new
leak surface in its own right (the query itself discloses what you're asking
about). Worth revisiting once the static-corpus approach is proven; not in
scope for v1.

---

## Evaluation

```bash
python -m eval.run_eval
```

Three systems on the same labelled prompts: pattern scanner, generic category
classifier, full pipeline. Reports recall by class and false positive rate by
class.

Only two numbers decide whether this works:

1. **Paraphrase recall.** Verbatim detection is trivial. Anyone can do it.
2. **False positive rate on `public_domain`.** These are hard negatives: the same
   subject matter written from public sources. A detector that flags them has
   learned the topic, not the provenance.

`eval/dataset.py` ships ~40 seed prompts. Expand to 200+ before quoting numbers,
and keep the class balance: hard negatives should be roughly a third of the set.

Thresholds in `config.py` are tuned for the sentence-transformers backend. They
need re-tuning if you change the embedding model or the corpus.

---

## Layout

```
detector/       local inspection service (FastAPI, 127.0.0.1 only)
  secrets_scan  stage 1, patterns and entropy
  provenance    stage 2, company-specific matching. the novel part
  categories    stage 3, prototype embeddings, no training
  policy        stage 4, evaluates policy.yaml
  rewrite       stage 5, local Ollama
  audit         SQLite log, hashes and redacted previews, not raw text
extension/      Chrome MV3, intercepts paste and send
dashboard/      Vite + React, live stream and the three-way comparison
eval/           labelled dataset and metrics harness
corpus/internal fake company confidential material
corpus/public   hard negatives, same field, public sources
policy.yaml     the rules, readable by a security lead
```

The audit log stores a SHA-256 and a redacted preview, not the prompt. Keeping
raw text would build one database holding every confidential thing anyone nearly
leaked, which is the exposure this product exists to prevent.

---

## Next, in rough order of value

1. Expand `eval/dataset.py` to 200+ prompts and re-tune thresholds on the results.
2. Corpus ingestion from a real source (Drive, Confluence, a repo) instead of a
   folder, with incremental re-indexing.
3. Per-sentence highlighting in the extension, so the user sees which line tripped
   it rather than a verdict on the whole paste.
4. Approval workflow for `block`: request an exception, route to a reviewer.
5. Forward proxy build for coverage beyond the browser (IDE assistants, CLI tools).
