"""File ingestion: turn a document into text chunks that feed the EXISTING,
unmodified sentence-level detect() pipeline - no changes to detection.py or
provenance.py needed for this.

Row-level for tabular data (csv/xlsx/parquet): each row is serialized into
one sentence-like string and becomes its own chunk. That's what makes
per-row leak detection ("the leak is in row 47") come for free - the row
string just looks like any other prompt sentence to detect().
"""
from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

SUPPORTED = (".txt", ".md", ".pdf", ".csv", ".xlsx", ".parquet")


@dataclass
class Chunk:
    label: str   # "document", "page 3", "row 12", "Sheet1!row 4"
    text: str


def _row_to_sentence(row: "pd.Series") -> str:
    return ", ".join(f"{col}: {val}" for col, val in row.items() if pd.notna(val))


def _extract_pdf(data: bytes) -> list[Chunk]:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    chunks = []
    for i, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").strip()
        if text:
            chunks.append(Chunk(f"page {i}", text))
    return chunks


def _extract_csv(data: bytes) -> list[Chunk]:
    df = pd.read_csv(io.BytesIO(data))
    return [Chunk(f"row {i}", _row_to_sentence(row)) for i, row in df.iterrows()]


def _extract_excel(data: bytes) -> list[Chunk]:
    sheets = pd.read_excel(io.BytesIO(data), sheet_name=None)
    chunks = []
    for sheet_name, df in sheets.items():
        for i, row in df.iterrows():
            chunks.append(Chunk(f"{sheet_name}!row {i}", _row_to_sentence(row)))
    return chunks


def _extract_parquet(data: bytes) -> list[Chunk]:
    df = pd.read_parquet(io.BytesIO(data))
    return [Chunk(f"row {i}", _row_to_sentence(row)) for i, row in df.iterrows()]


def extract(filename: str, data: bytes) -> list[Chunk]:
    """Raises ValueError on an unsupported extension - fail closed, not silent."""
    suffix = Path(filename).suffix.lower()
    if suffix in (".txt", ".md"):
        text = data.decode("utf-8", errors="ignore")
        return [Chunk("document", text)] if text.strip() else []
    if suffix == ".pdf":
        return _extract_pdf(data)
    if suffix == ".csv":
        return _extract_csv(data)
    if suffix == ".xlsx":
        return _extract_excel(data)
    if suffix == ".parquet":
        return _extract_parquet(data)
    raise ValueError(f"Unsupported file type {suffix!r}. Supported: {', '.join(SUPPORTED)}")
