import { useEffect, useMemo, useState } from "react";
import ContextGraph from "./ContextGraph.jsx";

const VERDICT = {
  allow: { label: "Allowed", color: "var(--color-allow)" },
  warn: { label: "Warned", color: "var(--color-warn)" },
  sanitize: { label: "Rewritten", color: "var(--color-warn)" },
  block: { label: "Blocked", color: "var(--color-block)" },
};

const api = (path) =>
  fetch(`/api${path}`).then((r) => {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  });

export default function App() {
  const [events, setEvents] = useState([]);
  const [stats, setStats] = useState(null);
  const [health, setHealth] = useState(undefined);
  const [selectedId, setSelectedId] = useState(null);
  const [graph, setGraph] = useState(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const [e, s, h] = await Promise.all([api("/events?limit=60"), api("/stats"), api("/health")]);
        if (!alive) return;
        setEvents(e);
        setStats(s);
        setHealth(h);
      } catch {
        if (alive) setHealth(null);
      }
      // Separate so an older service without /graph still shows everything else.
      api("/graph")
        .then((g) => alive && setGraph(g))
        .catch(() => alive && setGraph(null));
    };
    poll();
    const t = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const selected = useMemo(
    () => events.find((e) => e.id === selectedId) ?? events[0] ?? null,
    [events, selectedId]
  );

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <Header stats={stats} health={health} />
      <div className="mt-10 grid gap-10 lg:grid-cols-[1.1fr_1fr]">
        <Stream events={events} selected={selected} onSelect={setSelectedId} />
        <Detail event={selected} />
      </div>
      <ContextGraph graph={graph} />
    </div>
  );
}

function Header({ stats, health }) {
  const pct = stats?.withheld_pct ?? 0;
  return (
    <header>
      <div className="flex items-baseline justify-between gap-6">
        <h1 className="text-xl font-semibold">ndAI</h1>
        <ServiceState health={health} />
      </div>

      <div className="mt-8 flex flex-wrap items-end gap-x-14 gap-y-6">
        <div>
          <div className="font-mono text-6xl leading-none tracking-tight">
            {pct.toFixed(1)}
            <span className="text-2xl text-muted">%</span>
          </div>
          <p className="mt-2 max-w-[34ch] text-sm text-muted">
            of the text people tried to send was kept on their machine
          </p>
        </div>
        <Figure value={stats?.events ?? 0} label="prompts checked" />
        <Figure value={stats?.intercepted ?? 0} label="stopped or rewritten" />
        <Figure value={`${stats?.avg_latency_ms ?? 0} ms`} label="average check" />
      </div>
    </header>
  );
}

function Figure({ value, label }) {
  return (
    <div>
      <div className="font-mono text-2xl">{value}</div>
      <div className="text-sm text-muted">{label}</div>
    </div>
  );
}

function ServiceState({ health }) {
  if (health === undefined) return <span className="text-sm text-muted">Connecting</span>;
  if (health === null)
    return <span className="text-sm text-block">Local service not reachable</span>;
  if (!health.semantic)
    return <span className="text-sm text-warn">Fallback model, paraphrase detection off</span>;
  return <span className="text-sm text-muted">Checking on this machine</span>;
}

function Stream({ events, selected, onSelect }) {
  if (!events.length)
    return (
      <section>
        <h2 className="text-sm text-muted">Activity</h2>
        <p className="mt-6 max-w-[48ch] text-sm">
          Nothing checked yet. Paste something into an AI assistant with the extension
          installed, or post to <code className="font-mono">/inspect</code> directly.
        </p>
      </section>
    );

  return (
    <section>
      <h2 className="text-sm text-muted">Activity</h2>
      <ul className="mt-4">
        {events.map((e) => {
          const v = VERDICT[e.action] ?? { label: e.action, color: "var(--color-muted)" };
          const active = selected?.id === e.id;
          return (
            <li key={e.id}>
              <button
                onClick={() => onSelect(e.id)}
                style={{ borderLeftColor: v.color }}
                className={`w-full border-b border-l-2 border-b-rule px-4 py-3 text-left ${
                  active ? "bg-card" : ""
                } focus-visible:outline-2 focus-visible:outline-seal`}
              >
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-sm font-medium">{v.label}</span>
                  <span className="font-mono text-xs text-muted">{e.destination}</span>
                </div>
                <p className="mt-1 line-clamp-2 font-mono text-xs leading-relaxed text-muted">
                  {e.preview}
                </p>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Detail({ event }) {
  if (!event) return null;
  const prov = event.findings?.find((f) => f.kind === "provenance");
  const secrets = event.findings?.filter((f) => f.kind === "secret") ?? [];
  const cat = event.findings?.find((f) => f.kind === "category");
  const ctx = event.findings?.find((f) => f.kind === "context");

  return (
    <section className="lg:sticky lg:top-10 lg:self-start">
      <h2 className="text-sm text-muted">What the three checks saw</h2>

      <dl className="mt-4 border-t border-rule">
        <Compare
          term="Pattern scanner"
          detail={secrets.length ? `${secrets[0].label} found` : "No match"}
          weak={!secrets.length}
        />
        <Compare
          term="Generic classifier"
          detail={cat ? `Reads as ${cat.label.replace(/_/g, " ")}` : "No match"}
          weak={!cat}
        />
        <Compare
          term="ndAI"
          detail={
            ctx
              ? `${ctx.chunks_out} of ${ctx.chunk_total} sections of ${ctx.label} sent over ${ctx.prompts} prompts`
              : prov
              ? `${Math.round(prov.score * 100)}% match to ${prov.label}, ${Math.round(
                  prov.public_score * 100
                )}% to public sources`
              : secrets.length
              ? "Credential found"
              : "No internal provenance"
          }
          weak={!prov && !ctx && !secrets.length}
        />
      </dl>

      {ctx && (
        <p className="mt-4 max-w-[52ch] border-l-2 border-block bg-card px-4 py-3 text-sm">
          No single prompt was enough. Together with what{" "}
          {ctx.scope === "team" ? "their team" : "this person"} already sent, this one would have put{" "}
          {ctx.chunks_out} of {ctx.chunk_total} sections of{" "}
          <span className="font-mono text-xs">{ctx.label}</span> outside the company.
        </p>
      )}

      {prov && (
        <div className="mt-6">
          <h3 className="text-sm text-muted">Closest internal passage</h3>
          <blockquote className="mt-2 border-l-2 border-seal bg-card px-4 py-3 font-mono text-xs leading-relaxed">
            {prov.excerpt}
          </blockquote>
          <p className="mt-2 max-w-[52ch] text-xs text-muted">
            Margin over the best public match is {Math.round(prov.margin * 100)} points, which is
            what separates our material from the same subject written publicly.
          </p>
        </div>
      )}

      <div className="mt-6 border-t border-rule pt-4 text-sm">
        <p>
          Policy rule <span className="font-mono">{event.rule}</span> decided this.
        </p>
        <p className="mt-1 text-muted">
          {event.chars_withheld > 0
            ? `${event.chars_withheld} of ${event.chars_total} characters never left the machine.`
            : `All ${event.chars_total} characters were sent.`}
        </p>
      </div>
    </section>
  );
}

function Compare({ term, detail, weak }) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b border-rule py-3">
      <dt className="text-sm">{term}</dt>
      <dd className={`text-right text-sm ${weak ? "text-muted" : "font-medium"}`}>{detail}</dd>
    </div>
  );
}
