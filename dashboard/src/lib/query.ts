import type { Risk, Turn, Verdict } from "../types";

type Predicate = (turn: Turn) => boolean;

export interface ParsedQuery {
  test: Predicate;
  errors: string[];
}

const STATUS: Record<string, Verdict> = {
  blocked: "HALT",
  block: "HALT",
  halt: "HALT",
  halted: "HALT",
  redacted: "MUTATED",
  mutated: "MUTATED",
  sanitized: "MUTATED",
  passed: "PERMIT",
  permit: "PERMIT",
  allowed: "PERMIT",
  allow: "PERMIT",
};

const RISK: Record<string, Risk> = {
  pii: "PII",
  injection: "INJECTION",
  inj: "INJECTION",
  jailbreak: "INJECTION",
  drift: "DRIFT",
  hallucination: "DRIFT",
  credential: "CREDENTIAL",
  cred: "CREDENTIAL",
  secret: "CREDENTIAL",
  policy: "POLICY",
  pol: "POLICY",
};

// -field:value | field:"quoted value" | "quoted text" | bare text
const TOKEN = /(-)?(?:([a-z]+):("[^"]*"|\S+)|"([^"]*)"|(\S+))/gi;

/** Returns null for a bad value, undefined for a field name we do not know (treated as text). */
function fieldPredicate(field: string, value: string, errors: string[]): Predicate | null | undefined {
  switch (field) {
    case "status":
    case "verdict": {
      const verdict = STATUS[value];
      if (!verdict) {
        errors.push(`UNKNOWN STATUS "${value}" (TRY BLOCKED, MUTATED, PASSED)`);
        return null;
      }
      return (t) => t.verdict === verdict;
    }
    case "agent": {
      const agent = value.replace(/^@/, "");
      return (t) => t.agent.toLowerCase().includes(agent);
    }
    case "risk": {
      const risk = RISK[value];
      if (!risk) {
        errors.push(`UNKNOWN RISK "${value}" (TRY PII, INJECTION, DRIFT, CREDENTIAL, POLICY)`);
        return null;
      }
      return (t) => t.flags.some((f) => f.risk === risk);
    }
    case "upstream":
      return (t) => t.upstream.toLowerCase().includes(value);
    case "id":
      return (t) => t.id.toLowerCase().includes(value);
    default:
      return undefined;
  }
}

const textPredicate =
  (needle: string): Predicate =>
  (t) =>
    t.raw.toLowerCase().includes(needle) || t.id.toLowerCase().includes(needle);

export function parseQuery(input: string): ParsedQuery {
  const predicates: Predicate[] = [];
  const errors: string[] = [];

  for (const m of input.matchAll(TOKEN)) {
    const negate = Boolean(m[1]);
    let predicate: Predicate | null | undefined;

    if (m[2] && m[3]) {
      predicate = fieldPredicate(m[2].toLowerCase(), m[3].replace(/^"|"$/g, "").toLowerCase(), errors);
      if (predicate === undefined) predicate = textPredicate(`${m[2]}:${m[3]}`.toLowerCase());
    } else {
      const needle = (m[4] ?? m[5] ?? "").toLowerCase();
      predicate = needle ? textPredicate(needle) : null;
    }

    if (!predicate) continue;
    const p = predicate;
    predicates.push(negate ? (t) => !p(t) : p);
  }

  return { test: (t) => predicates.every((p) => p(t)), errors };
}
