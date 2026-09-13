import { useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { diffTokens, type Piece } from "../lib/diff";
import { fmtConfidence } from "../lib/format";
import type { Flag, Turn } from "../types";
import { RISK_MARK, RISK_TEXT, RiskChip, SectionTitle, worstRisk } from "./primitives";

interface Tip {
  x: number;
  top: number;
  bottom: number;
  flags: Flag[];
}

interface Segment {
  text: string;
  start: number;
  flags: Flag[];
  deleted: boolean;
}

type Spanned = Flag & { span: [number, number] };

/** Cut the raw payload at every flag and deletion boundary so each piece has one uniform state. */
function segmentRaw(raw: string, flags: Flag[], left: Piece[]): Segment[] {
  const spanned = flags.filter((f): f is Spanned => f.span !== null);
  const dels = left.filter((p) => p.op === "del");
  const cuts = new Set([0, raw.length]);
  for (const f of spanned) cuts.add(f.span[0]).add(f.span[1]);
  for (const d of dels) cuts.add(d.start).add(d.end);

  const points = [...cuts].filter((n) => n >= 0 && n <= raw.length).sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (a === b) continue;
    out.push({
      text: raw.slice(a, b),
      start: a,
      flags: spanned.filter((f) => f.span[0] <= a && f.span[1] >= b),
      deleted: dels.some((d) => d.start <= a && d.end >= b),
    });
  }
  return out;
}

export function PayloadDiff({ turn }: { turn: Turn }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const [hot, setHot] = useState<string | null>(null);

  const diff = useMemo(
    () => (turn.sanitized == null ? null : diffTokens(turn.raw, turn.sanitized)),
    [turn.raw, turn.sanitized],
  );
  const segments = useMemo(() => segmentRaw(turn.raw, turn.flags, diff?.left ?? []), [turn.raw, turn.flags, diff]);

  const show = (el: HTMLElement, flags: Flag[]) => {
    const r = el.getBoundingClientRect();
    setTip({ x: r.left + r.width / 2, top: r.top, bottom: r.bottom, flags });
    setHot(flags[0]?.id ?? null);
  };
  const hide = () => {
    setTip(null);
    setHot(null);
  };

  const tabbable = new Set<string>();
  const halting = turn.gates.filter((g) => g.halts).map((g) => g.id);

  return (
    <div className="space-y-4">
      {!turn.rawRetained && (
        <p className="border-l-2 border-amber pl-2 font-mono text-micro uppercase leading-relaxed tracking-hud text-amber">
          Raw payload not retained. The ndAI audit log keeps a SHA-256 and a redacted preview, so both panes show that
          preview.
        </p>
      )}

      <div className="grid gap-3 @2xl:grid-cols-2">
        <Pane title="INBOUND.RAW" meta={`${turn.raw.length} CH`} onScroll={hide}>
          <pre className="whitespace-pre-wrap break-words font-mono text-data text-fg/90">
            {segments.map((s, i) => {
              if (!s.flags.length) {
                return (
                  <span key={i} className={s.deleted ? "text-muted line-through decoration-amber/70" : undefined}>
                    {s.text}
                  </span>
                );
              }
              const first = s.flags.find((f) => !tabbable.has(f.id));
              if (first) s.flags.forEach((f) => tabbable.add(f.id));
              const lit = s.flags.some((f) => f.id === hot);
              return (
                <mark
                  key={i}
                  tabIndex={first ? 0 : -1}
                  onMouseEnter={(e) => show(e.currentTarget, s.flags)}
                  onMouseLeave={hide}
                  onFocus={(e) => show(e.currentTarget, s.flags)}
                  onBlur={hide}
                  className={`cursor-help text-fg underline decoration-2 underline-offset-[3px] outline-none focus-visible:outline-1 focus-visible:outline-cyan ${RISK_MARK[worstRisk(s.flags)]} ${
                    lit ? "!bg-cyan/25" : ""
                  }`}
                >
                  {s.text}
                  {first && <span className="sr-only"> (flagged: {s.flags.map((f) => f.rule).join(", ")})</span>}
                </mark>
              );
            })}
          </pre>
        </Pane>

        <Pane title="OUTBOUND.SANITIZED" meta={turn.sanitized == null ? "NOT FORWARDED" : `${turn.sanitized.length} CH`}>
          {diff ? (
            <pre className="whitespace-pre-wrap break-words font-mono text-data text-fg/90">
              {diff.right.map((p, i) =>
                p.op === "ins" ? (
                  <ins key={i} className="bg-amber/15 text-amber no-underline">
                    {p.text}
                  </ins>
                ) : (
                  <span key={i}>{p.text}</span>
                ),
              )}
            </pre>
          ) : (
            <div className="py-2">
              <p className="font-sans text-3xl font-black uppercase leading-[0.9] tracking-[-0.04em] text-rose">
                Nothing
                <br />
                forwarded
              </p>
              <p className="mt-3 font-mono text-micro uppercase leading-relaxed tracking-hud text-muted">
                {turn.upstream} received 0 bytes. Halt raised by {halting.join(" + ") || "policy"}.
              </p>
            </div>
          )}
        </Pane>
      </div>

      <section>
        <SectionTitle aside={<span className="font-mono text-micro text-muted">{turn.flags.length}</span>}>
          Flagged spans
        </SectionTitle>
        {turn.flags.length === 0 ? (
          <p className="font-mono text-micro uppercase tracking-hud text-muted">No risk indicators on this turn.</p>
        ) : (
          <div className="overflow-x-auto border border-line">
            <table className="w-full border-collapse font-mono text-micro uppercase tracking-hud">
              <thead className="bg-raised text-left text-muted">
                <tr>
                  {["RISK", "RULE", "SPAN", "CONF", "OUTBOUND"].map((h) => (
                    <th key={h} scope="col" className="whitespace-nowrap px-2 py-1 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {turn.flags.map((f) => (
                  <tr
                    key={f.id}
                    onMouseEnter={() => setHot(f.id)}
                    onMouseLeave={() => setHot(null)}
                    className={`border-t border-line ${hot === f.id ? "bg-cyan/[0.06]" : ""}`}
                  >
                    <td className="px-2 py-1">
                      <RiskChip risk={f.risk} />
                    </td>
                    <td className="px-2 py-1 text-fg">
                      {f.rule}
                      {f.detail && !f.span && <div className="max-w-[40ch] truncate normal-case text-muted">{f.detail}</div>}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 tabular-nums text-muted">
                      {f.span ? `${f.span[0]}-${f.span[1]}` : "--"}
                    </td>
                    <td className="px-2 py-1 tabular-nums">{fmtConfidence(f.confidence)}</td>
                    <td className="whitespace-nowrap px-2 py-1">
                      {f.replacement ? (
                        <span className="text-amber">{f.replacement}</span>
                      ) : turn.verdict === "HALT" ? (
                        <span className="text-rose">DROPPED</span>
                      ) : (
                        <span className="text-dim">--</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <FlagTip tip={tip} />
    </div>
  );
}

function Pane({ title, meta, onScroll, children }: { title: string; meta: string; onScroll?: () => void; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col border border-line">
      <header className="flex items-center justify-between gap-2 border-b border-line bg-raised px-2 py-1 font-mono text-micro uppercase tracking-hud text-muted">
        <h3 className="text-fg">{title}</h3>
        <span>{meta}</span>
      </header>
      <div onScroll={onScroll} className="max-h-[24rem] overflow-auto p-2">
        {children}
      </div>
    </section>
  );
}

/** Portalled so the inspector frame's clip-path cannot cut it off. */
function FlagTip({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  const x = Math.min(window.innerWidth - 156, Math.max(156, tip.x));
  const below = tip.bottom < window.innerHeight - 180;
  const style = below ? { left: x, top: tip.bottom + 6 } : { left: x, bottom: window.innerHeight - tip.top + 6 };

  return createPortal(
    <div
      role="tooltip"
      style={style}
      className="pointer-events-none fixed z-50 w-72 -translate-x-1/2 border border-cyan/60 bg-void p-2 font-mono text-micro uppercase tracking-hud shadow-glow-cyan"
    >
      {tip.flags.map((f, i) => (
        <dl key={f.id} className={`grid grid-cols-[4.5rem_1fr] gap-y-0.5 ${i ? "mt-2 border-t border-line pt-2" : ""}`}>
          <dt className="text-muted">RISK</dt>
          <dd className={RISK_TEXT[f.risk]}>{f.risk}</dd>
          <dt className="text-muted">RULE</dt>
          <dd className="break-all text-fg">{f.rule}</dd>
          <dt className="text-muted">CONF</dt>
          <dd className="text-fg">{fmtConfidence(f.confidence)}</dd>
          {f.replacement && (
            <>
              <dt className="text-muted">OUTBOUND</dt>
              <dd className="text-amber">{f.replacement}</dd>
            </>
          )}
        </dl>
      ))}
    </div>,
    document.body,
  );
}
