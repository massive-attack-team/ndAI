import { useEffect, useId, useRef, useState } from "react";
import { inspectRemote, type NdaiInspection } from "../data/ndai";
import { AGENT_CONTEXT } from "../data/seed";
import { evaluate } from "../engine/gates";
import type { Uplink } from "../hooks/useTelemetry";
import { fmtMetric, fmtMs, messageOf } from "../lib/format";
import type { Evaluation, Turn } from "../types";
import { GateStatusBadge, SectionTitle, VerdictBadge } from "./primitives";

// One destination per policy.yaml class, so the NDAi verdict can be compared across them.
const DESTINATIONS = [
  { host: "localhost", label: "localhost / private_local" },
  { host: "console.anthropic.com", label: "console.anthropic.com / enterprise_vetted" },
  { host: "chatgpt.com", label: "chatgpt.com / public_consumer" },
];

type Remote =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; data: NdaiInspection }
  | { status: "error"; error: string };

export function Sandbox({ turn, uplink }: { turn: Turn; uplink: Uplink }) {
  const ids = useId();
  const [text, setText] = useState(turn.raw);
  const [local, setLocal] = useState<Evaluation | null>(null);
  const [destination, setDestination] = useState(DESTINATIONS[1]!.host);
  const [remote, setRemote] = useState<Remote>({ status: "idle" });
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => () => ctrl.current?.abort(), []);

  const online = uplink.state === "online";
  const dirty = text !== turn.raw;

  const run = () => {
    setLocal(evaluate(text, AGENT_CONTEXT));
    if (!online) {
      setRemote({ status: "idle" });
      return;
    }
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setRemote({ status: "loading" });
    inspectRemote(text, destination, c.signal)
      .then((data) => setRemote({ status: "ok", data }))
      .catch((err) => {
        if (!c.signal.aborted) setRemote({ status: "error", error: messageOf(err) });
      });
  };

  const reset = () => {
    setText(turn.raw);
    setLocal(null);
    setRemote({ status: "idle" });
  };

  return (
    <section>
      <SectionTitle>Re-evaluate in sandbox</SectionTitle>

      <div className="border border-line">
        <div className="flex flex-col gap-2 p-3">
          <label htmlFor={`${ids}-payload`} className="font-mono text-micro uppercase tracking-hud text-fg">
            Payload
          </label>
          <textarea
            id={`${ids}-payload`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                run();
              }
            }}
            rows={7}
            spellCheck={false}
            aria-describedby={`${ids}-help`}
            className="w-full resize-y border border-line-strong bg-void p-2 font-mono text-data text-fg outline-none focus:border-cyan focus:shadow-glow-cyan"
          />
          <p id={`${ids}-help`} className="font-mono text-micro uppercase leading-relaxed tracking-hud text-muted">
            Runs the local gate engine. Registry: {AGENT_CONTEXT.toolRegistry.join(", ")}. Grounded sections:{" "}
            {AGENT_CONTEXT.grounding.join(", ")}.
            {!turn.rawRetained && " This live row only has the redacted preview to start from."}
          </p>

          {online && (
            <div className="flex flex-col gap-1">
              <label htmlFor={`${ids}-dest`} className="font-mono text-micro uppercase tracking-hud text-fg">
                NDAi destination
              </label>
              <select
                id={`${ids}-dest`}
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                className="h-8 border border-line-strong bg-void px-2 font-mono text-data text-fg outline-none focus:border-cyan"
              >
                {DESTINATIONS.map((d) => (
                  <option key={d.host} value={d.host}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={run}
              className="border border-cyan bg-cyan px-3 py-1 font-mono text-micro font-bold uppercase tracking-hud text-void hover:shadow-glow-cyan active:translate-y-px"
            >
              Re-evaluate
            </button>
            <button
              type="button"
              onClick={reset}
              disabled={!dirty && !local}
              className="border border-line-strong px-3 py-1 font-mono text-micro uppercase tracking-hud text-fg hover:border-fg active:translate-y-px disabled:cursor-not-allowed disabled:text-dim disabled:hover:border-line-strong"
            >
              Reset
            </button>
            <span className="font-mono text-micro uppercase tracking-hud text-muted">
              <kbd className="border border-line-strong px-1 text-fg">⌘/CTRL+↵</kbd> runs
            </span>
          </div>
        </div>

        {local && (
          <div aria-live="polite" className="border-t border-line">
            <div className="flex flex-wrap items-center gap-3 bg-raised px-3 py-2">
              <span className="font-mono text-micro uppercase tracking-hud text-muted">Local engine</span>
              <VerdictBadge verdict={local.verdict} long />
              <span className="font-mono text-micro uppercase tracking-hud text-muted">
                was {turn.verdict}
                {local.verdict !== turn.verdict && <span className="text-cyan"> / changed</span>}
              </span>
              <span className="ml-auto font-mono text-micro uppercase tracking-hud text-muted">
                +{fmtMs(local.overheadMs)} in browser
              </span>
            </div>
            <ul>
              {local.gates.map((g) => (
                <li
                  key={g.id}
                  className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-3 border-t border-line px-3 py-1 font-mono text-micro uppercase tracking-hud"
                >
                  <span className="text-muted">{g.id}</span>
                  <span className="truncate text-fg">
                    {g.key}
                    {g.metric && g.metric.kind === "score" && (
                      <span className={g.metric.value > g.metric.max ? "text-rose" : "text-muted"}>
                        {" "}
                        {g.metric.name}: {fmtMetric(g.metric, g.metric.value)} / {fmtMetric(g.metric, g.metric.max)}
                      </span>
                    )}
                  </span>
                  <GateStatusBadge status={g.status} />
                </li>
              ))}
            </ul>
            {local.sanitized != null && local.sanitized !== text && (
              <pre className="whitespace-pre-wrap break-words border-t border-line p-3 font-mono text-data text-fg/90">
                {local.sanitized}
              </pre>
            )}
          </div>
        )}

        {local && <RemoteResult remote={remote} online={online} />}
      </div>
    </section>
  );
}

function RemoteResult({ remote, online }: { remote: Remote; online: boolean }) {
  const base = "border-t border-line px-3 py-2 font-mono text-micro uppercase leading-relaxed tracking-hud";
  if (!online) return <p className={`${base} text-muted`}>NDAi uplink offline. Only the local engine ran.</p>;
  if (remote.status === "loading") return <p className={`${base} text-muted`}>NDAi /inspect running...</p>;
  if (remote.status === "error") return <p className={`${base} text-rose`}>NDAi /inspect failed: {remote.error}</p>;
  if (remote.status !== "ok") return null;
  const { data } = remote;
  return (
    <div className={`${base} bg-raised`}>
      <p>
        <span className="text-muted">NDAi /inspect</span>{" "}
        <span className={data.action === "block" ? "text-rose" : data.action === "allow" ? "text-emerald" : "text-amber"}>
          {data.action}
        </span>{" "}
        <span className="text-muted">
          rule &ldquo;{data.rule}&rdquo; / {data.destination_class} / +{fmtMs(data.latency_ms)} / not logged
        </span>
      </p>
      <p className="normal-case text-fg/80">{data.message}</p>
    </div>
  );
}
