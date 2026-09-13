// File intake: <input type=file> changes, drag-and-drop, and pasted files.
//
// Each path is caught in the window capture phase — before React/Vue handlers
// on the page root — held while files are reviewed, then re-dispatched with
// either the originals or safe copies. The re-dispatched event is marked so
// it passes through untouched.

import { inspect } from "./detector_client";
import { redactFindings } from "./mock_detector";
import { actionTier } from "./tiers";
import type { Tier } from "./types";

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|env|ini|cfg|conf|log|sql|py|js|ts|tsx|jsx|java|go|rb|rs|c|cc|cpp|h|cs|php|sh)$/i;
const MAX_TEXT_BYTES = 2_000_000;

export interface FileReview {
  file: File;
  tier: Tier;
  headline: string;
  detail: string;
  safe: File | null;
}

const isTextual = (f: File) =>
  f.type.startsWith("text/") || /json|xml|yaml|csv|javascript/.test(f.type) || TEXT_EXT.test(f.name);

const isPdf = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);

/** PDFs and text files go through the review page; everything else uses the inline panel. */
export const isDocument = (f: File) => isPdf(f) || isTextual(f);

const safeName = (name: string) => name.replace(/(\.[^.]+)?$/, ".redacted$1");

export async function reviewFile(file: File): Promise<FileReview> {
  if (!isTextual(file)) {
    const kind = file.type.startsWith("image/") ? "Image" : file.type === "application/pdf" ? "PDF" : "Binary file";
    return {
      file, tier: "yellow", safe: null, headline: "Not inspected",
      detail: `${kind} text extraction isn't part of the mock. The real build OCRs/extracts it before this check.`,
    };
  }
  if (file.size > MAX_TEXT_BYTES) {
    return { file, tier: "yellow", safe: null, headline: "Not inspected", detail: "Too large to check in the browser." };
  }

  const text = await file.text();
  const result = await inspect(text);
  const tier = actionTier(result.action);
  if (tier === "green") return { file, tier, safe: null, headline: "Nothing sensitive found", detail: "" };

  const safeText = result.rewritten ?? redactFindings(text, result.findings);
  const n = result.findings.length;
  return {
    file, tier,
    headline: `${n} finding${n === 1 ? "" : "s"}`,
    detail: result.message,
    safe: new File([safeText], safeName(file.name), { type: file.type || "text/plain", lastModified: Date.now() }),
  };
}

function dataTransferOf(files: File[]): DataTransfer {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  return dt;
}

export interface UploadGuardOptions {
  isActive(): boolean;
  /** Resolve with the files to let through, or null to cancel the upload. */
  review(files: File[]): Promise<File[] | null>;
}

export function installUploadGuard({ isActive, review }: UploadGuardOptions): void {
  const passthrough = new WeakSet<Event>();
  const skip = (e: Event) => !isActive() || passthrough.has(e);

  const redispatch = (target: EventTarget, make: () => Event) => {
    const ev = make();
    passthrough.add(ev);
    target.dispatchEvent(ev);
  };

  // <input type="file">. `input` fires just before `change`; both are held.
  const onFileInput = (e: Event) => {
    const input = e.composedPath()[0];
    if (skip(e) || !(input instanceof HTMLInputElement) || input.type !== "file" || !input.files?.length) return;
    e.stopImmediatePropagation();
    if (e.type !== "change") return;

    void review(Array.from(input.files)).then((chosen) => {
      if (!chosen?.length) { input.value = ""; return; }
      input.files = dataTransferOf(chosen).files;
      redispatch(input, () => new Event("input", { bubbles: true, composed: true }));
      redispatch(input, () => new Event("change", { bubbles: true }));
    });
  };
  window.addEventListener("input", onFileInput, true);
  window.addEventListener("change", onFileInput, true);

  window.addEventListener("drop", (e) => {
    const files = e.dataTransfer?.files;
    if (skip(e) || !files?.length) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const target = e.composedPath()[0] ?? document.body;
    const { clientX, clientY } = e;
    void review(Array.from(files)).then((chosen) => {
      if (!chosen?.length) return;
      redispatch(target, () => new DragEvent("drop", {
        bubbles: true, cancelable: true, composed: true, clientX, clientY, dataTransfer: dataTransferOf(chosen),
      }));
    });
  }, true);

  // Only file-only pastes (screenshots). Rich pastes that also carry text/plain
  // go through untouched; their text is picked up by the inline underline flow.
  window.addEventListener("paste", (e) => {
    const data = e.clipboardData;
    if (skip(e) || !data?.files.length || data.types.includes("text/plain")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const target = e.composedPath()[0] ?? document.body;
    void review(Array.from(data.files)).then((chosen) => {
      if (!chosen?.length) return;
      redispatch(target, () => new ClipboardEvent("paste", {
        bubbles: true, cancelable: true, composed: true, clipboardData: dataTransferOf(chosen),
      }));
    });
  }, true);
}
