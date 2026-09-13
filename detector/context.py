"""Stage 2b: what this person and their team have already sent. CONTRACT.md #9.

Detection judges one prompt at a time, so a document that goes out a piece per
prompt never trips it: each piece is too small, or too reworded, to clear
PUBLIC_MARGIN on its own. This module remembers which chunks of which internal
documents already reached each destination class, per person and per team,
and adds a `cumulative` finding when the current prompt completes enough of
one document.

What is stored is a reference into the corpus (doc, chunk, score), who sent it,
where to, and what policy did. Never the prompt text: a history of everything
people typed would be the exact database this product exists not to build.

What this module does not do, on purpose:
- Infer anyone's role or team from what they send. Teams are declared in
  policy.yaml. Inferred roles can be trained by the person being judged.
- Decide what is confidential. The corpus does that. History only adds up
  evidence against documents the corpus already marks as internal.
- Escalate `weak` findings. They carry no document, so there is nothing to
  add up, and history would only compound their false positives.
"""
from __future__ import annotations

import sqlite3
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from . import config, provenance
from .detection import DetectionResult, Evidence, Finding, NearMiss

_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS context_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    event_id INTEGER,
    user TEXT,
    team TEXT,
    destination TEXT,
    destination_class TEXT,
    action TEXT,
    doc TEXT NOT NULL,
    chunk INTEGER NOT NULL,
    type TEXT,
    tier INTEGER,
    basis TEXT,
    score REAL,
    margin REAL,
    escalated INTEGER NOT NULL DEFAULT 0,  -- this send completed a cumulative finding on doc
    sent INTEGER NOT NULL DEFAULT 0        -- this sentence reached the destination unedited
);
CREATE INDEX IF NOT EXISTS idx_context_doc ON context_edges(doc, destination_class, ts);
"""

# Content in a prompt with these outcomes actually reached the destination.
# `block` sends nothing. `sanitize` sends the rewrite: a sentence it edited
# didn't leave, one it left alone did (see record()).
LEFT_ACTIONS = ("allow", "warn")


@dataclass
class Match:
    """One sentence of the current prompt landing on one chunk of an internal doc."""
    doc: str
    chunk: int
    type: str
    tier: int
    basis: str               # verbatim | paraphrase | near_miss
    score: float
    margin: float
    span: tuple[int, int]


@dataclass
class Exposure:
    doc: str
    scope: str               # user | team
    destination_class: str
    chunks_out: int          # distinct chunks out, counting this prompt
    chunk_total: int
    prompts: int             # distinct prompts they came from, counting this one
    new_chunks: int          # chunks this prompt adds
    escalated: bool

    @property
    def coverage(self) -> float:
        return self.chunks_out / self.chunk_total if self.chunk_total else 0.0


@dataclass
class ContextSignal:
    escalations: list[Finding] = field(default_factory=list)
    exposures: list[Exposure] = field(default_factory=list)

    def note(self) -> str:
        """One sentence per escalated document, for the message the user sees."""
        parts = []
        for e in self.exposures:
            if not e.escalated:
                continue
            who = "you" if e.scope == "user" else "your team"
            parts.append(
                f"With this prompt, {e.chunks_out} of {e.chunk_total} sections of {e.doc} "
                f"will have gone from {who} to {e.destination_class.replace('_', ' ')} "
                f"across {e.prompts} prompts."
            )
        return " ".join(parts)


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init() -> None:
    with _lock, _conn() as conn:
        columns = {r["name"] for r in conn.execute("PRAGMA table_info(context_edges)")}
        if columns and "sent" not in columns:
            # Databases from before `sent` existed: every sanitised prompt
            # counted as not sent, which is what they recorded.
            conn.execute("ALTER TABLE context_edges ADD COLUMN sent INTEGER NOT NULL DEFAULT 0")
            conn.execute(
                f"UPDATE context_edges SET sent = 1 WHERE action IN ({','.join('?' * len(LEFT_ACTIONS))})",
                LEFT_ACTIONS,
            )
        conn.executescript(SCHEMA)


def _chunk_totals() -> dict[str, tuple[int, str | None, int | None]]:
    return provenance.get_detector().chunk_totals()


def matches_from(result: DetectionResult, near_misses: list[NearMiss]) -> list[Match]:
    matches = [
        Match(f.evidence.matched_source, f.evidence.matched_chunk, f.type, f.sensitivity,
              f.confidence, f.evidence.score or 0.0, f.evidence.margin or 0.0, tuple(f.span))
        for f in result.findings
        if f.evidence.matched_source and f.evidence.matched_chunk is not None
    ]
    matches += [
        Match(n.doc, n.chunk, n.type, n.sensitivity, "near_miss", n.score, n.margin, tuple(n.span))
        for n in near_misses
    ]
    return matches


def _prior(conn: sqlite3.Connection, *, doc: str, destination_class: str,
           column: str, value: str, since: float) -> tuple[set[int], set[int]]:
    rows = conn.execute(
        f"""SELECT chunk, event_id FROM context_edges
            WHERE doc = ? AND destination_class = ? AND {column} = ? AND ts >= ? AND sent = 1""",
        (doc, destination_class, value, since),
    ).fetchall()
    return {r["chunk"] for r in rows}, {r["event_id"] for r in rows}


def assess(*, user: str, team: str | None, destination_class: str,
           matches: list[Match], now: float | None = None,
           chunk_totals: dict[str, tuple[int, str | None, int | None]] | None = None) -> ContextSignal:
    """Would sending this prompt complete enough of a document to count as a leak?"""
    signal = ContextSignal()
    if destination_class == "private_local" or not matches:
        return signal

    now = time.time() if now is None else now
    since = now - config.CONTEXT_WINDOW_DAYS * 86400
    totals = chunk_totals if chunk_totals is not None else _chunk_totals()

    by_doc: dict[str, list[Match]] = {}
    for m in matches:
        by_doc.setdefault(m.doc, []).append(m)

    scopes = [("user", "user", user)] + ([("team", "team", team)] if team else [])
    with _lock, _conn() as conn:
        for doc, doc_matches in by_doc.items():
            total = totals.get(doc, (0, None, None))[0]
            current = {m.chunk for m in doc_matches}
            for scope, column, value in scopes:
                chunks, events = _prior(conn, doc=doc, destination_class=destination_class,
                                        column=column, value=value, since=since)
                exposure = Exposure(
                    doc=doc, scope=scope, destination_class=destination_class,
                    chunks_out=len(chunks | current), chunk_total=total,
                    prompts=len(events) + 1, new_chunks=len(current - chunks), escalated=False,
                )
                exposure.escalated = bool(
                    total
                    and exposure.new_chunks > 0
                    and exposure.chunks_out >= config.CUMULATIVE_MIN_CHUNKS
                    and exposure.prompts >= config.CUMULATIVE_MIN_PROMPTS
                    and exposure.coverage >= config.CUMULATIVE_COVERAGE
                )
                signal.exposures.append(exposure)
                if exposure.escalated:
                    signal.escalations.extend(_findings(doc_matches, exposure))
                    break   # one scope per doc; user scope wins over team
    return signal


def _findings(doc_matches: list[Match], exposure: Exposure) -> list[Finding]:
    """One cumulative finding per sentence that landed on the document.

    Not just the strongest: the sanitiser edits exactly the spans it is given,
    so a single span would send every other piece of the document in the same
    prompt through untouched.
    """
    by_span: dict[tuple[int, int], Match] = {}
    for m in doc_matches:
        if m.span not in by_span or m.score > by_span[m.span].score:
            by_span[m.span] = m
    return [
        Finding(
            type=m.type,
            sensitivity=m.tier,
            confidence="cumulative",
            span=m.span,
            evidence=Evidence(
                matched_source=exposure.doc,
                score=m.score,
                public_baseline_score=round(m.score - m.margin, 3),
                margin=m.margin,
                excerpt="",
                matched_chunk=m.chunk,
            ),
        )
        for m in sorted(by_span.values(), key=lambda m: m.span)
    ]


def record(*, event_id: int | None, user: str, team: str | None, destination: str,
           destination_class: str, action: str, matches: list[Match],
           signal: ContextSignal | None = None, edited_spans: list[tuple[int, int]] = (),
           now: float | None = None) -> None:
    """`edited_spans`: character ranges of the original prompt the sanitiser
    changed. On `sanitize`, a match outside all of them was sent as typed."""
    if not matches:
        return
    ts = time.time() if now is None else now
    escalated = {f.evidence.matched_source for f in signal.escalations} if signal else set()

    def sent(m: Match) -> bool:
        if action in LEFT_ACTIONS:
            return True
        if action != "sanitize":
            return False
        start, end = m.span
        return not any(start < e_end and e_start < end for e_start, e_end in edited_spans)

    with _lock, _conn() as conn:
        conn.executemany(
            """INSERT INTO context_edges (ts, event_id, user, team, destination,
               destination_class, action, doc, chunk, type, tier, basis, score, margin, escalated, sent)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            [(ts, event_id, user, team, destination, destination_class, action,
              m.doc, m.chunk, m.type, m.tier, m.basis, m.score, m.margin, m.doc in escalated, sent(m))
             for m in matches],
        )


def graph(*, teams: dict[str, list[str]], now: float | None = None,
          chunk_totals: dict[str, tuple[int, str | None, int | None]] | None = None) -> dict[str, Any]:
    """Teams, people, internal documents and destination classes as nodes.

    Edges: team -> person (declared membership), person -> document (what they
    sent that matched it, and how much of it left), document -> destination
    class (how much of the document has reached it, from anyone).
    `near_miss_only` marks edges with no finding behind them, only near
    misses, so the picture never claims more than detection does.
    """
    now = time.time() if now is None else now
    since = now - config.CONTEXT_WINDOW_DAYS * 86400
    totals = chunk_totals if chunk_totals is not None else _chunk_totals()

    with _lock, _conn() as conn:
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM context_edges WHERE ts >= ? ORDER BY ts", (since,)
        ).fetchall()]

    nodes: dict[str, dict[str, Any]] = {}
    edges: dict[tuple[str, str], dict[str, Any]] = {}

    def node(id_: str, **attrs: Any) -> None:
        nodes.setdefault(id_, {"id": id_, **attrs})

    for team, users in teams.items():
        node(f"team:{team}", kind="team", label=team)
        for u in users or []:
            node(f"user:{u.lower()}", kind="user", label=u.lower(), team=team)
            edges[(f"team:{team}", f"user:{u.lower()}")] = {"kind": "member_of"}

    for doc, (total, type_, tier) in sorted(totals.items()):
        if type_:
            node(f"doc:{doc}", kind="doc", label=doc, type=type_, tier=tier, chunk_total=total)

    for r in rows:
        u, d, dest = f"user:{r['user']}", f"doc:{r['doc']}", f"dest:{r['destination_class']}"
        node(u, kind="user", label=r["user"], team=r["team"])
        node(d, kind="doc", label=r["doc"], type=r["type"], tier=r["tier"],
             chunk_total=totals.get(r["doc"], (0,))[0])
        left = bool(r["sent"]) and r["destination_class"] != "private_local"

        e = edges.setdefault((u, d), {"kind": "sent", "events": set(), "chunks_left": set(),
                                      "chunks_held": set(), "escalated": False, "near_miss_only": True})
        e["near_miss_only"] = e["near_miss_only"] and r["basis"] == "near_miss"
        e["events"].add(r["event_id"])
        (e["chunks_left"] if left else e["chunks_held"]).add(r["chunk"])
        e["escalated"] = e["escalated"] or bool(r["escalated"])

        if left:
            node(dest, kind="destination", label=r["destination_class"])
            de = edges.setdefault((d, dest), {"kind": "reached", "chunks": set(), "near_miss_only": True})
            de["chunks"].add(r["chunk"])
            de["near_miss_only"] = de["near_miss_only"] and r["basis"] == "near_miss"

    out_edges = []
    for (src, dst), e in edges.items():
        item = {"source": src, "target": dst, "kind": e["kind"]}
        if e["kind"] == "sent":
            total = nodes[dst].get("chunk_total") or 0
            item.update(prompts=len(e["events"]), chunks_left=len(e["chunks_left"]),
                        chunks_held=len(e["chunks_held"] - e["chunks_left"]),
                        coverage=round(len(e["chunks_left"]) / total, 2) if total else 0.0,
                        escalated=e["escalated"], near_miss_only=e["near_miss_only"])
        elif e["kind"] == "reached":
            total = nodes[src].get("chunk_total") or 0
            item.update(chunks=len(e["chunks"]), near_miss_only=e["near_miss_only"],
                        coverage=round(len(e["chunks"]) / total, 2) if total else 0.0)
        out_edges.append(item)

    return {"nodes": list(nodes.values()), "edges": out_edges,
            "window_days": config.CONTEXT_WINDOW_DAYS}
