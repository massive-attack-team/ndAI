import { useEffect, useRef, type ReactNode } from "react";
import type { LiveState } from "../hooks/useTelemetry";
import { fmtMs, fmtTime } from "../lib/format";
import type { Source, Turn } from "../types";
import { Frame, PanelHeader, RiskChip, VerdictBadge, risksOf, type Tone } from "./primitives";

interface LedgerProps {
  turns: Turn[];
  totalTurns: number;
  selectedId: string | null;
  compact: boolean;
  arrivals: Record<string, number>;
  source: Source;
  live: LiveState;
  liveError: string | null;
  filtered: boolean;
  onOpen: (turn: Turn) => void;
  onCursor: (turn: Turn) => void;
  onClearFilter: () => void;
}

export function Ledger(props: LedgerProps) {
  const { turns, selectedId, compact } = props;
  const tableRef = useRef<HTMLTableElement>(null);
  const rows = useRef(new Map<string, HTMLTableRowElement>());

  useEffect(() => {
    if (!selectedId) return;
    const row = rows.current.get(selectedId);
    if (!row) return;
    row.scrollIntoView({ block: "nearest" });
    // Keep DOM focus on the cursor when the user is navigating the table by keyboard.
    if (tableRef.current?.contains(document.activeElement)) row.focus({ preventScroll: true });
  }, [selectedId]);

  const now = Date.now();
  const focusableId = selectedId && turns.some((t) => t.id === selectedId) ? selectedId : turns[0]?.id;

  return (
    <Frame tone="frame" notch={14} className="min-h-0" innerClassName="flex min-h-0 flex-col">
      <PanelHeader title="Stream">
        <span>{props.source === "SIM" ? "SOURCE: SIM SEED" : "SOURCE: NDAi AUDIT LOG"}</span>
        <span className="hidden sm:inline">NEWEST FIRST</span>
      </PanelHeader>

      {props.live === "error" && props.totalTurns > 0 && (
        <p role="status" className="border-b border-rose/40 bg-rose/10 px-3 py-1 font-mono text-micro uppercase tracking-hud text-rose">
          Uplink lost ({props.liveError}). Showing last snapshot.
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {turns.length > 0 ? (
          <table ref={tableRef} role="grid" aria-label="Intercepted agent turns" className="w-full border-collapse font-mono text-data">
            <thead className="sticky top-0 z-10 bg-raised">
              <tr className="text-left font-mono text-micro uppercase tracking-hud text-muted">
                <Th>TIME_UTC</Th>
                <Th className="text-right">OVH</Th>
                <Th>AGENT</Th>
                <Th>VERDICT</Th>
                <Th className="hidden md:table-cell">RISK</Th>
                {!compact && <Th className="hidden xl:table-cell">TRACK_ID</Th>}
                {!compact && <Th className="hidden 2xl:table-cell">UPSTREAM</Th>}
                <Th className="w-full">PAYLOAD</Th>
              </tr>
            </thead>
            <tbody>
              {turns.map((t) => {
                const selected = t.id === selectedId;
                const arrived = props.arrivals[t.id];
                const fresh = arrived !== undefined && now - arrived < 1500;
                const risks = risksOf(t.flags);
                return (
                  <tr
                    key={t.id}
                    ref={(el) => {
                      if (el) rows.current.set(t.id, el);
                      else rows.current.delete(t.id);
                    }}
                    aria-selected={selected}
                    tabIndex={t.id === focusableId ? 0 : -1}
                    onClick={() => props.onOpen(t)}
                    onFocus={() => props.onCursor(t)}
                    className={`cursor-pointer border-b border-line/60 outline-none focus-visible:bg-cyan/10 ${
                      selected ? "bg-cyan/[0.07] shadow-[inset_2px_0_0_var(--color-cyan)]" : "hover:bg-fg/[0.03]"
                    } ${fresh ? "animate-ingest" : ""}`}
                  >
                    <Td className="text-muted tabular-nums">{fmtTime(t.ts)}</Td>
                    <Td className="text-right tabular-nums">+{fmtMs(t.overheadMs)}</Td>
                    <Td className="text-cyan">@{t.agent}</Td>
                    <Td>
                      <VerdictBadge verdict={t.verdict} />
                    </Td>
                    <Td className="hidden md:table-cell">
                      {risks.length ? (
                        <span className="flex gap-1">
                          {risks.map((r) => (
                            <RiskChip key={r} risk={r} />
                          ))}
                        </span>
                      ) : (
                        <span className="text-dim">--</span>
                      )}
                    </Td>
                    {!compact && <Td className="hidden text-muted xl:table-cell">{t.id}</Td>}
                    {!compact && <Td className="hidden text-muted 2xl:table-cell">{t.upstream}</Td>}
                    <Td className="w-full max-w-0 truncate text-fg/75">{t.raw.replace(/\s+/g, " ")}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <EmptyState {...props} />
        )}
      </div>
    </Frame>
  );
}

function Th({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <th scope="col" className={`whitespace-nowrap border-b border-line-strong px-2 py-1.5 font-normal first:pl-3 ${className}`}>
      {children}
    </th>
  );
}

function Td({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <td className={`whitespace-nowrap px-2 py-1 first:pl-3 last:pr-3 ${className}`}>{children}</td>;
}

function EmptyState({ source, live, liveError, filtered, onClearFilter }: LedgerProps) {
  if (source === "LIVE" && live === "loading") {
    return (
      <div aria-busy="true" className="space-y-2 p-3">
        <p className="sr-only">Loading the NDAi audit log</p>
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} className="skeleton h-5" />
        ))}
      </div>
    );
  }
  if (source === "LIVE" && live === "error") {
    return (
      <Notice title="Uplink offline" tone="rose">
        The NDAi detector is not answering on 127.0.0.1:8000 ({liveError}). Start it with{" "}
        <code className="normal-case text-fg">python -m detector.main</code>, or press <Key>L</Key> for the SIM seed.
      </Notice>
    );
  }
  if (filtered) {
    return (
      <Notice title="No matches">
        No turns match the current filter.{" "}
        <button type="button" onClick={onClearFilter} className="border border-cyan/60 px-1.5 text-cyan hover:bg-cyan/10">
          CLEAR FILTER
        </button>
      </Notice>
    );
  }
  return (
    <Notice title="Log empty">
      NDAi has not logged any prompts yet. Run <code className="normal-case text-fg">python demo_seed.py</code> or send
      one through the extension.
    </Notice>
  );
}

function Key({ children }: { children: ReactNode }) {
  return <kbd className="border border-line-strong px-1 text-fg">{children}</kbd>;
}

function Notice({ title, tone = "frame", children }: { title: string; tone?: Tone; children: ReactNode }) {
  return (
    <div className="p-6">
      <p className={`font-sans text-4xl font-black uppercase leading-[0.9] tracking-[-0.04em] ${tone === "rose" ? "text-rose" : "text-fg"}`}>
        {title}
      </p>
      <p className="mt-4 max-w-[60ch] font-mono text-micro uppercase leading-relaxed tracking-hud text-muted">{children}</p>
    </div>
  );
}
