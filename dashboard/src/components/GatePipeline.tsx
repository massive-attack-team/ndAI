import { fmtMetric, fmtMs } from "../lib/format";
import type { Gate, GateStatus, Metric, Turn } from "../types";
import { GateStatusBadge } from "./primitives";

const BAR: Record<GateStatus, string> = {
  PASSED: "bg-emerald/70",
  FAILED: "bg-rose",
  BYPASS: "bg-muted/40",
};

export function GatePipeline({ turn }: { turn: Turn }) {
  const timed = turn.gates.some((g) => g.latencyMs != null);
  const total = turn.gates.reduce((s, g) => s + (g.latencyMs ?? 0), 0) || 1;
  let offset = 0;

  return (
    <div className="space-y-3">
      {!timed && (
        <p className="border-l-2 border-amber pl-2 font-mono text-micro uppercase leading-relaxed tracking-hud text-amber">
          NDAi records one latency per turn (+{fmtMs(turn.overheadMs)}), not per gate. It has no consensus tier.
        </p>
      )}

      <ol className="border border-line">
        {turn.gates.map((g) => {
          const start = offset / total;
          offset += g.latencyMs ?? 0;
          return <GateRow key={g.id} gate={g} start={start} width={(g.latencyMs ?? 0) / total} timed={timed} />;
        })}
      </ol>

      <p className="flex flex-wrap justify-between gap-2 font-mono text-micro uppercase tracking-hud text-muted">
        <span>
          Total <span className="text-fg">+{fmtMs(turn.overheadMs)}</span>
          {turn.source === "SIM" && " (modeled per tier)"}
        </span>
        <span>Gates run top to bottom. Consensus is skipped once a cheaper gate halts.</span>
      </p>
    </div>
  );
}

function GateRow({ gate: g, start, width, timed }: { gate: Gate; start: number; width: number; timed: boolean }) {
  return (
    <li className="border-b border-line last:border-b-0">
      <div
        className={`grid grid-cols-[2rem_minmax(0,1fr)_auto] items-start gap-x-3 px-2 py-2 ${
          timed ? "@xl:grid-cols-[2rem_minmax(0,1fr)_8rem_4.5rem_auto]" : ""
        } ${g.halts ? "bg-rose/[0.05]" : ""}`}
      >
        <span className="pt-0.5 font-mono text-micro text-muted">{g.id}</span>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2">
            <span className="break-all font-mono text-data text-fg">{g.key}</span>
            <span className="font-mono text-micro uppercase tracking-hud text-muted">{g.tier}</span>
            {g.halts && <span className="font-mono text-micro font-bold tracking-hud text-rose">◀ HALT TRIGGER</span>}
          </div>
          <p className="mt-0.5 font-mono text-micro uppercase tracking-hud text-muted">{g.note}</p>
          {g.metric && <MetricLine metric={g.metric} />}
        </div>

        {timed && (
          <>
            <div aria-hidden className="relative mt-2 hidden h-2 @xl:block">
              <div className="absolute inset-x-0 top-1/2 h-px bg-line" />
              <div
                className={`absolute top-0 h-2 min-w-[2px] ${BAR[g.status]}`}
                style={{ left: `${start * 100}%`, width: `${width * 100}%` }}
              />
            </div>
            <span className="hidden pt-0.5 text-right font-mono text-micro tabular-nums text-muted @xl:block">
              {g.status === "BYPASS" && !g.latencyMs ? "--" : `+${fmtMs(g.latencyMs)}`}
            </span>
          </>
        )}

        <GateStatusBadge status={g.status} />
      </div>

      {g.votes && (
        <ul className="mb-2 ml-11 mr-2 border-l border-line pl-3">
          {g.votes.map((v) => (
            <li key={v.validator} className="grid grid-cols-[minmax(0,12rem)_3rem_auto] gap-3 font-mono text-micro uppercase tracking-hud">
              <span className="truncate text-muted">{v.validator}</span>
              <span className="tabular-nums text-fg">{v.score.toFixed(2)}</span>
              <span className={v.reject ? "text-rose" : "text-emerald"}>{v.reject ? "REJECT" : "ACCEPT"}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function MetricLine({ metric }: { metric: Metric }) {
  const exceeded = metric.value > metric.max;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
      <p className="font-mono text-micro uppercase tracking-hud">
        <span className={exceeded ? "text-rose" : "text-emerald"}>
          {metric.name}: {fmtMetric(metric, metric.value)}
        </span>
        <span className="text-muted"> / MAX: {fmtMetric(metric, metric.max)}</span>
      </p>
      {metric.kind === "score" && (
        <div aria-hidden className="relative h-2 w-28">
          <div className="absolute inset-x-0 top-1/2 h-px bg-line" />
          <div
            className={`absolute top-0.5 h-1 ${exceeded ? "bg-rose" : "bg-emerald/70"}`}
            style={{ width: `${Math.min(1, metric.value) * 100}%` }}
          />
          <div className="absolute -top-0.5 h-3 w-px bg-fg" style={{ left: `${Math.min(1, metric.max) * 100}%` }} />
        </div>
      )}
    </div>
  );
}
