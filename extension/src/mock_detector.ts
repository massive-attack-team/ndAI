// In-browser stand-in for POST /inspect. Front-end only: nothing here is
// imported by, or changes, the Python service.
//
//   Stage 1  secrets   — a direct port of detector/secrets_scan.py
//   Stage 2  detection — keyword rules shaped like the demo_seed.py scenarios,
//                        returning CONTRACT.md §2 findings (type, tier, confidence)
//   Stage 3  policy    — policy.yaml's rule table, first match wins
//
// Scores are fixed per rule. They exist so the evidence line in the UI has
// realistic content, not to approximate the embedding model.

import { applyEdits, type Edit } from "./edits";
import { placeholderFor } from "./tiers";
import type {
  Action, Confidence, DestinationClass, DetectionFinding, DocType, Finding, Inspection, SecretFinding,
} from "./types";

const MOCK_LATENCY_MS = 140; // long enough to exercise out-of-order responses

// ---- Stage 1: secrets (detector/secrets_scan.py) ---------------------------

const SECRET_RULES: Array<[string, RegExp]> = [
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ["OpenAI key", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ["Private key block", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ["Connection string", /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^\s:@]+:[^\s:@]+@\S+/g],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ["Email address", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ["Credit card", /\b(?:\d[ -]*?){13,16}\b/g],
  ["AU TFN", /\b\d{3}\s?\d{3}\s?\d{3}\b/g],
];
const ASSIGNMENT = /\b(api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key)\b\s*[:=]\s*["']?([^\s"',;]{12,})/gi;
const LOW_RISK = new Set(["Email address", "AU TFN", "Credit card"]);

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

const mask = (s: string) => (s.length <= 8 ? "*".repeat(s.length) : `${s.slice(0, 4)}${"*".repeat(s.length - 8)}${s.slice(-4)}`);

export function scanSecrets(text: string): SecretFinding[] {
  const found: SecretFinding[] = [];
  const seen = new Set<string>();
  const add = (label: string, start: number, end: number, preview: string, critical: boolean) => {
    const key = `${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ kind: "secret", label, preview, critical, span: [start, end] });
  };
  for (const [label, rx] of SECRET_RULES) {
    for (const m of text.matchAll(rx)) add(label, m.index, m.index + m[0].length, mask(m[0]), !LOW_RISK.has(label));
  }
  for (const m of text.matchAll(ASSIGNMENT)) {
    if (entropy(m[2]) < 3.0) continue;
    add(`High-entropy ${m[1].toLowerCase()}`, m.index, m.index + m[0].length, mask(m[2]), true);
  }
  return found;
}

// ---- Stage 2: detection -----------------------------------------------------

interface CorpusRule {
  source: string | null;
  type: DocType;
  sensitivity: 0 | 1 | 2 | 3;
  confidence: Confidence;
  score: number | null;
  publicScore: number | null;
  signals: RegExp[];
  minHits: number;
  /** Phrase-level generalisations used to build the mock "safe version". */
  generalize?: Array<[RegExp, string]>;
}

const CORPUS_RULES: CorpusRule[] = [
  {
    source: "financial_plan/acquisition-memo.md", type: "financial_plan", sensitivity: 3,
    confidence: "paraphrase", score: 0.74, publicScore: 0.41, minHits: 2,
    signals: [/microfluidic/i, /\b(?:acquir\w*|buy(?:ing)?|purchas\w*)\b/i,
      /four hundred million|\$\s?\d{3}\s?(?:m|million)\b/i, /hold(?:ing)? back|holdback|escrow/i, /patent/i],
    generalize: [[/a microfluidics company/gi, "a company"], [/\s*for just under four hundred million/gi, ""],
      [/,\s*mostly cash with some stock,?/gi, ""], [/,?\s*and holding back some of it because of a patent fight/gi, " with standard deal protections"]],
  },
  {
    source: "financial_plan/series-c-terms.md", type: "financial_plan", sensitivity: 3,
    confidence: "paraphrase", score: 0.71, publicScore: 0.44, minHits: 2,
    signals: [/series c/i, /pre-money|post-money|valuation/i, /liquidation preference|term sheet/i, /lead investor|led by/i],
  },
  {
    source: "strategic_plan/roadmap-2027.md", type: "strategic_plan", sensitivity: 3,
    confidence: "paraphrase", score: 0.72, publicScore: 0.39, minHits: 2,
    signals: [/per[- ]plate/i, /per[- ]seat/i, /autoloader/i, /generally available|\bGA\b/, /\bpric(?:e|ing)\b/i],
    generalize: [[/stop charging per seat and start charging per plate when the autoloader goes generally available/gi,
      "change our pricing model when a new product launches"]],
  },
  {
    source: "strategic_plan/commercial-reorg.md", type: "strategic_plan", sensitivity: 2,
    confidence: "verbatim", score: 0.93, publicScore: 0.36, minHits: 2,
    signals: [/commercial team/i, /\bpods?\b/i, /enterprise accounts/i, /self-serve/i, /registry API/i],
    generalize: [[/splitting the commercial team into two pods: enterprise accounts running the autoloader, and self-serve registry API customers on the per-seat plan/gi,
      "reorganizing a sales team by customer segment"]],
  },
  {
    source: "research_report/experiment-results-q3.md", type: "research_report", sensitivity: 3,
    confidence: "verbatim", score: 0.95, publicScore: 0.47, minHits: 2,
    signals: [/hepatotox/i, /mg\/kg/i, /\bALT\b/, /high[- ]dose arm/i, /upper limit of normal/i, /dose[- ]dependent/i],
  },
  {
    source: "research_report/cohort-four-interim.md", type: "research_report", sensitivity: 2,
    confidence: "verbatim", score: 0.94, publicScore: 0.33, minHits: 2,
    signals: [/cohort (?:four|4)/i, /intermittent (?:schedule|dosing)/i, /three days on,? two days off/i,
      /continuous dosing/i, /cohorts? (?:one|two|three|1|2|3)\b/i],
    generalize: [[/Cohort four dosing started this week/gi, "A new dosing cohort is starting"],
      [/,?\s*testing the intermittent schedule proposed after cohort three: three days on, two days off, versus the continuous dosing used in cohorts one through three/gi,
        ", comparing an intermittent schedule against continuous dosing"]],
  },
];

// Type signal only, no corpus match (CONTRACT.md §4 "weak"). Only consulted
// when no corpus rule fires on the sentence.
const WEAK_RULES: CorpusRule[] = [
  { source: null, type: "financial_plan", sensitivity: 2, confidence: "weak", score: null, publicScore: null, minHits: 2,
    signals: [/\b(?:EBITDA|burn rate|runway|gross margin)\b/i, /\b(?:forecast|projection|guidance|budget)\b/i, /\b(?:next quarter|FY\d{2}|Q[1-4])\b/] },
  { source: null, type: "research_report", sensitivity: 2, confidence: "weak", score: null, publicScore: null, minHits: 2,
    signals: [/\bunpublished\b/i, /\binterim (?:results|data|readout)\b/i, /\bp\s?[<=]\s?0?\.\d+/i, /\b(?:cohort|dose arm|trial)\b/i] },
  { source: null, type: "strategic_plan", sensitivity: 2, confidence: "weak", score: null, publicScore: null, minHits: 2,
    signals: [/\b(?:confidential|internal only|do not share|not yet announced|unannounced)\b/i, /\b(?:roadmap|launch|reorg|layoffs?|market entry|pricing)\b/i] },
];

interface Hit { finding: DetectionFinding; rule: CorpusRule }

// A "." followed by a digit is a decimal, not a sentence end.
const SENTENCE = /(?:[^.!?\n]|\.(?=\d))+[.!?]*/g;

function bestRule(sentence: string, rules: CorpusRule[]): CorpusRule | null {
  let best: CorpusRule | null = null;
  let bestHits = 0;
  for (const rule of rules) {
    const hits = rule.signals.filter((rx) => rx.test(sentence)).length;
    if (hits < rule.minHits) continue;
    if (hits > bestHits || (hits === bestHits && best && rule.sensitivity > best.sensitivity)) {
      best = rule;
      bestHits = hits;
    }
  }
  return best;
}

export function detect(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(SENTENCE)) {
    const raw = m[0];
    const body = raw.trim();
    if (body.length < 12) continue;
    const rule = bestRule(body, CORPUS_RULES) ?? bestRule(body, WEAK_RULES);
    if (!rule) continue;
    const start = m.index + (raw.length - raw.trimStart().length);
    hits.push({
      rule,
      finding: {
        kind: "detection", type: rule.type, sensitivity: rule.sensitivity, confidence: rule.confidence,
        span: [start, start + body.length], matched_source: rule.source, score: rule.score,
        public_baseline_score: rule.publicScore,
        margin: rule.score != null && rule.publicScore != null ? +(rule.score - rule.publicScore).toFixed(2) : null,
        excerpt: `${body.split(/\s+/).slice(0, 5).join(" ")}…`,
      },
    });
  }
  return hits;
}

// ---- Stage 3: policy (policy.yaml) ------------------------------------------

const DESTINATIONS: Record<Exclude<DestinationClass, "unknown">, string[]> = {
  private_local: ["localhost", "ollama.internal", "llm.kestrelbio.internal"],
  enterprise_vetted: ["console.anthropic.com", "platform.openai.com", "bedrock.aws.amazon.com"],
  public_consumer: ["chatgpt.com", "chat.openai.com", "claude.ai", "gemini.google.com", "copilot.microsoft.com", "perplexity.ai"],
};

export function classifyDestination(host: string): DestinationClass {
  for (const [cls, hosts] of Object.entries(DESTINATIONS) as Array<[DestinationClass, string[]]>) {
    if (hosts.some((d) => host === d || host.endsWith(`.${d}`))) return cls;
  }
  return "unknown";
}

interface PolicyRule {
  name: string;
  when: { critical?: true; confidence?: Confidence[]; minSensitivity?: number; destinations?: DestinationClass[] };
  then: Action;
  message: string;
}

const POLICY: PolicyRule[] = [
  { name: "credentials never leave", when: { critical: true }, then: "block",
    message: "A live credential was found in this text. Rotate it if it has already been sent anywhere." },
  { name: "weak signal, unconfirmed", when: { confidence: ["weak"], minSensitivity: 2 }, then: "warn",
    message: "Reads like it could be sensitive material, but there's no confirmed match to internal documents. Logged for review rather than blocked on a guess." },
  { name: "restricted to unknown destination", when: { minSensitivity: 3, destinations: ["unknown", "public_consumer"] }, then: "block",
    message: "Restricted material cannot go to a consumer AI product. Use the internal model, or ask for an exception." },
  { name: "restricted to vetted vendor", when: { minSensitivity: 3, destinations: ["enterprise_vetted"] }, then: "sanitize",
    message: "Restricted material. Sending a minimum-context version instead." },
  { name: "confidential to consumer AI", when: { minSensitivity: 2, destinations: ["public_consumer", "unknown"] }, then: "sanitize",
    message: "This looks like internal material. Sending a minimum-context version instead." },
  { name: "confidential to vetted vendor", when: { minSensitivity: 2, destinations: ["enterprise_vetted"] }, then: "warn",
    message: "Confidential, but the destination is covered by an enterprise agreement. Logged." },
  { name: "internal to private model", when: { minSensitivity: 1, destinations: ["private_local"] }, then: "allow",
    message: "Stays on the network." },
  { name: "default", when: {}, then: "allow", message: "Nothing sensitive detected." },
];

const SEVERITY: Action[] = ["allow", "warn", "sanitize", "block"];

function evaluate(subject: { sensitivity: number; confidence?: Confidence; critical?: boolean }, dest: DestinationClass): PolicyRule {
  return POLICY.find(({ when: w }) =>
    (!w.critical || subject.critical) &&
    (!w.confidence || (subject.confidence !== undefined && w.confidence.includes(subject.confidence))) &&
    (w.minSensitivity === undefined || subject.sensitivity >= w.minSensitivity) &&
    (!w.destinations || w.destinations.includes(dest)),
  )!;
}

// ---- rewrite ----------------------------------------------------------------

const FIGURE = /(?<![\w\-[])(?:\$\s?)?\d+(?:[.,]\d+)*\s?(?:%|mg\/kg|million|billion|bn\b|m\b|k\b)?/gi;

function rewrite(text: string, secrets: SecretFinding[], hits: Hit[]): string {
  const edits: Edit[] = secrets.map((s) => ({ start: s.span[0], end: s.span[1], replacement: placeholderFor(s.label) }));
  for (const { finding, rule } of hits) {
    const [a, b] = finding.span;
    let chunk = text.slice(a, b);
    for (const [rx, to] of rule.generalize ?? []) chunk = chunk.replace(rx, to);
    edits.push({ start: a, end: b, replacement: chunk.replace(FIGURE, "[figure]") });
  }
  return applyEdits(text, edits, true);
}

/** Span-level redaction for file uploads, where the policy may block but a safe copy is still wanted. */
export function redactFindings(text: string, findings: Finding[]): string {
  return applyEdits(text, findings.map((f) => ({
    start: f.span[0], end: f.span[1],
    replacement: f.kind === "secret" ? placeholderFor(f.label) : `[${f.type.replace("_", " ")} passage removed]`,
  })));
}

// ---- entry point --------------------------------------------------------------

const RISK_WEIGHT: Record<DestinationClass, number> = {
  private_local: 0.15, enterprise_vetted: 0.45, public_consumer: 0.85, unknown: 1,
};

export async function mockInspect(text: string, destination: string): Promise<Inspection> {
  const started = performance.now();
  const dest = classifyDestination(destination);
  const secrets = scanSecrets(text);
  const hits = detect(text);

  const critical = secrets.some((s) => s.critical);
  const secretSensitivity = critical ? 3 : secrets.length ? 2 : 0;
  const sensitivity = Math.max(secretSensitivity, ...hits.map((h) => h.finding.sensitivity));

  // pipeline.py evaluates secrets and detection separately; the more severe wins.
  const decisions = [
    evaluate({ sensitivity: secretSensitivity, critical }, dest),
    ...hits.map((h) => evaluate({ sensitivity: h.finding.sensitivity, confidence: h.finding.confidence }, dest)),
  ];
  const decision = decisions.reduce((a, b) => (SEVERITY.indexOf(b.then) > SEVERITY.indexOf(a.then) ? b : a));

  const rewritten = decision.then === "sanitize" ? rewrite(text, secrets, hits) : null;
  await new Promise((r) => setTimeout(r, MOCK_LATENCY_MS));

  return {
    action: decision.then,
    rule: decision.name,
    message: decision.message,
    sensitivity,
    risk: +Math.min(1, (sensitivity / 3) * RISK_WEIGHT[dest]).toFixed(2),
    latency_ms: +(performance.now() - started).toFixed(1),
    destination_class: dest,
    findings: [...secrets, ...hits.map((h) => h.finding)],
    rewritten,
    rewrite_note: rewritten ? "Mock rewrite: specifics generalised in the browser." : "",
    event_id: null,
  };
}
