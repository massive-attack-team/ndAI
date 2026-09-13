import type { Action, Tier } from "../types";

export type Decision = "pending" | "approved" | "rejected";

/** Separates pages in extracted document text. The "\n" keeps sentences from spanning pages. */
export const PAGE_BREAK = "\n\f\n";

export interface Change {
  id: string;
  index: number;
  kind: "secret" | "passage";
  /** Offsets into ReviewDocument.text. */
  start: number;
  end: number;
  before: string;
  /** Masked preview for credentials; the raw value is only shown on request. */
  masked: string | null;
  after: string;
  tier: Tier;
  title: string;
  reason: string;
  evidence: string | null;
  page: number | null;
  contextBefore: string;
  contextAfter: string;
  decision: Decision;
}

export interface ReviewDocument {
  id: string;
  name: string;
  type: string;
  size: number;
  kind: "pdf" | "text";
  bytes: ArrayBuffer;
  text: string;
  pageCount: number;
  /** True when `text` is mock data standing in for backend extraction. */
  placeholder: boolean;
  verdict: { action: Action; message: string; tier: Tier };
  changes: Change[];
}

export interface ReviewSession {
  id: string;
  createdAt: number;
  host: string;
  tabId: number | null;
  status: "ready" | "approved";
  documents: ReviewDocument[];
  /** Output files, written by the review page just before hand-back. */
  result?: File[];
}

export interface RawFile { name: string; type: string; bytes: ArrayBuffer }

export type InputResult =
  | { name: string; status: "changes"; changes: number; tier: Tier }
  | { name: string; status: "clean" }
  | { name: string; status: "failed"; reason: string };

export interface ReviewSummary {
  id: string;
  url: string;
  host: string;
  /** One entry per submitted file, same order. */
  inputs: InputResult[];
}
