import { useCallback, useMemo, useRef, useState } from "react";
import { CommandBar } from "./components/CommandBar";
import { Connector } from "./components/Connector";
import { Inspector, TABS, type InspectorTab } from "./components/Inspector";
import { Ledger } from "./components/Ledger";
import { StatusBar } from "./components/StatusBar";
import { TopBar, type LedgerStats } from "./components/TopBar";
import { isTyping, useHotkeys } from "./hooks/useHotkeys";
import { useTelemetry } from "./hooks/useTelemetry";
import { percentile } from "./lib/format";
import { parseQuery } from "./lib/query";
import type { Source, Turn } from "./types";

export default function App() {
  const tel = useTelemetry();
  const { setSource, togglePause } = tel;

  const [query, setQuery] = useState("");
  // The inspected turn is pinned by value so it survives eviction from the ledger cap or a live refresh.
  const [selected, setSelected] = useState<Turn | null>(null);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<InspectorTab>("diff");
  const searchRef = useRef<HTMLInputElement>(null);

  const parsed = useMemo(() => parseQuery(query), [query]);
  const visible = useMemo(() => tel.turns.filter(parsed.test), [tel.turns, parsed]);

  const stats = useMemo<LedgerStats>(() => {
    const overhead = tel.turns.map((t) => t.overheadMs);
    return {
      total: tel.turns.length,
      halt: tel.turns.filter((t) => t.verdict === "HALT").length,
      mutated: tel.turns.filter((t) => t.verdict === "MUTATED").length,
      p50: percentile(overhead, 50),
      p95: percentile(overhead, 95),
    };
  }, [tel.turns]);

  const openTurn = useCallback((turn: Turn) => {
    setSelected(turn);
    setOpen(true);
  }, []);

  const switchSource = useCallback(
    (source: Source) => {
      setSource(source);
      setSelected(null);
      setOpen(false);
    },
    [setSource],
  );

  const move = (delta: number) => {
    if (!visible.length) return;
    const i = selected ? visible.findIndex((t) => t.id === selected.id) : -1;
    setSelected(i === -1 ? visible[0]! : visible[Math.min(visible.length - 1, Math.max(0, i + delta))]!);
  };

  useHotkeys((e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping(e.target)) {
      if (e.key === "Escape" && e.target === searchRef.current) {
        if (query) setQuery("");
        else searchRef.current?.blur();
      }
      return;
    }
    // Let focused buttons handle their own activation keys.
    if ((e.key === "Enter" || e.key === " ") && e.target instanceof HTMLButtonElement) return;

    switch (e.key) {
      case "/":
        e.preventDefault();
        searchRef.current?.focus();
        break;
      case "j":
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "k":
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Enter":
        if (selected) setOpen(true);
        break;
      case "Escape":
        setOpen(false);
        break;
      case "1":
      case "2":
      case "3":
        if (open) setTab(TABS[Number(e.key) - 1]!.id);
        break;
      case " ":
        e.preventDefault();
        togglePause();
        break;
      case "l":
      case "L":
        switchSource(tel.source === "SIM" ? "LIVE" : "SIM");
        break;
    }
  });

  const inspecting = open && selected;

  return (
    <div className="grid h-[100dvh] grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-2 bg-void p-2 text-fg sm:p-3">
      <TopBar
        stats={stats}
        source={tel.source}
        uplink={tel.uplink}
        paused={tel.paused}
        queued={tel.queue.length}
        onSource={switchSource}
        onTogglePause={togglePause}
      />

      <CommandBar
        ref={searchRef}
        value={query}
        onChange={setQuery}
        errors={parsed.errors}
        matched={visible.length}
        total={tel.turns.length}
      />

      <main
        className={`grid min-h-0 grid-rows-[minmax(0,1fr)] ${
          inspecting ? "lg:grid-cols-[minmax(0,0.9fr)_2.25rem_minmax(0,1.1fr)]" : "grid-cols-1"
        }`}
      >
        <Ledger
          turns={visible}
          totalTurns={tel.turns.length}
          selectedId={selected?.id ?? null}
          compact={Boolean(inspecting)}
          arrivals={tel.arrivals}
          source={tel.source}
          live={tel.live}
          liveError={tel.liveError}
          filtered={query.trim().length > 0 && tel.turns.length > 0}
          onOpen={openTurn}
          onCursor={setSelected}
          onClearFilter={() => setQuery("")}
        />
        {inspecting && (
          <>
            <Connector verdict={selected.verdict} />
            <Inspector turn={selected} tab={tab} uplink={tel.uplink} onTab={setTab} onClose={() => setOpen(false)} />
          </>
        )}
      </main>

      <StatusBar rows={tel.turns.length} />
    </div>
  );
}
