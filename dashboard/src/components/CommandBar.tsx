import { forwardRef } from "react";
import { Frame, Kbd } from "./primitives";

const PRESETS = ["status:blocked", "status:mutated", "agent:planner", "risk:injection", "risk:pii", "-status:passed"];

interface CommandBarProps {
  value: string;
  onChange: (value: string) => void;
  errors: string[];
  matched: number;
  total: number;
}

export const CommandBar = forwardRef<HTMLInputElement, CommandBarProps>(function CommandBar(
  { value, onChange, errors, matched, total },
  ref,
) {
  const toggle = (token: string) => {
    const parts = value.split(/\s+/).filter(Boolean);
    onChange((parts.includes(token) ? parts.filter((p) => p !== token) : [...parts, token]).join(" "));
  };
  const active = new Set(value.split(/\s+/));

  return (
    <Frame tone="line" notch={8} innerClassName="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
      <label htmlFor="turn-filter" className="font-sans text-xs font-extrabold uppercase tracking-[0.06em]">
        Filter
      </label>
      <div className="flex min-w-[14rem] flex-1 items-center gap-2 border border-line-strong bg-void px-2 focus-within:border-cyan focus-within:shadow-glow-cyan">
        <span aria-hidden className="font-mono text-data text-cyan">
          $
        </span>
        <input
          ref={ref}
          id="turn-filter"
          role="searchbox"
          type="text"
          spellCheck={false}
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="try status:blocked agent:planner"
          aria-describedby="filter-presets"
          aria-invalid={errors.length > 0}
          className="h-8 min-w-0 flex-1 bg-transparent font-mono text-data text-fg outline-none placeholder:text-muted/60 placeholder:italic"
        />
        <Kbd>/</Kbd>
      </div>
      <div id="filter-presets" className="flex flex-wrap gap-1.5" aria-label="Filter presets">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={active.has(p)}
            onClick={() => toggle(p)}
            className={`border px-1.5 py-0.5 font-mono text-micro uppercase active:translate-y-px ${
              active.has(p) ? "border-cyan bg-cyan/10 text-cyan" : "border-line text-muted hover:border-cyan/60 hover:text-fg"
            }`}
          >
            {p}
          </button>
        ))}
      </div>
      <output className="ml-auto font-mono text-micro uppercase tracking-hud text-muted">
        <span className="text-fg tabular-nums">{matched}</span> / {total} MATCH
      </output>
      {errors.length > 0 && (
        <p role="alert" className="basis-full font-mono text-micro uppercase tracking-hud text-rose">
          {errors.join(" / ")}
        </p>
      )}
    </Frame>
  );
});
