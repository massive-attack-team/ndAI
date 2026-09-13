// Mirrors the /inspect response from detector/main.py (pipeline.Inspection).
// The mock detector and the live service both return this shape, so the UI
// never branches on where a result came from.

export type Action = "allow" | "warn" | "sanitize" | "block";
export type Tier = "green" | "yellow" | "red";
export type DocType = "strategic_plan" | "financial_plan" | "research_report";
export type Confidence = "verbatim" | "paraphrase" | "weak";
export type DestinationClass = "private_local" | "enterprise_vetted" | "public_consumer" | "unknown";

export interface SecretFinding {
  kind: "secret";
  label: string;
  preview: string;
  critical: boolean;
  span: [number, number];
}

export interface DetectionFinding {
  kind: "detection";
  type: DocType;
  sensitivity: 0 | 1 | 2 | 3;
  confidence: Confidence;
  span: [number, number];
  matched_source: string | null;
  score: number | null;
  public_baseline_score: number | null;
  margin: number | null;
  excerpt: string;
}

export type Finding = SecretFinding | DetectionFinding;

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
  event_id?: number | null;
  degraded?: boolean; // set by background.js when the service is unreachable
}
