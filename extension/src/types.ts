// Mirrors the /inspect response from detector/main.py (pipeline.Inspection).
// The mock detector and the live service both return this shape, so the UI
// never branches on where a result came from.
//
// Source of truth: detector/pipeline.py's _finding_dict() - four finding
// kinds, not two. "detection" was never a real kind the backend returns;
// don't reintroduce it.

export type Action = "allow" | "warn" | "sanitize" | "block";
export type Tier = "green" | "yellow" | "red";
export type DocType = "strategic_plan" | "financial_plan" | "research_report";
export type Confidence = "verbatim" | "paraphrase" | "weak" | "cumulative";
export type DestinationClass = "private_local" | "enterprise_vetted" | "public_consumer" | "unknown";

export interface SecretFinding {
  kind: "secret";
  label: string;
  preview: string;
  critical: boolean;
  span: [number, number];
}

/** Fields every non-secret finding carries, per CONTRACT.md #2/#9. */
interface DetectionBase {
  type: DocType;
  tier: 0 | 1 | 2 | 3;
  span: [number, number];
}

/** Verbatim or paraphrase - matched a specific internal document. */
export interface ProvenanceFinding extends DetectionBase {
  kind: "provenance";
  confidence: "verbatim" | "paraphrase";
  label: string; // matched_source
  score: number;
  public_score: number | null;
  margin: number | null;
  verbatim: boolean;
  excerpt: string;
}

/** Weak - type signal only, no corpus match cleared the margin. */
export interface CategoryFinding extends DetectionBase {
  kind: "category";
  confidence: "weak";
  label: string; // == type
  score: number | null;
}

/** Cumulative - pieced together across prompts (detector/context.py, CONTRACT.md #9). */
export interface ContextFinding extends DetectionBase {
  kind: "context";
  confidence: "cumulative";
  label: string; // matched_source, the document being pieced together
  scope: "user" | "team";
  chunks_out: number;
  chunk_total: number;
  prompts: number;
  coverage: number;
}

export type Finding = SecretFinding | ProvenanceFinding | CategoryFinding | ContextFinding;

export interface Inspection {
  action: Action;
  rule: string;
  message: string;
  findings: Finding[];
  sensitivity?: number;
  risk?: number;
  latency_ms?: number;
  destination_class?: DestinationClass;
  rewritten?: string | null;
  rewrite_note?: string;
  baselines?: Record<string, string>;
  /** Per-exposure context summary (pipeline.py's Inspection.context) - one entry per doc/destination this prompt touches, not just escalated ones. */
  context?: Array<Record<string, unknown>>;
  /** Present when action === "sanitize" and the sanitiser package (not the old rewrite.py) handled it. */
  sanitiser?: Record<string, unknown>;
  event_id?: number | null;
  degraded?: boolean; // set by background.js when the service is unreachable
}
