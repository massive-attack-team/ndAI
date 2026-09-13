export type Verdict = "PERMIT" | "MUTATED" | "HALT";

export type Risk = "CREDENTIAL" | "INJECTION" | "POLICY" | "DRIFT" | "PII";

/** Most severe first. Used for sorting chips and picking a highlight colour. */
export const RISK_ORDER: Risk[] = ["CREDENTIAL", "INJECTION", "POLICY", "DRIFT", "PII"];

export type GateStatus = "PASSED" | "FAILED" | "BYPASS";

export type GateTier = "DETERMINISTIC" | "SEMANTIC" | "CONSENSUS" | "POLICY";

export type Source = "SIM" | "LIVE";

export interface Flag {
  id: string;
  risk: Risk;
  rule: string;
  /** Offsets into the raw payload. Null when the evidence has no position (e.g. a corpus match). */
  span: [number, number] | null;
  /** Null when the producing gate does not score (plain regex in the ndAI detector). */
  confidence: number | null;
  /** Placeholder written into the sanitized payload. */
  replacement?: string;
  detail?: string;
}

export interface Metric {
  name: string;
  value: number;
  max: number;
  kind: "count" | "score";
}

export interface Vote {
  validator: string;
  score: number;
  reject: boolean;
}

export interface Gate {
  id: string;
  key: string;
  tier: GateTier;
  status: GateStatus;
  /** Null when the source only records a per-turn total. */
  latencyMs: number | null;
  metric?: Metric;
  votes?: Vote[];
  note: string;
  /** This gate is one of the reasons the turn was halted. */
  halts?: boolean;
}

export interface Remediation {
  rule: string;
  risk: Risk;
  trigger: string;
  instruction: string;
}

export interface Evaluation {
  verdict: Verdict;
  /** Null when nothing was forwarded upstream. */
  sanitized: string | null;
  flags: Flag[];
  gates: Gate[];
  remediation: Remediation[];
  overheadMs: number;
}

export interface Turn extends Evaluation {
  id: string;
  ts: number;
  agent: string;
  upstream: string;
  raw: string;
  source: Source;
  /** False for ndAI audit rows, which only keep a redacted preview. */
  rawRetained: boolean;
}

export interface AgentContext {
  toolRegistry: readonly string[];
  grounding: readonly string[];
}
