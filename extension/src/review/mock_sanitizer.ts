// ─────────────────────────────────────────────────────────────────────────────
// PLACEHOLDER for the backend document sanitizer. Front end only.
//
// Backend-owned, not built here:
//   • text extraction from PDF/DOCX (and OCR for scans)
//   • detection + policy on that text (detector/ pipeline)
//   • producing the sanitized file from the approved changes (real redaction)
//
// Proposed endpoints (TODO(backend), not implemented anywhere yet):
//   POST /documents/sanitize        file + destination       -> ReviewDocument (without bytes)
//   POST /documents/{id}/apply      { approved: changeId[] } -> sanitized file
//
// Until those exist:
//   • text files go through the in-browser mock detector
//   • PDFs use canned extracted text (the file's contents are ignored)
//   • a "sanitized" PDF comes back as a clearly labelled placeholder .txt
// ─────────────────────────────────────────────────────────────────────────────

import { inspect } from "../detector_client";
import { applyEdits } from "../edits";
import { actionTier, describeFinding, findingTier, minTier, placeholderFor } from "../tiers";
import { PAGE_BREAK, type Change, type InputResult, type RawFile, type ReviewDocument } from "./types";

const MOCK_EXTRACTION_MS = 700;
const SENSITIVITY = ["Public", "Internal", "Confidential", "Restricted"] as const;

// Stand-in for what backend extraction would return for an uploaded board memo.
const MOCK_PDF_PAGES = [
  "Kestrel Bio — Board prep, Q3\nPrepared for the October board meeting. Circulate to directors only.\n\n"
  + "Corporate development\nWe are thinking about buying a microfluidics company for just under four hundred million, mostly cash with some stock, and holding back some of it because of a patent fight. Diligence is being run by the corp dev team with outside counsel.\n\n"
  + "Commercial\nWe are splitting the commercial team into two pods: enterprise accounts running the autoloader, and self-serve registry API customers on the per-seat plan. The change takes effect at the start of next quarter.\n\n"
  + "Next year we want to stop charging per seat and start charging per plate when the autoloader goes generally available.",
  "Research update\nCohort four dosing started this week, testing the intermittent schedule proposed after cohort three: three days on, two days off, versus the continuous dosing used in cohorts one through three.\n\n"
  + "Hepatotoxicity appears above 12 mg/kg. The screening assay itself remains robust, with a Z-factor comfortably above 0.5.\n\n"
  + "Appendix: data room\nQuestions about the data room go to dana@kestrelbio.com.\nWarehouse: postgresql://kestrel:8fh39dkw0slq@db.internal:5432/compounds",
];

export const isPdf = (f: { name: string; type: string }) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function context(text: string, at: number, dir: "before" | "after"): string {
  const LEN = 56;
  if (dir === "before") {
    let s = text.slice(Math.max(0, at - LEN), at);
    if (at > LEN) s = `…${s.replace(/^\S*\s/, "")}`;
    return s.replace(/\s+/g, " ");
  }
  let s = text.slice(at, at + LEN);
  if (at + LEN < text.length) s = `${s.replace(/\s\S*$/, "")}…`;
  return s.replace(/\s+/g, " ");
}

async function buildDocument(file: RawFile, host: string, id: string): Promise<ReviewDocument | null> {
  const pdf = isPdf(file);
  let text: string;
  if (pdf) {
    await sleep(MOCK_EXTRACTION_MS); // TODO(backend): POST /documents/sanitize
    text = MOCK_PDF_PAGES.join(PAGE_BREAK);
  } else {
    text = new TextDecoder().decode(file.bytes);
  }
  if (!text.trim()) throw new Error("The file is empty.");

  const result = await inspect(text, host);
  const cap = actionTier(result.action);

  // Card previews are built from a copy with credentials masked (same length,
  // so offsets line up), so a key next to a flagged passage isn't shown in full.
  let shown = text;
  for (const f of result.findings) {
    if (f.kind !== "secret") continue;
    const [a, b] = f.span;
    const raw = text.slice(a, b);
    const mask = raw.length <= 8 ? "•".repeat(raw.length) : `${raw.slice(0, 4)}${"•".repeat(raw.length - 8)}${raw.slice(-4)}`;
    shown = shown.slice(0, a) + mask + shown.slice(b);
  }

  const changes: Change[] = [];
  const ordered = [...result.findings].sort((a, b) => a.span[0] - b.span[0] || b.span[1] - a.span[1]);
  for (const f of ordered) {
    const own = findingTier(f);
    if (!own) continue;
    const tier = minTier(own, cap); // destination policy caps the tier, same as the inline flow
    if (tier === "green") continue;

    const [start, end] = f.span;
    const copy = describeFinding(f);
    const index = changes.length + 1;
    changes.push({
      id: `${id}-c${index}`,
      index,
      kind: f.kind === "secret" ? "secret" : "passage",
      start,
      end,
      before: f.kind === "secret" ? text.slice(start, end) : shown.slice(start, end),
      masked: f.kind === "secret" ? f.preview : null,
      after: f.kind === "secret"
        ? placeholderFor(f.label)
        : `[${SENSITIVITY[f.sensitivity]} ${f.type.replace("_", " ")} passage removed]`,
      tier,
      title: copy.title,
      reason: copy.detail,
      evidence: f.kind === "secret" ? null : copy.evidence,
      page: pdf ? text.slice(0, start).split("\f").length : null,
      contextBefore: context(shown, start, "before"),
      contextAfter: context(shown, end, "after"),
      decision: "pending",
    });
  }
  if (!changes.length) return null;

  return {
    id, name: file.name, type: file.type, size: file.bytes.byteLength,
    kind: pdf ? "pdf" : "text", bytes: file.bytes, text,
    pageCount: pdf ? MOCK_PDF_PAGES.length : 1,
    placeholder: pdf,
    verdict: { action: result.action, message: result.message, tier: cap },
    changes,
  };
}

export async function sanitizeFiles(files: RawFile[], host: string): Promise<{ documents: ReviewDocument[]; inputs: InputResult[] }> {
  const documents: ReviewDocument[] = [];
  const inputs: InputResult[] = [];
  for (const [i, file] of files.entries()) {
    try {
      const doc = await buildDocument(file, host, `d${i + 1}`);
      if (!doc) { inputs.push({ name: file.name, status: "clean" }); continue; }
      documents.push(doc);
      inputs.push({ name: file.name, status: "changes", changes: doc.changes.length, tier: doc.verdict.tier });
    } catch (err) {
      inputs.push({ name: file.name, status: "failed", reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { documents, inputs };
}

const safeName = (name: string) => name.replace(/(\.[^.]+)?$/, ".sanitized$1");

/** Approved changes -> the file that gets uploaded. TODO(backend): POST /documents/{id}/apply */
export async function buildOutput(doc: ReviewDocument): Promise<File> {
  const approved = doc.changes.filter((c) => c.decision === "approved");
  const sanitized = applyEdits(doc.text, approved.map((c) => ({ start: c.start, end: c.end, replacement: c.after })));

  if (doc.kind === "text") {
    const type = doc.type || "text/plain";
    return approved.length ? new File([sanitized], safeName(doc.name), { type }) : new File([doc.bytes], doc.name, { type });
  }

  // PLACEHOLDER. Never pass the original PDF through here: it still contains
  // everything that was flagged. The backend returns the real sanitized PDF.
  const kept = doc.changes.length - approved.length;
  const body = [
    `NDAi MOCK OUTPUT — placeholder for the backend's sanitized copy of ${doc.name}.`,
    `${approved.length} change(s) applied, ${kept} kept. Text below is mock extraction, not the uploaded file.`,
    "",
    sanitized.replace(/\f/g, "———— page break ————"),
  ].join("\n");
  return new File([body], `${doc.name.replace(/\.pdf$/i, "")}.sanitized.mock.txt`, { type: "text/plain" });
}
