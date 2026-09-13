import { useMemo, useState } from "react";

// Layered, not force-directed: teams -> people -> internal documents ->
// destinations always read left to right, so the same graph looks the same on
// every poll and a security lead can follow one path with a finger.
const COLUMNS = [
  { kind: "team", title: "Teams", x: 0 },
  { kind: "user", title: "People", x: 200 },
  { kind: "doc", title: "Internal documents", x: 460 },
  { kind: "destination", title: "Reached", x: 800 },
];
const WIDTH = 960;
const ROW = 46;
const TOP = 40;
const DEST_ORDER = ["public_consumer", "unknown", "enterprise_vetted"];

const shortDoc = (label) => label.split("/").pop().replace(/\.md$/, "");
const human = (s) => String(s ?? "").replace(/_/g, " ");

export default function ContextGraph({ graph }) {
  const [hover, setHover] = useState(null); // node id or edge key
  const layout = useMemo(() => build(graph), [graph]);

  if (!graph) return null;
  const { nodes, edges, byId, height } = layout;
  const sentEdges = edges.filter((e) => e.kind === "sent");

  const active = (e) =>
    !hover || hover === e.key || e.source === hover || e.target === hover;

  return (
    <section className="mt-14 border-t border-rule pt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h2 className="text-sm text-muted">Context graph</h2>
        <Legend />
      </div>
      <p className="mt-2 max-w-[70ch] text-sm">
        Which parts of which internal documents each person and team has sent, over the last{" "}
        {graph.window_days} days. Built from corpus references only: no prompt text is kept.
      </p>

      {sentEdges.length === 0 ? (
        <p className="mt-6 text-sm text-muted">
          Nothing has matched an internal document yet.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <svg
            viewBox={`-10 0 ${WIDTH + 20} ${height}`}
            className="block w-full min-w-[720px]"
            role="img"
            aria-label="Context graph of teams, people, internal documents and destinations"
          >
            {COLUMNS.map((c) => (
              <text key={c.kind} x={c.x} y={14} className="fill-muted text-[11px]">
                {c.title}
              </text>
            ))}

            {edges.map((e) => (
              <Edge
                key={e.key}
                edge={e}
                from={byId[e.source]}
                to={byId[e.target]}
                dim={!active(e)}
                onHover={setHover}
              />
            ))}

            {nodes.map((n) => (
              <Node key={n.id} node={n} dim={hover && !isNeighbour(hover, n.id, edges)} onHover={setHover} />
            ))}
          </svg>
          <Tooltip hover={hover} byId={byId} edges={edges} />
        </div>
      )}

      <ExposureTable nodes={nodes} edges={edges} />
    </section>
  );
}

function build(graph) {
  if (!graph) return { nodes: [], edges: [], byId: {}, height: 0 };
  const edges = graph.edges.map((e) => ({ ...e, key: `${e.source}>${e.target}` }));
  const touched = new Set(edges.filter((e) => e.kind !== "member_of").flatMap((e) => [e.source, e.target]));

  const teamOrder = graph.nodes.filter((n) => n.kind === "team").map((n) => n.label).sort();
  const sorters = {
    team: (a, b) => a.label.localeCompare(b.label),
    user: (a, b) =>
      (teamOrder.indexOf(a.team) + 1 || 99) - (teamOrder.indexOf(b.team) + 1 || 99) ||
      a.label.localeCompare(b.label),
    doc: (a, b) => a.type.localeCompare(b.type) || (b.tier ?? 0) - (a.tier ?? 0) || a.label.localeCompare(b.label),
    destination: (a, b) => DEST_ORDER.indexOf(a.label) - DEST_ORDER.indexOf(b.label),
  };

  const nodes = [];
  let rows = 0;
  for (const col of COLUMNS) {
    const list = graph.nodes.filter((n) => n.kind === col.kind).sort(sorters[col.kind]);
    list.forEach((n, i) => nodes.push({ ...n, x: col.x, y: TOP + i * ROW, touched: touched.has(n.id) }));
    rows = Math.max(rows, list.length);
  }
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));

  // Documents show the most they've reached any outside destination.
  for (const e of edges) {
    if (e.kind === "reached" && byId[e.source]) {
      byId[e.source].reached = Math.max(byId[e.source].reached ?? 0, e.chunks);
    }
  }
  return { nodes, edges: edges.filter((e) => byId[e.source] && byId[e.target]), byId, height: TOP + rows * ROW };
}

function isNeighbour(hover, id, edges) {
  if (hover === id) return true;
  return edges.some(
    (e) => e.key === hover ? e.source === id || e.target === id : (e.source === hover && e.target === id) || (e.target === hover && e.source === id)
  );
}

const LABEL_W = { team: 150, user: 190, doc: 250, destination: 150 };

function Edge({ edge, from, to, dim, onHover }) {
  const x1 = from.x + LABEL_W[from.kind];
  const x2 = to.x - 8;
  const y1 = from.y;
  const y2 = to.y;
  const mid = (x1 + x2) / 2;
  const d = `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;

  let stroke = "var(--color-rule)";
  let width = 1;
  let dash;
  let faint = false; // near misses only: close to the document, never a finding
  if (edge.kind === "sent") {
    if (edge.escalated) {
      stroke = "var(--color-block)";
      width = 2.5;
    } else if (edge.chunks_left > 0) {
      stroke = "var(--color-seal)";
      width = 1.5 + edge.chunks_left;
      faint = edge.near_miss_only;
    } else {
      stroke = "var(--color-muted)";
      width = 1.5;
      dash = "4 4"; // matched, but held on the machine
    }
  } else if (edge.kind === "reached") {
    stroke = "var(--color-seal)";
    width = 1.5 + edge.chunks;
    faint = edge.near_miss_only;
  }

  return (
    <g
      opacity={dim ? 0.12 : 1}
      onMouseEnter={() => onHover(edge.key)}
      onMouseLeave={() => onHover(null)}
      style={{ transition: "opacity 120ms" }}
    >
      <path d={d} fill="none" stroke="transparent" strokeWidth={14} />
      <path d={d} fill="none" stroke={stroke} strokeOpacity={faint ? 0.4 : 1} strokeWidth={width} strokeDasharray={dash} strokeLinecap="round" />
    </g>
  );
}

function Node({ node, dim, onHover }) {
  const muted = !node.touched && node.kind !== "team";
  const label =
    node.kind === "doc" ? shortDoc(node.label) : node.kind === "user" ? node.label.split("@")[0] : human(node.label);
  const sub =
    node.kind === "doc"
      ? `${human(node.type)} · tier ${node.tier}`
      : node.kind === "user"
      ? node.team ?? "no declared team"
      : null;

  return (
    <g
      transform={`translate(${node.x},${node.y})`}
      opacity={dim ? 0.25 : 1}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      style={{ cursor: "default", transition: "opacity 120ms" }}
    >
      <rect x={-8} y={-16} width={LABEL_W[node.kind] + 8} height={34} fill="transparent" />
      <circle cx={-2} cy={0} r={3.5} fill={muted ? "var(--color-rule)" : "var(--color-ink)"} />
      <text x={8} y={-1} className={`text-[12px] ${muted ? "fill-muted" : "fill-ink"}`}>
        {label}
      </text>
      {sub && (
        <text x={8} y={13} className="fill-muted text-[10px]">
          {sub}
        </text>
      )}
      {node.kind === "doc" && node.chunk_total > 0 && (
        <Coverage x={LABEL_W.doc - 64} reached={node.reached ?? 0} total={node.chunk_total} />
      )}
    </g>
  );
}

// One cell per section of the document; filled cells have reached an outside destination.
function Coverage({ x, reached, total }) {
  const cell = Math.min(8, 56 / total);
  return (
    <g transform={`translate(${x},-5)`}>
      {Array.from({ length: total }, (_, i) => (
        <rect
          key={i}
          x={i * cell}
          y={0}
          width={cell - 2}
          height={8}
          rx={1.5}
          fill={i < reached ? "var(--color-seal)" : "var(--color-rule)"}
        />
      ))}
    </g>
  );
}

function Tooltip({ hover, byId, edges }) {
  if (!hover) return <p className="mt-2 min-h-5 text-xs text-muted">Hover a person, document or line for detail.</p>;
  const edge = edges.find((e) => e.key === hover);
  let text;
  if (edge?.kind === "sent") {
    const who = byId[edge.source].label.split("@")[0];
    const doc = byId[edge.target];
    text = `${who} → ${shortDoc(doc.label)}: ${edge.chunks_left} of ${doc.chunk_total} sections sent, ${edge.chunks_held} held on the machine, across ${edge.prompts} prompt${edge.prompts === 1 ? "" : "s"}${edge.near_miss_only ? ", near matches only" : ""}${edge.escalated ? ". Stopped a prompt that pieced it together." : "."}`;
  } else if (edge?.kind === "reached") {
    const doc = byId[edge.source];
    text = `${shortDoc(doc.label)} → ${human(byId[edge.target].label)}: ${edge.chunks} of ${doc.chunk_total} sections, from anyone${edge.near_miss_only ? ", near matches only" : ""}.`;
  } else if (edge?.kind === "member_of") {
    text = `${byId[edge.target].label} is declared in ${byId[edge.source].label} (policy.yaml).`;
  } else if (byId[hover]) {
    const n = byId[hover];
    const count = edges.filter((e) => e.kind === "sent" && (e.source === hover || e.target === hover)).length;
    text =
      n.kind === "doc"
        ? `${n.label}, ${human(n.type)} tier ${n.tier}, ${n.chunk_total} sections. Matched by ${count} ${count === 1 ? "person" : "people"}.`
        : n.kind === "user"
        ? `${n.label}, ${n.team ?? "no declared team"}. Matched ${count} internal document${count === 1 ? "" : "s"}.`
        : human(n.label);
  }
  return <p className="mt-2 min-h-5 text-xs">{text}</p>;
}

function Legend() {
  const item = (label, stroke, dash, width = 2, opacity = 1) => (
    <span className="flex items-center gap-2">
      <svg width="28" height="8" aria-hidden="true">
        <line x1="1" y1="4" x2="27" y2="4" stroke={stroke} strokeOpacity={opacity} strokeWidth={width} strokeDasharray={dash} strokeLinecap="round" />
      </svg>
      {label}
    </span>
  );
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
      {item("Sent", "var(--color-seal)")}
      {item("Sent, near match only", "var(--color-seal)", undefined, 2, 0.4)}
      {item("Matched, held on machine", "var(--color-muted)", "4 4")}
      {item("Pieced together, stopped", "var(--color-block)", undefined, 2.5)}
    </div>
  );
}

// The same facts as the picture, for anyone who can't or won't read the picture.
function ExposureTable({ nodes, edges }) {
  const docs = nodes.filter((n) => n.kind === "doc" && n.touched);
  if (!docs.length) return null;
  const reached = (doc, dest) => edges.find((e) => e.source === doc.id && e.target === `dest:${dest}`)?.chunks ?? 0;
  const people = (doc) =>
    edges
      .filter((e) => e.kind === "sent" && e.target === doc.id)
      .map((e) => e.source.replace(/^user:/, "").split("@")[0])
      .join(", ");
  const dests = DEST_ORDER.filter((d) => nodes.some((n) => n.id === `dest:${d}`));

  return (
    <details className="mt-6">
      <summary className="cursor-pointer text-sm text-muted">Table view</summary>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted">
            <tr className="border-b border-rule">
              <th className="py-2 pr-4 font-normal">Document</th>
              <th className="py-2 pr-4 font-normal">Tier</th>
              {dests.map((d) => (
                <th key={d} className="py-2 pr-4 font-normal">
                  Sections reached {human(d)}
                </th>
              ))}
              <th className="py-2 font-normal">Matched by</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((doc) => (
              <tr key={doc.id} className="border-b border-rule">
                <td className="py-2 pr-4 font-mono text-xs">{doc.label}</td>
                <td className="py-2 pr-4">{doc.tier}</td>
                {dests.map((d) => (
                  <td key={d} className="py-2 pr-4 font-mono text-xs">
                    {reached(doc, d)} of {doc.chunk_total}
                  </td>
                ))}
                <td className="py-2">{people(doc)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
