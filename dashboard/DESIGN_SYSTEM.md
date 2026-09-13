# NDAi Proxy Console: design system

Dark-only operator console for inspecting intercepted agent turns. The look is
techno-brutalist tactical telemetry: a pitch-black substrate, notched plate frames
and hazard stripes taken from the reference art, monospaced data, and colour kept
for signal.

Tokens live in [src/index.css](src/index.css) under `@theme` (Tailwind v4). Every
token below becomes a utility: `--color-rose` gives `text-rose`, `bg-rose/10`,
`border-rose/60`; `--shadow-glow-cyan` gives `shadow-glow-cyan`.

## Palette

| Token | Value | Use |
| --- | --- | --- |
| `void` | `#06070a` | App background. Not pure black. |
| `panel` | `#0a0c10` | Inside frames. |
| `raised` | `#10131a` | Table heads, pane headers, result strips. |
| `line` | `#1e293b` | Hairlines between rows and cells. |
| `line-strong` | `#334155` | Frame strokes, input borders, section rules. |
| `frame` | `#d6dce5` | Primary plate stroke and hazard stripes, as in the reference. |
| `fg` | `#e6ebf2` | Primary text. |
| `muted` | `#8b95a5` | Labels and metadata. About 6.7:1 on `void`, safe for text. |
| `dim` | `#5b6576` | Decorative only (empty-cell dashes, disabled). Never for content. |
| `cyan` | `#00f0ff` | Interactive accent: focus, selection, agent IDs, primary action. |
| `emerald` | `#00ff9c` | PERMIT, PASSED, healthy uplink. |
| `amber` | `#ffb800` | MUTATED, redactions, PII and drift risk, degraded state. |
| `rose` | `#ff0055` | HALT, FAILED, credential, injection and policy risk. |

Colour rules:

- Signal colours only carry status or severity. On verdicts and gate status, rose means
  stopped. On risk chips it marks the severe classes (credential, injection, policy),
  which can still appear on a PERMIT turn when policy allows the destination, for
  example an internal-corpus match sent to the private local model.
- Cyan is the only colour for "you can act on this" or "this is where you are".
- Tints stay inside `/5` to `/25` for fills. Solid fills are reserved for the active
  source toggle, the active tab (`bg-fg text-void`) and the primary button.

## Glows

`shadow-glow-cyan | emerald | amber | rose` = `0 0 15px` at 14 to 24% alpha. Used on:
the focused filter input, the HALT verdict badge, and the uplink plate. Frames use a
`drop-shadow` on their unclipped wrapper instead, because `clip-path` removes
box-shadows. Nothing else glows.

## Typography

| Role | Face | Setting |
| --- | --- | --- |
| Data, logs, labels | JetBrains Mono Variable | `text-data` 12/20 or `text-micro` 10/16, uppercase, `tracking-hud` (0.08em) for labels |
| Panel titles | Archivo Variable | `text-sm font-extrabold uppercase` |
| Figures and empty-state headlines | Archivo Variable | `font-black`, tracking `-0.02em` to `-0.04em`, leading 0.9 |
| Remediation prose | Archivo Variable | `text-sm leading-relaxed`, sentence case, max 65ch |

Fonts are self-hosted through `@fontsource-variable/*`, so the console renders offline.

Micro-badges are always bracketed uppercase mono: `[PERMIT]`, `[VERDICT_HALT]`,
`TRACK_ID`, `AGENT_ROOT`.

## Geometry

- **Radius is zero everywhere.** No `rounded-*` utilities in the codebase.
- **`Frame`** ([primitives.tsx](src/components/primitives.tsx)) is the notched plate:
  top-left and bottom-right corners cut at `notch` px, 1px or 2px stroke.
  - `frame` tone for the ledger, `line` for secondary bars, verdict tone for the inspector.
- **`Hazard`** is a 45 degree stripe block (4px on, 4px off) that opens every panel header.
- **Grid dividers** use `gap-px` over a `bg-line` parent rather than per-cell borders.
- The connector between ledger and inspector ("TRACE") takes the verdict colour.

## Verdict and risk mapping

| Verdict | Badge | Inspector frame |
| --- | --- | --- |
| `PERMIT` | emerald outline | emerald |
| `MUTATED` | amber outline, amber/5 fill | amber |
| `HALT` | rose outline, rose/10 fill, glow | rose, 2px, glow, ▲▲▲ marker |

| Risk | Chip | Span highlight |
| --- | --- | --- |
| `CREDENTIAL` `CRED` | rose | rose/15 fill, rose underline |
| `INJECTION` `INJ` | rose | same |
| `POLICY` `POL` | rose | same |
| `DRIFT` | amber | amber/15 fill, amber underline |
| `PII` | amber | same |

Gate status: `PASSED` emerald, `FAILED` rose, `BYPASS` dashed neutral.

## Motion

Only two animations are in use, and both carry state:

- `animate-ingest`: a new ledger row flashes cyan once (1.4s), so arrivals are visible in a dense table.
- `animate-blink`: the square in the INGEST control blinks while ingestion is live, and holds still when paused.

Buttons shift 1px down on `:active`. `prefers-reduced-motion` disables all of it.
The scanline overlay is static.

## Keyboard

| Key | Action |
| --- | --- |
| `/` | Focus the filter. `Esc` clears it, a second `Esc` leaves it. |
| `J` `K` or arrow keys | Move the ledger cursor. The inspector follows when open. |
| `Enter` | Open the inspector on the cursor row. |
| `1` `2` `3` | Payload diff, gate pipeline, rationale. Left and right arrows inside the tab list. |
| `Space` | Pause or resume ingestion. Arrivals queue while paused. |
| `L` | Switch between SIM and LIVE. |
| `Esc` | Close the inspector. |
| `Cmd/Ctrl+Enter` | Run the sandbox. |

## Filter syntax

Space-separated terms, all must match. Prefix `-` to negate.

| Term | Matches |
| --- | --- |
| `status:blocked` `halt` / `mutated` `redacted` / `passed` `permit` | Verdict |
| `agent:planner` | Agent name contains, `@` optional |
| `risk:pii` `injection` `drift` `credential` `policy` | Any flag of that risk |
| `upstream:sonnet` | Upstream model or host contains |
| `id:8f3a` | Track ID contains |
| anything else, or `"quoted text"` | Payload or track ID contains |

## Data sources

- **SIM**: the seed payloads in [src/data/seed.ts](src/data/seed.ts), replayed with jitter.
  Verdicts, flags, redactions and gate results come from the local engine in
  [src/engine/gates.ts](src/engine/gates.ts); only the text is authored. Per-gate
  latencies are modeled per tier and labelled as such. The injection boundary and
  drift consensus are lexical stand-ins for the production semantic gates.
- **LIVE**: polls the NDAi detector's `/events` through the Vite `/api` proxy.
  Those rows only carry a redacted preview and one latency per turn, and NDAi has
  no consensus tier, so the inspector says so instead of inventing detail.
- **Sandbox**: always runs the local engine. When the uplink is online it also posts
  to NDAi `/inspect` with `log: false`, against a chosen destination class.
