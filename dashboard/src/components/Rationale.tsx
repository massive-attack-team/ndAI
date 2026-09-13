import { useEffect, useState } from "react";
import type { Uplink } from "../hooks/useTelemetry";
import type { Turn } from "../types";
import { Meta, RiskChip, SectionTitle, VerdictBadge } from "./primitives";
import { Sandbox } from "./Sandbox";

export function Rationale({ turn, uplink }: { turn: Turn; uplink: Uplink }) {
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");

  useEffect(() => {
    if (copy === "idle") return;
    const t = window.setTimeout(() => setCopy("idle"), 2000);
    return () => window.clearTimeout(t);
  }, [copy]);

  const failed = turn.gates.filter((g) => g.status === "FAILED" && g.tier !== "POLICY");
  const brief = turn.remediation.map((r, i) => `${i + 1}. [${r.rule}] ${r.instruction}`).join("\n");

  const copyBrief = async () => {
    try {
      await navigator.clipboard.writeText(brief);
      setCopy("done");
    } catch {
      setCopy("failed");
    }
  };

  return (
    <div className="space-y-5">
      <section>
        <SectionTitle>Decision</SectionTitle>
        <dl className="grid gap-px border border-line bg-line @lg:grid-cols-[auto_minmax(0,1fr)_auto]">
          <Meta term="VERDICT">
            <VerdictBadge verdict={turn.verdict} long />
          </Meta>
          <Meta term="TRIGGERED_BY" className="whitespace-normal">
            {failed.length ? failed.map((g) => `${g.id} ${g.key}`).join(" + ") : "NONE"}
          </Meta>
          <Meta term="RULES">{turn.remediation.length}</Meta>
        </dl>
      </section>

      <section>
        <SectionTitle
          aside={
            turn.remediation.length > 0 && (
              <button
                type="button"
                onClick={copyBrief}
                className="border border-cyan/60 px-1.5 py-0.5 font-mono text-micro uppercase tracking-hud text-cyan hover:bg-cyan/10 active:translate-y-px"
              >
                {copy === "done" ? "COPIED" : copy === "failed" ? "CLIPBOARD BLOCKED" : "COPY AGENT BRIEF"}
              </button>
            )
          }
        >
          Remediation
        </SectionTitle>

        {turn.remediation.length === 0 ? (
          <p className="font-mono text-micro uppercase tracking-hud text-muted">No rules triggered. No prompt changes needed.</p>
        ) : (
          <ol className="border border-line">
            {turn.remediation.map((r) => (
              <li
                key={r.rule}
                className="grid gap-2 border-b border-line p-3 last:border-b-0 @lg:grid-cols-[13rem_minmax(0,1fr)] @lg:gap-4"
              >
                <div className="min-w-0">
                  <RiskChip risk={r.risk} full />
                  <p className="mt-1 break-all font-mono text-micro text-fg">{r.rule}</p>
                  {r.trigger && (
                    <samp title={r.trigger} className="mt-1 block truncate font-mono text-micro text-muted">
                      &ldquo;{r.trigger}&rdquo;
                    </samp>
                  )}
                </div>
                <p className="max-w-[65ch] font-sans text-sm leading-relaxed text-fg/90">{r.instruction}</p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <Sandbox key={turn.id} turn={turn} uplink={uplink} />
    </div>
  );
}
