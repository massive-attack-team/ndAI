"""Local audit log.

Storing the raw prompt would rebuild the exact exposure the product exists to
prevent: one database holding every confidential thing anyone nearly leaked. So
the log keeps a hash, a redacted preview and the decision. Full text is opt-in
per deployment and off by default.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from typing import Any

from . import config

_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    user TEXT,
    role TEXT,
    destination TEXT,
    destination_class TEXT,
    action TEXT,
    rule TEXT,
    sensitivity INTEGER,
    risk REAL,
    latency_ms REAL,
    chars_total INTEGER,
    chars_withheld INTEGER,
    text_sha256 TEXT,
    preview TEXT,
    findings TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
"""


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init() -> None:
    with _lock, _conn() as conn:
        conn.executescript(SCHEMA)


def redact(text: str, spans: list[tuple[int, int]], limit: int = 240) -> str:
    out = list(text)
    for start, end in spans:
        out[start:end] = "\u2588" * (end - start)
    joined = "".join(out).replace("\n", " ")
    return joined[:limit] + ("\u2026" if len(joined) > limit else "")


def record(event: dict[str, Any]) -> int:
    with _lock, _conn() as conn:
        cur = conn.execute(
            """INSERT INTO events (ts, user, role, destination, destination_class, action,
               rule, sensitivity, risk, latency_ms, chars_total, chars_withheld,
               text_sha256, preview, findings)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                event.get("ts", time.time()), event.get("user"), event.get("role"),
                event.get("destination"), event.get("destination_class"), event.get("action"),
                event.get("rule"), event.get("sensitivity"), event.get("risk"),
                event.get("latency_ms"), event.get("chars_total"), event.get("chars_withheld"),
                event.get("text_sha256"), event.get("preview"),
                json.dumps(event.get("findings", [])),
            ),
        )
        return cur.lastrowid


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def recent(limit: int = 100) -> list[dict[str, Any]]:
    with _lock, _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["findings"] = json.loads(d["findings"] or "[]")
        out.append(d)
    return out


def stats() -> dict[str, Any]:
    with _lock, _conn() as conn:
        row = conn.execute(
            """SELECT COUNT(*) AS n,
                      SUM(CASE WHEN action IN ('block','sanitize') THEN 1 ELSE 0 END) AS intercepted,
                      SUM(chars_total) AS chars_total,
                      SUM(chars_withheld) AS chars_withheld,
                      AVG(latency_ms) AS avg_latency
               FROM events"""
        ).fetchone()
        by_action = conn.execute(
            "SELECT action, COUNT(*) AS n FROM events GROUP BY action"
        ).fetchall()
    total = row["chars_total"] or 0
    withheld = row["chars_withheld"] or 0
    return {
        "events": row["n"] or 0,
        "intercepted": row["intercepted"] or 0,
        "chars_total": total,
        "chars_withheld": withheld,
        "withheld_pct": round(100 * withheld / total, 1) if total else 0.0,
        "avg_latency_ms": round(row["avg_latency"] or 0, 1),
        "by_action": {r["action"]: r["n"] for r in by_action},
    }
