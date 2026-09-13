import type { ReactNode } from "react";
import { RISK_ORDER, type Flag, type GateStatus, type Risk, type Verdict } from "../types";

export type Tone = "frame" | "line" | "cyan" | "emerald" | "amber" | "rose";

const STROKE: Record<Tone, string> = {
  frame: "bg-frame/75",
  line: "bg-line-strong",
  cyan: "bg-cyan/70",
  emerald: "bg-emerald/65",
  amber: "bg-amber/70",
  rose: "bg-rose/80",
};

const GLOW: Record<Tone, string> = {
  frame: "",
  line: "",
  cyan: "drop-shadow-[0_0_14px_rgba(0,240,255,0.16)]",
  emerald: "drop-shadow-[0_0_14px_rgba(0,255,156,0.14)]",
  amber: "drop-shadow-[0_0_14px_rgba(255,184,0,0.14)]",
  rose: "drop-shadow-[0_0_16px_rgba(255,0,85,0.22)]",
};

const HAZARD: Record<Tone, string> = {
  frame: "[--hazard:var(--color-frame)]",
  line: "[--hazard:var(--color-line-strong)]",
  cyan: "[--hazard:var(--color-cyan)]",
  emerald: "[--hazard:var(--color-emerald)]",
  amber: "[--hazard:var(--color-amber)]",
  rose: "[--hazard:var(--color-rose)]",
};

interface FrameProps {
  tone?: Tone;
  notch?: number;
  weight?: 1 | 2;
  glow?: boolean;
  className?: string;
  innerClassName?: string;
  children: ReactNode;
}

/**
 * Notched plate from the reference art: a stroke-coloured clip with a panel
 * clip inset inside it. Glow is a drop-shadow on the unclipped wrapper, since
 * box-shadow would be clipped away.
 */
export function Frame({
  tone = "line",
  notch = 12,
  weight = 1,
  glow = false,
  className = "",
  innerClassName = "",
  children,
}: FrameProps) {
  const clipPath = `polygon(${notch}px 0, 100% 0, 100% calc(100% - ${notch}px), calc(100% - ${notch}px) 100%, 0 100%, 0 ${notch}px)`;
  return (
    <div className={`${glow ? GLOW[tone] : ""} ${className}`}>
      <div className={`h-full ${weight === 2 ? "p-[2px]" : "p-px"} ${STROKE[tone]}`} style={{ clipPath }}>
        <div className={`h-full bg-panel ${innerClassName}`} style={{ clipPath }}>
          {children}
        </div>
      </div>
    </div>
  );
}

export function Hazard({ tone = "frame", className = "" }: { tone?: Tone; className?: string }) {
  return <div aria-hidden className={`hazard ${HAZARD[tone]} ${className}`} />;
}

export function PanelHeader({ title, tone = "frame", children }: { title: string; tone?: Tone; children?: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center gap-3 border-b border-line-strong px-3 py-1.5">
      <Hazard tone={tone} className="h-3 w-8 shrink-0" />
      <h2 className="font-sans text-sm font-extrabold uppercase tracking-[0.04em]">{title}</h2>
      <div className="ml-auto flex items-center gap-3 font-mono text-micro uppercase tracking-hud text-muted">
        {children}
      </div>
    </div>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-3">
      <h3 className="font-sans text-xs font-extrabold uppercase tracking-[0.06em] text-fg">{children}</h3>
      <div aria-hidden className="h-px flex-1 bg-line" />
      {aside}
    </div>
  );
}

const VERDICT_STYLE: Record<Verdict, string> = {
  PERMIT: "border-emerald/45 text-emerald",
  MUTATED: "border-amber/55 bg-amber/5 text-amber",
  HALT: "border-rose/65 bg-rose/10 text-rose shadow-glow-rose",
};

export function VerdictBadge({ verdict, long = false }: { verdict: Verdict; long?: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center border px-1 font-mono text-micro font-bold uppercase tracking-hud ${VERDICT_STYLE[verdict]}`}
    >
      [{long ? `VERDICT_${verdict}` : verdict}]
    </span>
  );
}

const STATUS_STYLE: Record<GateStatus, string> = {
  PASSED: "border-emerald/45 text-emerald",
  FAILED: "border-rose/65 bg-rose/10 text-rose",
  BYPASS: "border-dashed border-line-strong text-muted",
};

export function GateStatusBadge({ status }: { status: GateStatus }) {
  return (
    <span className={`inline-flex shrink-0 border px-1 font-mono text-micro font-bold tracking-hud ${STATUS_STYLE[status]}`}>
      {status}
    </span>
  );
}

const RISK_SHORT: Record<Risk, string> = {
  CREDENTIAL: "CRED",
  INJECTION: "INJ",
  POLICY: "POL",
  DRIFT: "DRIFT",
  PII: "PII",
};

export const RISK_TEXT: Record<Risk, string> = {
  CREDENTIAL: "text-rose",
  INJECTION: "text-rose",
  POLICY: "text-rose",
  DRIFT: "text-amber",
  PII: "text-amber",
};

export const RISK_MARK: Record<Risk, string> = {
  CREDENTIAL: "bg-rose/15 decoration-rose",
  INJECTION: "bg-rose/15 decoration-rose",
  POLICY: "bg-rose/15 decoration-rose",
  DRIFT: "bg-amber/15 decoration-amber",
  PII: "bg-amber/15 decoration-amber",
};

const RISK_BORDER: Record<Risk, string> = {
  CREDENTIAL: "border-rose/40",
  INJECTION: "border-rose/40",
  POLICY: "border-rose/40",
  DRIFT: "border-amber/40",
  PII: "border-amber/40",
};

export function RiskChip({ risk, full = false }: { risk: Risk; full?: boolean }) {
  return (
    <span
      title={risk}
      className={`inline-flex shrink-0 border px-1 font-mono text-micro uppercase tracking-hud ${RISK_TEXT[risk]} ${RISK_BORDER[risk]}`}
    >
      {full ? risk : RISK_SHORT[risk]}
    </span>
  );
}

export const risksOf = (flags: Flag[]) => RISK_ORDER.filter((r) => flags.some((f) => f.risk === r));

export const worstRisk = (flags: Flag[]): Risk => risksOf(flags)[0] ?? "PII";

export function Meta({ term, children, className = "" }: { term: string; children: ReactNode; className?: string }) {
  return (
    <div className="min-w-0 bg-panel px-3 py-1.5">
      <dt className="font-mono text-micro uppercase tracking-hud text-muted">{term}</dt>
      <dd className={`truncate font-mono text-data text-fg ${className}`}>{children}</dd>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="border border-line-strong px-1 font-mono text-micro text-fg">{children}</kbd>;
}
