// Maps detector output onto the three tiers the UI speaks in.
//   green  = allow            (warn is logged-but-allowed, still shown as yellow
//   yellow = sanitize / warn   so the person sees what got logged)
//   red    = block

import type { Action, DocType, Finding, Tier } from "./types";

export const TIER_RANK: Record<Tier, number> = { green: 0, yellow: 1, red: 2 };
export const TIER_WORD: Record<Tier, string> = { green: "Safe", yellow: "Review", red: "Blocked" };

export const VERDICT: Record<Action, string> = {
  allow: "Nothing sensitive found",
  warn: "Sensitive — sending is logged",
  sanitize: "Internal material found",
  block: "Can't be sent",
};

const TYPE_LABEL: Record<DocType, string> = {
  strategic_plan: "Strategic plan",
  financial_plan: "Financial plan",
  research_report: "Research report",
};
const SENSITIVITY_LABEL = ["Public", "Internal", "Confidential", "Restricted"] as const;

export function actionTier(action: Action): Tier {
  if (action === "block") return "red";
  if (action === "sanitize" || action === "warn") return "yellow";
  return "green";
}

export function maxTier(a: Tier, b: Tier): Tier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

export function minTier(a: Tier, b: Tier): Tier {
  return TIER_RANK[a] <= TIER_RANK[b] ? a : b;
}

/** Tier of one span on its own, before the destination policy caps it. Null = not worth underlining. */
export function findingTier(f: Finding): Tier | null {
  if (f.kind === "secret") return f.critical ? "red" : "yellow";
  if (f.tier >= 3 && f.kind !== "category") return "red";
  if (f.tier >= 2) return "yellow";
  return null;
}

export function placeholderFor(label: string): string {
  return `[${label.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "")}]`;
}

export interface FindingCopy {
  title: string;
  detail: string;
  evidence: string | null;
  /** Secrets get a one-click placeholder; passages don't, because "[REDACTED]" mid-sentence breaks the prompt. */
  placeholder: string | null;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const docName = (src: string) => src.split("/").pop()!.replace(/\.md$/, "");

export function describeFinding(f: Finding): FindingCopy {
  if (f.kind === "secret") {
    return {
      title: f.label,
      detail: f.critical
        ? "Live credential. It grants access on its own, so it can't be sent anywhere."
        : "Personal data. Replace it before sending.",
      evidence: f.preview,
      placeholder: placeholderFor(f.label),
    };
  }

  const title = `${TYPE_LABEL[f.type]} · ${SENSITIVITY_LABEL[f.tier]}`;

  if (f.kind === "category") {
    return {
      title,
      detail: `Reads like ${TYPE_LABEL[f.type].toLowerCase()} material, but no internal document matched.`,
      evidence: f.score != null ? `${pct(f.score)} category match` : null,
      placeholder: null,
    };
  }

  if (f.kind === "context") {
    const who = f.scope === "team" ? "your team" : "you";
    return {
      title: `${title} · pieced together`,
      detail: `${f.chunks_out} of ${f.chunk_total} sections of internal doc “${docName(f.label)}” sent from ${who} over ${f.prompts} prompts.`,
      evidence: `${pct(f.coverage)} of the document`,
      placeholder: null,
    };
  }

  // provenance: verbatim or paraphrase, matched a specific internal doc.
  const src = `internal doc “${docName(f.label)}”`;
  const detail = f.confidence === "verbatim" ? `Near-verbatim copy of ${src}.` : `Paraphrases ${src}.`;
  let evidence: string | null = `${pct(f.score)} internal match`;
  if (f.public_score != null) evidence += ` · best public match ${pct(f.public_score)}`;
  return { title, detail, evidence, placeholder: null };
}

export function findingKey(f: Finding, quote: string): string {
  return `${f.kind}:${f.kind === "secret" ? f.label : f.type}:${quote}`;
}
