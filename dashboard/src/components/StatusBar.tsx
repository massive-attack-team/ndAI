import { LEDGER_CAP } from "../hooks/useTelemetry";
import { Hazard, Kbd } from "./primitives";

const KEYS: [string, string][] = [
  ["/", "FILTER"],
  ["J/K", "MOVE"],
  ["↵", "INSPECT"],
  ["1-3", "SECTION"],
  ["SPACE", "PAUSE"],
  ["L", "SOURCE"],
  ["ESC", "CLOSE"],
];

export function StatusBar({ rows }: { rows: number }) {
  return (
    <footer className="flex items-center gap-4 font-mono text-micro uppercase tracking-hud text-muted">
      <Hazard className="hidden h-3 w-20 shrink-0 sm:block" />
      <ul className="hidden flex-wrap gap-x-4 gap-y-1 md:flex" aria-label="Keyboard shortcuts">
        {KEYS.map(([key, label]) => (
          <li key={label}>
            <Kbd>{key}</Kbd> {label}
          </li>
        ))}
      </ul>
      <span className="ml-auto whitespace-nowrap">
        Ledger <span className="text-fg tabular-nums">{rows}</span> / {LEDGER_CAP}
      </span>
      <Hazard className="h-3 w-10 shrink-0" />
    </footer>
  );
}
