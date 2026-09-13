import type { Uplink } from "../hooks/useTelemetry";
import { fmtMs } from "../lib/format";
import type { Source } from "../types";
import { Frame, Hazard } from "./primitives";

export interface LedgerStats {
  total: number;
  halt: number;
  mutated: number;
  p50: number | null;
  p95: number | null;
}

interface TopBarProps {
  stats: LedgerStats;
  source: Source;
  uplink: Uplink;
  paused: boolean;
  queued: number;
  onSource: (source: Source) => void;
  onTogglePause: () => void;
}

export function TopBar({ stats, source, uplink, paused, queued, onSource, onTogglePause }: TopBarProps) {
  return (
    <header className="grid gap-2 lg:grid-cols-[auto_minmax(0,1fr)_auto]">
      <Frame tone="frame" notch={10} innerClassName="flex items-center gap-3 px-3 py-2">
        <Hazard className="h-8 w-12 shrink-0" />
        <div>
          <h1 className="font-sans text-xl font-black uppercase leading-none tracking-[-0.03em]">
            ndAI<span className="text-cyan">/</span>Proxy
          </h1>
          <p className="mt-1 font-mono text-micro uppercase tracking-hud text-muted">Agent guardrail console</p>
        </div>
      </Frame>

      <Frame tone="line" notch={10}>
        <dl className="grid h-full grid-cols-2 gap-px bg-line sm:grid-cols-5">
          <Stat label="TURNS" value={String(stats.total)} />
          <Stat label="HALT" value={String(stats.halt)} className="text-rose" />
          <Stat label="MUTATED" value={String(stats.mutated)} className="text-amber" />
          <Stat label="P50_OVERHEAD" value={stats.p50 == null ? "--" : `+${fmtMs(stats.p50)}`} />
          <Stat
            label="P95_OVERHEAD"
            value={stats.p95 == null ? "--" : `+${fmtMs(stats.p95)}`}
            className="col-span-2 sm:col-span-1"
          />
        </dl>
      </Frame>

      <Frame
        tone="cyan"
        glow
        notch={10}
        innerClassName="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 font-mono text-micro uppercase tracking-hud"
      >
        <div role="group" aria-label="Data source" className="flex">
          {(["SIM", "LIVE"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={source === s}
              onClick={() => onSource(s)}
              className={`border px-2 py-0.5 font-bold active:translate-y-px ${
                source === s ? "border-cyan bg-cyan text-void" : "border-line-strong text-muted hover:text-fg"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <UplinkReadout uplink={uplink} />
        <button
          type="button"
          aria-pressed={paused}
          onClick={onTogglePause}
          className={`flex items-center gap-2 border px-2 py-0.5 active:translate-y-px ${
            paused ? "border-amber/60 text-amber" : "border-line-strong text-fg hover:border-fg"
          }`}
        >
          <span aria-hidden className={paused ? "" : "animate-blink text-emerald"}>
            ■
          </span>
          {paused ? `RESUME +${queued}` : "INGEST"}
        </button>
      </Frame>
    </header>
  );
}

function Stat({ label, value, className = "" }: { label: string; value: string; className?: string }) {
  return (
    <div className={`bg-panel px-3 py-1.5 ${className}`}>
      <dt className="font-mono text-micro uppercase tracking-hud text-muted">{label}</dt>
      <dd className="font-sans text-xl font-extrabold leading-tight tabular-nums tracking-[-0.02em]">{value}</dd>
    </div>
  );
}

function UplinkReadout({ uplink }: { uplink: Uplink }) {
  if (uplink.state === "probing") return <span className="text-muted">UPLINK: PROBING</span>;
  if (uplink.state === "offline")
    return (
      <span title={uplink.error}>
        UPLINK: <span className="text-rose">OFFLINE</span>
      </span>
    );
  const { health } = uplink;
  return (
    <span className="flex flex-wrap gap-x-3">
      <span>
        UPLINK: <span className="text-emerald">127.0.0.1:8000</span>
      </span>
      <span className={health.semantic ? "text-muted" : "text-amber"}>
        EMBED: {health.semantic ? health.embed_backend.toUpperCase() : "FALLBACK, PARAPHRASE OFF"}
      </span>
      {!health.rewrite_model_up && <span className="text-amber">REWRITE: DOWN</span>}
    </span>
  );
}
