import { instructionFor } from "../engine/gates";
import type { Flag, Gate, Remediation, Risk, Turn, Verdict } from "../types";

// Mirrored from detector/config.py so the gate readout shows the thresholds the service applies.
const PROVENANCE_HIT = 0.62;
const PUBLIC_MARGIN = 0.105;
const CATEGORY_HIT = 0.71;

// detector/secrets_scan.py LOW_RISK: personal data rather than infrastructure access.
const PII_LABELS = new Set(["Email address", "AU TFN", "Credit card"]);

export interface NdaiFinding {
  kind: "secret" | "provenance" | "category" | "context";
  label: string;
  score?: number;
  public_score?: number;
  margin?: number;
  verbatim?: boolean;
  excerpt?: string;
  critical?: boolean;
  span?: [number, number];
  preview?: string;
  // "context" kind only (detector/context.py's cumulative-exposure finding):
  // how much of the internal document has now gone out, and to whom.
  scope?: "user" | "team";
  chunks_out?: number;
  chunk_total?: number;
  prompts?: number;
  coverage?: number;
}

export interface NdaiEvent {
  id: number;
  ts: number;
  user: string | null;
  role: string | null;
  destination: string | null;
  destination_class: string | null;
  action: string;
  rule: string;
  latency_ms: number;
  preview: string | null;
  findings: NdaiFinding[];
}

export interface NdaiHealth {
  embed_backend: string;
  semantic: boolean;
  rewrite_model_up: boolean;
}

export interface NdaiInspection {
  action: string;
  rule: string;
  message: string;
  latency_ms: number;
  destination_class: string;
  findings: NdaiFinding[];
}

const VERDICT: Record<string, Verdict> = { block: "HALT", sanitize: "MUTATED" };

const code = (label: string) =>
  label
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

const f2 = (n: number | undefined) => (n ?? 0).toFixed(2);

export function fromNdaiEvent(e: NdaiEvent): Turn {
  const verdict = VERDICT[e.action] ?? "PERMIT";
  const halt = verdict === "HALT";
  const preview = e.preview ?? "";
  // audit.redact() keeps offsets intact (same-length masking, newline -> space), then truncates.
  const visible = preview.endsWith("…") ? preview.length - 1 : preview.length;

  const secrets = e.findings.filter((f) => f.kind === "secret");
  const prov = e.findings.find((f) => f.kind === "provenance");
  const cat = e.findings.find((f) => f.kind === "category");
  const ctx = e.findings.find((f) => f.kind === "context");
  const critical = secrets.some((f) => f.critical);

  const flags: Flag[] = secrets.map((f, i) => {
    const risk: Risk = PII_LABELS.has(f.label) ? "PII" : "CREDENTIAL";
    return {
      id: `S${i}-${f.span?.[0] ?? i}`,
      risk,
      rule: `${risk === "PII" ? "PII" : "CRED"}.${code(f.label)}`,
      span: f.span && f.span[1] <= visible ? [f.span[0], f.span[1]] : null,
      confidence: null,
      detail: f.preview,
    };
  });
  if (prov) {
    flags.push({
      id: `P-${prov.label}`,
      risk: "POLICY",
      rule: "PROVENANCE.INTERNAL_MATCH",
      span: null,
      confidence: prov.score ?? null,
      detail: `${prov.label}: ${prov.excerpt ?? ""}`,
    });
  }
  if (ctx) {
    // Piecemeal leak: no single sentence here was enough on its own, but it
    // completes enough of a document already sent across prior prompts.
    flags.push({
      id: `C-${ctx.label}`,
      risk: "POLICY",
      rule: "CONTEXT.CUMULATIVE_EXPOSURE",
      span: null,
      confidence: ctx.coverage ?? null,
      detail: `${ctx.label}: ${ctx.chunks_out ?? 0}/${ctx.chunk_total ?? 0} sections sent by ${ctx.scope ?? "user"} across ${ctx.prompts ?? 0} prompts`,
    });
  }

  const gates: Gate[] = [
    {
      id: "G1",
      key: "REGEX.SECRETS_SCAN",
      tier: "DETERMINISTIC",
      status: secrets.length ? "FAILED" : "PASSED",
      halts: halt && critical,
      latencyMs: null,
      metric: { name: "MATCHES", value: secrets.length, max: 0, kind: "count" },
      note: secrets.length ? secrets.map((f) => f.label.toUpperCase()).join(", ") : "NO CREDENTIAL OR PII PATTERNS",
    },
    {
      id: "G2",
      key: "EMBED.PROVENANCE_BOUNDARY",
      tier: "SEMANTIC",
      status: prov ? "FAILED" : "PASSED",
      halts: halt && !critical && Boolean(prov),
      latencyMs: null,
      metric: prov ? { name: "PUBLIC_MARGIN", value: prov.margin ?? 0, max: PUBLIC_MARGIN, kind: "score" } : undefined,
      note: prov
        ? `${prov.label.toUpperCase()} MATCH ${f2(prov.score)} (HIT ${PROVENANCE_HIT}) VS PUBLIC ${f2(prov.public_score)}`
        : `NO SENTENCE ABOVE ${PROVENANCE_HIT} THAT BEATS PUBLIC BY ${PUBLIC_MARGIN}`,
    },
    {
      id: "G3",
      key: "EMBED.CATEGORY_PROTOTYPE",
      tier: "SEMANTIC",
      status: cat ? "FAILED" : "PASSED",
      latencyMs: null,
      metric: cat ? { name: "SIMILARITY", value: cat.score ?? 0, max: CATEGORY_HIT, kind: "score" } : undefined,
      note: cat ? `READS AS ${code(cat.label)}` : "NO CATEGORY PROTOTYPE MATCHED",
    },
    {
      id: "G4",
      key: "CONTEXT.CUMULATIVE_EXPOSURE",
      tier: "SEMANTIC",
      status: ctx ? "FAILED" : "PASSED",
      halts: halt && !critical && !prov && Boolean(ctx),
      latencyMs: null,
      metric: ctx ? { name: "COVERAGE", value: ctx.coverage ?? 0, max: 1, kind: "score" } : undefined,
      note: ctx
        ? `${ctx.chunks_out ?? 0}/${ctx.chunk_total ?? 0} SECTIONS OF ${code(ctx.label)} OUT ACROSS ${ctx.prompts ?? 0} PROMPTS (${(ctx.scope ?? "user").toUpperCase()})`
        : "NO PRIOR SECTIONS OF THIS DOCUMENT ADD UP YET",
    },
    {
      id: "G5",
      key: "POLICY.RULE_MATCH",
      tier: "POLICY",
      status: halt ? "FAILED" : "PASSED",
      halts: halt,
      latencyMs: null,
      note: `RULE "${e.rule.toUpperCase()}" -> ${e.action.toUpperCase()} (${(e.destination_class ?? "unknown").toUpperCase()})`,
    },
  ];

  const seen = new Set<string>();
  const remediation: Remediation[] = [];
  for (const f of flags) {
    if (seen.has(f.rule)) continue;
    seen.add(f.rule);
    remediation.push({ rule: f.rule, risk: f.risk, trigger: f.detail ?? "", instruction: instructionFor(f.rule, f.risk) });
  }

  return {
    id: `NDA-${e.id.toString(16).toUpperCase().padStart(5, "0")}`,
    ts: e.ts * 1000,
    agent: e.user ?? "unknown",
    upstream: e.destination ?? "unknown",
    raw: preview,
    rawRetained: false,
    source: "LIVE",
    verdict,
    sanitized: halt ? null : preview,
    flags,
    gates,
    remediation,
    overheadMs: e.latency_ms,
  };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} ON ${path}`);
  return (await res.json()) as T;
}

export const fetchHealth = (signal?: AbortSignal) => api<NdaiHealth>("/health", { signal });

export const fetchEvents = async (limit: number, signal?: AbortSignal) =>
  (await api<NdaiEvent[]>(`/events?limit=${limit}`, { signal })).map(fromNdaiEvent);

export const inspectRemote = (text: string, destination: string, signal?: AbortSignal) =>
  api<NdaiInspection>("/inspect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, destination, user: "sandbox", log: false }),
    signal,
  });
