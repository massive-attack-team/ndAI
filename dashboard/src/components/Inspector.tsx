import { useRef, type KeyboardEvent } from "react";
import type { Uplink } from "../hooks/useTelemetry";
import { fmtDateTime, fmtMs } from "../lib/format";
import type { Turn, Verdict } from "../types";
import { GatePipeline } from "./GatePipeline";
import { PayloadDiff } from "./PayloadDiff";
import { Frame, Hazard, Meta, VerdictBadge, type Tone } from "./primitives";
import { Rationale } from "./Rationale";

export type InspectorTab = "diff" | "gates" | "rationale";

export const TABS: { id: InspectorTab; label: string; short: string }[] = [
  { id: "diff", label: "PAYLOAD_DIFF", short: "DIFF" },
  { id: "gates", label: "GATE_PIPELINE", short: "GATES" },
  { id: "rationale", label: "RATIONALE", short: "RATIONALE" },
];

const TONE: Record<Verdict, Tone> = { PERMIT: "emerald", MUTATED: "amber", HALT: "rose" };

function summary(turn: Turn): string {
  if (turn.verdict === "HALT") {
    const keys = turn.gates.filter((g) => g.halts).map((g) => g.key);
    return `Halted at ${keys.join(" + ") || "policy"}. Nothing forwarded.`;
  }
  if (turn.verdict === "MUTATED") {
    const n = turn.flags.filter((f) => f.replacement).length;
    return n ? `${n} span${n === 1 ? "" : "s"} redacted before forwarding.` : "Rewritten before forwarding.";
  }
  return "Forwarded unchanged.";
}

interface InspectorProps {
  turn: Turn;
  tab: InspectorTab;
  uplink: Uplink;
  onTab: (tab: InspectorTab) => void;
  onClose: () => void;
}

export function Inspector({ turn, tab, uplink, onTab, onClose }: InspectorProps) {
  const tone = TONE[turn.verdict];
  const tablist = useRef<HTMLDivElement>(null);

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.id === tab);
    const next = TABS[(i + (e.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length]!;
    onTab(next.id);
    tablist.current?.querySelector<HTMLButtonElement>(`#tab-${next.id}`)?.focus();
  };

  return (
    <section
      aria-label={`Inspection of ${turn.id}`}
      className="fixed inset-0 z-40 bg-void p-2 lg:static lg:z-auto lg:min-h-0 lg:bg-transparent lg:p-0"
    >
      <Frame tone={tone} weight={2} glow={turn.verdict === "HALT"} notch={16} className="h-full" innerClassName="flex min-h-0 flex-col">
        <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-strong px-3 py-1.5">
          <Hazard tone={tone} className="h-3 w-14 shrink-0" />
          {turn.verdict === "HALT" && (
            <span aria-hidden className="font-mono text-micro tracking-[0.3em] text-rose">
              ▲▲▲
            </span>
          )}
          <h2 className="font-sans text-sm font-extrabold uppercase tracking-[0.04em]">Inspection</h2>
          <span className="ml-auto font-mono text-micro uppercase tracking-hud text-muted">{fmtDateTime(turn.ts)} UTC</span>
          <button
            type="button"
            onClick={onClose}
            className="border border-line-strong px-1.5 py-0.5 font-mono text-micro uppercase tracking-hud text-muted hover:border-fg hover:text-fg active:translate-y-px"
          >
            [ESC] CLOSE
          </button>
        </div>

        <dl className="grid grid-cols-2 gap-px border-b border-line-strong bg-line sm:grid-cols-4">
          <Meta term="TRACK_ID">{turn.id}</Meta>
          <Meta term="AGENT_ROOT" className="text-cyan">
            @{turn.agent}
          </Meta>
          <Meta term="UPSTREAM">{turn.upstream}</Meta>
          <Meta term="OVERHEAD">+{fmtMs(turn.overheadMs)}</Meta>
        </dl>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-strong px-3 py-2">
          <VerdictBadge verdict={turn.verdict} long />
          <p className="font-mono text-micro uppercase tracking-hud text-muted">{summary(turn)}</p>
        </div>

        <div
          ref={tablist}
          role="tablist"
          aria-label="Inspection sections"
          onKeyDown={onTabKey}
          className="grid grid-cols-3 border-b border-line-strong"
        >
          {TABS.map((t, i) => {
            const active = t.id === tab;
            return (
              <button
                key={t.id}
                id={`tab-${t.id}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`panel-${t.id}`}
                tabIndex={active ? 0 : -1}
                onClick={() => onTab(t.id)}
                className={`truncate border-r border-line px-3 py-2 text-left font-mono text-micro font-bold uppercase tracking-hud last:border-r-0 ${
                  active ? "bg-fg text-void" : "text-muted hover:bg-fg/[0.04] hover:text-fg"
                }`}
              >
                <span className={active ? "text-void/60" : "text-dim"}>[{i + 1}]</span>{" "}
                <span className="sm:hidden">{t.short}</span>
                <span className="hidden sm:inline">{t.label}</span>
              </button>
            );
          })}
        </div>

        <div
          id={`panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`tab-${tab}`}
          className="@container min-h-0 flex-1 overflow-auto p-3"
        >
          {tab === "diff" && <PayloadDiff turn={turn} />}
          {tab === "gates" && <GatePipeline turn={turn} />}
          {tab === "rationale" && <Rationale turn={turn} uplink={uplink} />}
        </div>
      </Frame>
    </section>
  );
}
