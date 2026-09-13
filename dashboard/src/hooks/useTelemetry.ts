import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { fetchEvents, fetchHealth, type NdaiHealth } from "../data/ndai";
import { nextTrafficTurn, seedTurns } from "../data/seed";
import { messageOf } from "../lib/format";
import { mulberry32 } from "../lib/rng";
import type { Source, Turn } from "../types";

export const LEDGER_CAP = 400;

export type LiveState = "idle" | "loading" | "ok" | "error";

export type Uplink =
  | { state: "probing" }
  | { state: "online"; health: NdaiHealth }
  | { state: "offline"; error: string };

interface State {
  source: Source;
  turns: Turn[];
  queue: Turn[];
  paused: boolean;
  /** id -> arrival time, for the ingest flash. */
  arrivals: Record<string, number>;
  live: LiveState;
  liveError: string | null;
}

type Action =
  | { type: "ingest"; turns: Turn[] }
  | { type: "snapshot"; turns: Turn[] }
  | { type: "live-error"; error: string }
  | { type: "toggle-pause" }
  | { type: "set-source"; source: Source; turns: Turn[] };

function stamp(arrivals: Record<string, number>, ids: string[], now: number) {
  const next: Record<string, number> = {};
  for (const [id, at] of Object.entries(arrivals)) if (now - at < 2000) next[id] = at;
  for (const id of ids) next[id] = now;
  return next;
}

function reducer(s: State, a: Action): State {
  const now = Date.now();
  switch (a.type) {
    case "ingest":
      if (s.paused) return { ...s, queue: [...a.turns, ...s.queue].slice(0, LEDGER_CAP) };
      return {
        ...s,
        turns: [...a.turns, ...s.turns].slice(0, LEDGER_CAP),
        arrivals: stamp(s.arrivals, a.turns.map((t) => t.id), now),
      };
    case "snapshot": {
      const known = new Set(s.turns.map((t) => t.id));
      const fresh = a.turns.filter((t) => !known.has(t.id));
      if (s.paused) return { ...s, queue: fresh, live: "ok", liveError: null };
      return {
        ...s,
        turns: a.turns,
        queue: [],
        live: "ok",
        liveError: null,
        // The first snapshot is a backfill, not an arrival.
        arrivals: s.live === "ok" ? stamp(s.arrivals, fresh.map((t) => t.id), now) : s.arrivals,
      };
    }
    case "live-error":
      return { ...s, live: "error", liveError: a.error };
    case "toggle-pause":
      if (!s.paused) return { ...s, paused: true };
      return {
        ...s,
        paused: false,
        queue: [],
        turns: [...s.queue, ...s.turns].slice(0, LEDGER_CAP),
        arrivals: stamp(s.arrivals, s.queue.map((t) => t.id), now),
      };
    case "set-source":
      return {
        ...s,
        source: a.source,
        turns: a.turns,
        queue: [],
        paused: false,
        arrivals: {},
        live: a.source === "LIVE" ? "loading" : "idle",
        liveError: null,
      };
  }
}

export function useTelemetry() {
  const rng = useRef(mulberry32(0x5eed)).current;
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    source: "SIM" as Source,
    turns: seedTurns(rng),
    queue: [],
    paused: false,
    arrivals: {},
    live: "idle" as LiveState,
    liveError: null,
  }));
  const [uplink, setUplink] = useState<Uplink>({ state: "probing" });

  // SIM: jittered arrivals so the ledger reads like real traffic, not a metronome.
  useEffect(() => {
    if (state.source !== "SIM") return;
    let timer: number;
    const tick = () => {
      dispatch({ type: "ingest", turns: [nextTrafficTurn(rng)] });
      timer = window.setTimeout(tick, 1600 + rng() * 2400);
    };
    timer = window.setTimeout(tick, 2200);
    return () => window.clearTimeout(timer);
  }, [state.source, rng]);

  // LIVE: poll the NDAi audit log.
  useEffect(() => {
    if (state.source !== "LIVE") return;
    const ctrl = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      try {
        dispatch({ type: "snapshot", turns: await fetchEvents(200, ctrl.signal) });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        dispatch({ type: "live-error", error: messageOf(err) });
      }
      if (!ctrl.signal.aborted) timer = window.setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [state.source]);

  // Uplink probe runs in both modes so SIM still shows whether LIVE is available.
  useEffect(() => {
    const ctrl = new AbortController();
    let timer: number | undefined;
    const probe = async () => {
      try {
        setUplink({ state: "online", health: await fetchHealth(ctrl.signal) });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setUplink({ state: "offline", error: messageOf(err) });
      }
      if (!ctrl.signal.aborted) timer = window.setTimeout(probe, 5000);
    };
    void probe();
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, []);

  const setSource = useCallback(
    (source: Source) => dispatch({ type: "set-source", source, turns: source === "SIM" ? seedTurns(rng) : [] }),
    [rng],
  );
  const togglePause = useCallback(() => dispatch({ type: "toggle-pause" }), []);

  return { ...state, uplink, setSource, togglePause };
}
